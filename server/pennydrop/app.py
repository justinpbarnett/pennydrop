from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict
from typing import Any

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.gzip import GZipMiddleware

from .asks import AskRequest, FromStep
from .intake import IntakeError
from .mint import minted_labs_router
from .mint.paths import MintPaths
from .practice.progress import CourseProgress, course_progress
from .practice.records import RuleReview
from .services import Services
from .system_lines import SYSTEM_LINES
from .tts import MEDIA_PREFIX, TtsError


class SpeechRequest(BaseModel):
    text: str
    provider: str | None = None
    voice: str | None = None


class AskFields(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    text: str | None = None
    profile_id: int | None = None
    from_step: FromStep | None = Field(default=None, alias="from")
    bench: bool = False


class AnswerSubmission(BaseModel):
    profile_id: int
    lesson_id: str
    step: int
    prompt: dict[str, Any]
    answer: Any
    correct: bool


class PracticeSubmission(BaseModel):
    profile_id: int
    case_id: int
    answer: Any
    correct: bool | None = None


class CaseRequest(BaseModel):
    profile_id: int


def _lesson_title(services: Services, lesson_id: str) -> str | None:
    try:
        return services.library.raw(lesson_id).header.get("title") or None
    except LookupError:
        return None


def _review_payload(services: Services, review: RuleReview) -> dict[str, Any]:
    return {
        "rule_id": review.rule.id, "rule": review.rule.statement, "condition": review.rule.condition,
        "lesson_id": review.rule.lesson_id, "lesson_title": _lesson_title(services, review.rule.lesson_id),
        "form": review.next_form.value, "direction": review.next_direction.value,
        "passed": [form.value for form in review.passed], "held": review.held,
        "schedule": asdict(review.schedule), "due": review.due.isoformat(timespec="seconds"),
    }


def _course_payload(services: Services, progress: CourseProgress) -> dict[str, Any]:
    return {
        **asdict(progress.course),
        "topics": [
            {**asdict(item.topic), "rules": [{"rule_id": item.rule.id, "rule": item.rule.statement, "condition": item.rule.condition, "held": item.held}] if item.rule else []}
            for item in progress.topics
        ],
        "rules_held": progress.rules_held,
        "rules_total": progress.rules_total,
        "links": [{"lesson_id": link.lesson_id, "title": _lesson_title(services, link.lesson_id), "rules": list(link.rule_ids)} for link in progress.links],
    }


def create_app(services: Services) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        services.store.fail_orphaned_lessons()
        warming = [asyncio.create_task(asyncio.to_thread(services.speaker.warm)), asyncio.create_task(services.transcriber.warm())]
        yield
        await services.transcriber.close()
        for task in warming:
            task.cancel()
        await asyncio.gather(*warming, return_exceptions=True)
        await services.asks.close()
        services.store.fail_orphaned_lessons()

    app = FastAPI(title="Pennydrop", lifespan=lifespan)
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.include_router(minted_labs_router(MintPaths.of(services.settings)))

    @app.exception_handler(LookupError)
    async def not_found(_: Request, error: LookupError):
        return JSONResponse({"error": str(error)}, status_code=404)

    @app.exception_handler(TtsError)
    @app.exception_handler(IntakeError)
    async def unavailable(_: Request, error: Exception):
        return JSONResponse({"error": str(error)}, status_code=502)

    @app.get("/api/lessons")
    async def list_lessons(profile: int | None = None):
        return services.library.summaries(profile)

    @app.get("/api/lessons/{lesson_id}")
    async def get_lesson(lesson_id: str):
        document = await services.library.document(lesson_id)
        return {"id": document.id, "lesson": document.lesson, "steps": document.steps, "done": document.done, "error": document.error, "practice": document.practice}

    @app.get("/api/lessons/{lesson_id}/events")
    async def lesson_events(lesson_id: str):
        return StreamingResponse(_server_sent(services.asks.events(lesson_id)), media_type="text/event-stream")

    @app.post("/api/asks")
    async def create_ask(request: Request):
        received_at = time.monotonic()
        fields, audio = await _read_ask(request)
        transcription_seconds = None
        text = fields.text
        if audio is not None:
            transcribing = time.monotonic()
            text = await services.transcriber.transcribe(audio)
            transcription_seconds = time.monotonic() - transcribing
        if not text or not text.strip():
            raise HTTPException(422, "an Ask needs `text`, or an `audio` file that holds speech")
        lesson_id = await services.asks.start(AskRequest(text.strip(), fields.profile_id, fields.from_step, received_at, transcription_seconds, fields.bench))
        if fields.profile_id is not None:
            services.store.log_ask(fields.profile_id, lesson_id, text.strip())
        return {"lesson_id": lesson_id, "transcript": text.strip()}

    @app.post("/api/tts")
    async def speak(body: SpeechRequest):
        voice = await services.speaker.voice(body.text, provider=body.provider, voice=body.voice)
        return {**voice.for_player(), "cache_hit": voice.cache_hit}

    @app.get("/api/system-lines/{name}")
    async def system_line(name: str):
        if name not in SYSTEM_LINES:
            raise LookupError(f"no system line '{name}', known lines: {', '.join(SYSTEM_LINES)}")
        voice = await services.speaker.voice(SYSTEM_LINES[name])
        return voice.for_player()

    @app.post("/api/transcribe")
    async def transcribe(audio: UploadFile):
        return {"text": await services.transcriber.transcribe(await audio.read())}

    @app.post("/api/answers")
    async def submit_answer(body: AnswerSubmission):
        services.store.log_challenge_answer(body.profile_id, body.lesson_id, body.step, body.answer, body.correct)
        review = services.queue.enroll(body.profile_id, body.lesson_id)
        return {"recorded": True, "review": _review_payload(services, review) if review else None}

    @app.post("/api/practice/answers")
    async def submit_practice_answer(body: PracticeSubmission):
        case = services.store.practice_case(body.case_id)
        profile = services.store.profile(body.profile_id)
        if case.is_graded_by_model:
            grade = await services.grader.grade(services.store.rule(case.rule_id), case, str(body.answer), profile)
            correct, feedback = grade.correct, grade.feedback
        elif body.correct is None:
            raise HTTPException(422, "a Practice answer to a Challenge that is not in words needs `correct`")
        else:
            correct, feedback = body.correct, ""
        review = services.queue.answer(profile.id, case, body.answer, correct, feedback)
        return {"correct": correct, "feedback": feedback, "review": _review_payload(services, review)}

    @app.get("/api/review")
    async def due_reviews(profile_id: int):
        return [_review_payload(services, review) for review in services.queue.due(profile_id)]

    @app.get("/api/review/queue")
    async def review_queue(profile_id: int):
        return [_review_payload(services, review) for review in services.queue.queue(profile_id)]

    @app.post("/api/review/{rule_id}/case")
    async def review_case(rule_id: int, body: CaseRequest):
        case = await services.queue.next_case(body.profile_id, rule_id, services.asks.practice)
        return {**case.item, "step": 1, "case_id": case.id}

    @app.get("/api/practice/rates")
    async def practice_rates(profile_id: int | None = None):
        return [
            {"rule_id": rate.rule_id, "rule": rate.rule, "form": rate.form.value, "answered": rate.answered, "passed": rate.passed, "rate": round(rate.rate, 3)}
            for rate in services.store.practice_rates(profile_id)
        ]

    @app.get("/api/courses")
    async def list_courses(profile_id: int | None = None):
        return [_course_payload(services, course_progress(services.store, course, profile_id)) for course in services.store.courses()]

    @app.get("/api/courses/{reference}")
    async def get_course(reference: str, profile_id: int | None = None):
        return _course_payload(services, course_progress(services.store, services.store.course(reference), profile_id))

    @app.get("/api/profiles")
    async def list_profiles():
        return [asdict(profile) for profile in services.store.profiles()]

    @app.get("/api/profiles/{profile_id}/log")
    async def profile_log(profile_id: int):
        log = services.store.profile_log(profile_id)
        for row in (*log["asks"], *log["lessons"], *log["answers"]):
            row["lesson_title"] = _lesson_title(services, row["lesson_id"])
        return log

    @app.get("/kids/manifest.webmanifest", include_in_schema=False)
    async def kids_manifest(profile: int | None = None):
        start = "/kids/" if profile is None else f"/kids/?profile={profile}"
        manifest = {
            "name": "Pennydrop",
            "short_name": "Pennydrop",
            "start_url": start,
            "scope": "/kids/",
            "display": "standalone",
            "orientation": "any",
            "background_color": "#FFF4DA",
            "theme_color": "#FFF4DA",
            "icons": [
                {"src": "/kids/icon-192.png", "sizes": "192x192", "type": "image/png"},
                {"src": "/kids/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
                {"src": "/kids/icon.svg", "sizes": "any", "type": "image/svg+xml"},
            ],
        }
        return JSONResponse(manifest, media_type="application/manifest+json")

    services.settings.tts_cache_dir.mkdir(parents=True, exist_ok=True)
    app.mount(MEDIA_PREFIX, StaticFiles(directory=services.settings.tts_cache_dir), name="tts-media")
    services.settings.media_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/media", StaticFiles(directory=services.settings.media_dir), name="media")
    services.settings.films_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/films", StaticFiles(directory=services.settings.films_dir), name="films")
    _mount_player(app, services)
    return app


async def _read_ask(request: Request) -> tuple[AskFields, bytes | None]:
    if not request.headers.get("content-type", "").startswith("multipart/"):
        return AskFields.model_validate(await request.json()), None
    form = await request.form()
    raw = {key: json.loads(value) if key == "from" else value for key, value in form.items() if key != "audio" and value != ""}
    audio = form.get("audio")
    return AskFields.model_validate(raw), (await audio.read() if audio else None)


async def _server_sent(events: AsyncIterator[tuple[str, dict[str, Any]]]) -> AsyncIterator[str]:
    try:
        async for name, data in events:
            yield _event(name, data)
    except Exception as error:  # noqa: BLE001
        yield _event("error", {"message": str(error)})


def _event(name: str, data: dict[str, Any]) -> str:
    return f"event: {name}\ndata: {json.dumps(data)}\n\n"


IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}
REVALIDATE = {"Cache-Control": "no-cache"}


def _mount_player(app: FastAPI, services: Services) -> None:
    dist = services.settings.player_dist
    if not dist.exists():
        return

    @app.get("/{path:path}", include_in_schema=False)
    async def player(path: str):
        if path.startswith(("api/", "media/", "films/")):
            raise HTTPException(404)
        candidate = (dist / path).resolve()
        if path and candidate.is_file() and dist.resolve() in candidate.parents:
            hashed = candidate.parent == (dist / "assets").resolve()
            return FileResponse(candidate, headers=IMMUTABLE if hashed else REVALIDATE)
        return FileResponse(dist / ("kids.html" if path.rstrip("/") == "kids" else "index.html"), headers=REVALIDATE)
