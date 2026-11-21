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
from pydantic import BaseModel

from .intake import IntakeError
from .lessons import LessonLibrary
from .services import Services
from .tts import MEDIA_PREFIX, TtsError


class SpeechRequest(BaseModel):
    text: str
    provider: str | None = None
    voice: str | None = None


class AnswerSubmission(BaseModel):
    profile_id: int
    lesson_id: str
    step: int
    prompt: dict[str, Any]
    answer: Any
    correct: bool


def create_app(services: Services) -> FastAPI:
    library = LessonLibrary(services.settings, services.store, services.speaker)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        warming = asyncio.create_task(asyncio.to_thread(services.speaker.warm))
        yield
        warming.cancel()

    app = FastAPI(title="Pennydrop", lifespan=lifespan)

    @app.exception_handler(LookupError)
    async def not_found(_: Request, error: LookupError):
        return JSONResponse({"error": str(error)}, status_code=404)

    @app.exception_handler(TtsError)
    @app.exception_handler(IntakeError)
    async def unavailable(_: Request, error: Exception):
        return JSONResponse({"error": str(error)}, status_code=502)

    @app.get("/api/lessons")
    async def list_lessons():
        return library.summaries()

    @app.get("/api/lessons/{lesson_id}")
    async def get_lesson(lesson_id: str):
        document = await library.document(lesson_id)
        return {"id": document.id, "lesson": document.lesson, "steps": document.steps, "done": {"steps": len(document.steps)}}

    @app.get("/api/lessons/{lesson_id}/events")
    async def lesson_events(lesson_id: str):
        header = library.header(lesson_id)
        return StreamingResponse(_lesson_event_stream(library, lesson_id, header), media_type="text/event-stream")

    @app.post("/api/tts")
    async def speak(body: SpeechRequest):
        voice = await services.speaker.voice(body.text, provider=body.provider, voice=body.voice)
        return {**voice.for_player(), "cache_hit": voice.cache_hit}

    @app.post("/api/transcribe")
    async def transcribe(audio: UploadFile):
        return {"text": await services.transcriber.transcribe(await audio.read())}

    @app.post("/api/answers")
    async def submit_answer(body: AnswerSubmission):
        item = services.store.record_answer(body.profile_id, body.lesson_id, body.step, body.prompt, body.answer, body.correct)
        return asdict(item)

    @app.get("/api/review")
    async def due_reviews(profile_id: int | None = None):
        return [asdict(item) for item in services.store.due_reviews(profile_id)]

    @app.get("/api/profiles")
    async def list_profiles():
        return [asdict(profile) for profile in services.store.profiles()]

    services.settings.tts_cache_dir.mkdir(parents=True, exist_ok=True)
    app.mount(MEDIA_PREFIX, StaticFiles(directory=services.settings.tts_cache_dir), name="tts-media")
    _mount_player(app, services)
    return app


async def _lesson_event_stream(library: LessonLibrary, lesson_id: str, header: dict[str, Any]) -> AsyncIterator[str]:
    started = time.monotonic()
    yield _event("lesson", {"id": lesson_id, **header})
    count = 0
    try:
        async for step in library.voiced_steps(lesson_id):
            count += 1
            yield _event("step", step)
    except Exception as error:
        yield _event("error", {"message": str(error)})
        return
    yield _event("done", {"steps": count, "seconds": time.monotonic() - started})


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
        return FileResponse(dist / "index.html")
