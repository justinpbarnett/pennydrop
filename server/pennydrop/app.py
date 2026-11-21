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

from .asks import AskRequest, FromStep
from .courses import Course
from .intake import IntakeError
from .mint import minted_labs_router
from .mint.paths import MintPaths
from .review import answer_shape
from .services import Services
from .store import ReviewItem
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


class ReviewAnswer(BaseModel):
    answer: Any
    correct: bool


def _lesson_title(services: Services, lesson_id: str) -> str | None:
    try:
        return services.library.raw(lesson_id).header.get("title") or None
    except LookupError:
        return None


def _review_payload(services: Services, item: ReviewItem) -> dict[str, Any]:
    return {
        **asdict(item),
        "lesson_title": _lesson_title(services, item.lesson_id),
        "kind": item.prompt.get("kind"),
        "type": item.prompt.get("type"),
        "answer_shape": answer_shape(item.prompt),
    }


def _course_payload(services: Services, course: Course) -> dict[str, Any]:
    return {**asdict(course), "topics": [asdict(topic) for topic in services.store.course_topics(course.id)]}


def create_app(services: Services) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        services.store.fail_unfinished_lessons()
        warming = [asyncio.create_task(asyncio.to_thread(services.speaker.warm)), asyncio.create_task(services.transcriber.warm())]
        yield
        for task in warming:
            task.cancel()
        await services.asks.close()
        await services.transcriber.close()

    app = FastAPI(title="Pennydrop", lifespan=lifespan)
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
        return {"id": document.id, "lesson": document.lesson, "steps": document.steps, "done": document.done, "error": document.error}

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
        item = services.store.record_answer(body.profile_id, body.lesson_id, body.step, body.prompt, body.answer, body.correct)
        return asdict(item)

    @app.get("/api/review")
    async def due_reviews(profile_id: int | None = None):
        return [_review_payload(services, item) for item in services.store.due_reviews(profile_id)]

    @app.get("/api/review/queue")
    async def review_queue(profile_id: int):
        return [_review_payload(services, item) for item in services.store.review_queue(profile_id)]

    @app.post("/api/review/{item_id}")
    async def review_item(item_id: int, body: ReviewAnswer):
        item = services.store.review_item(item_id)
        return _review_payload(services, services.store.record_answer(item.profile_id, item.lesson_id, item.step_n, item.prompt, body.answer, body.correct))

    @app.get("/api/courses")
    async def list_courses():
        return [_course_payload(services, course) for course in services.store.courses()]

    @app.get("/api/courses/{reference}")
    async def get_course(reference: str):
        return _course_payload(services, services.store.course(reference))

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
    except Exception as error:
        yield _event("error", {"message": str(error)})


def _event(name: str, data: dict[str, Any]) -> str:
    return f"event: {name}\ndata: {json.dumps(data)}\n\n"


def _mount_player(app: FastAPI, services: Services) -> None:
    dist = services.settings.player_dist
    if not dist.exists():
        return

    @app.get("/{path:path}", include_in_schema=False)
    async def player(path: str):
        if path.startswith(("api/", "media/")):
            raise HTTPException(404)
        candidate = (dist / path).resolve()
        if path and candidate.is_file() and dist.resolve() in candidate.parents:
            return FileResponse(candidate)
        if path.rstrip("/") == "kids":
            return FileResponse(dist / "kids.html")
        return FileResponse(dist / "index.html")
