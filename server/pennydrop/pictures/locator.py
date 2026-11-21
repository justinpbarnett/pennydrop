from __future__ import annotations

import asyncio
import io
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image as PILImage

from ..gateway import Gateway, Image
from ..settings import Job
from .index import JsonIndex

GRID = 1000
MIN_SIDE = 0.02
MAX_AREA = 0.85
SYSTEM = "You find named parts of a picture for a children's lesson. You answer with one JSON object and nothing else."
PROMPT = """The picture is shown to a young child. Find each of these parts in it: {names}.
Reply with this JSON and nothing else:
{{"usable": true, "reason": "", "parts": [{{"name": "beak", "box": [left, top, right, bottom]}}]}}
- Each box is the tightest rectangle around that one part only: its edges touch the part's own outer edges, and it leaves out neighbouring parts, the rest of the subject and the background. Never box a group of parts, or the whole subject, as one part. The grid goes from 0 to {grid} across and from 0 to {grid} down over the whole picture.
- Use the part names exactly as given. Leave a part out when it is hidden, cut off or not in the picture.
- When the picture is not a clear, sharp photo that shows the whole subject, answer "usable": false and say in "reason" what is wrong."""
WARM_PROMPT = """The picture is shown to a young child, and it shows: {subject}.
Find the {count} biggest, most recognisable parts of it that a child can name and tap, using the plainest common words, such as eyes, beak, wing, wheel, chimney.
Reply with this JSON and nothing else:
{{"usable": true, "reason": "", "parts": [{{"name": "beak", "box": [left, top, right, bottom]}}]}}
- Each box is the tightest rectangle around that one part only: its edges touch the part's own outer edges, and it leaves out neighbouring parts, the rest of the subject and the background. Never box a group of parts, or the whole subject, as one part. The grid goes from 0 to {grid} across and from 0 to {grid} down over the whole picture.
- Name every part in the singular unless the picture shows a pair or more, such as eyes.
- When the picture is not a clear, sharp photo that shows the whole subject, answer "usable": false and say in "reason" what is wrong."""
WARM_PARTS = 8
CROP_MARGIN = 0.35
CROP_SIDE = 640
KEEP_OVERLAP = 0.75
CHECK_PROMPT = """This crop of a photo is shown to a young child. Look for the {name} of the subject in it.
Reply with this JSON and nothing else:
{{"present": true, "box": [left, top, right, bottom]}}
- "box" is the tightest rectangle around the {name} only, on a grid from 0 to {grid} across and from 0 to {grid} down over this crop: its edges touch the {name}'s own outer edges and it leaves out neighbouring parts and the background.
- Answer "present": false when the {name} is not in the crop."""


class PartsNotFound(LookupError):
    pass


@dataclass(frozen=True)
class LocatedParts:
    found: dict[str, dict[str, float]]
    missing: list[str]


class PartLocator:
    def __init__(self, gateway: Gateway, media_dir: Path):
        self._gateway = gateway
        self._media_dir = media_dir
        self._index = JsonIndex(media_dir / "parts.json")
        self._warming: dict[str, asyncio.Task[None]] = {}
        self._planned: dict[str, tuple[list[str], asyncio.Task[LocatedParts]]] = {}

    def plan(self, file: str, names: list[str], lesson_id: str | None) -> None:
        if file in self._planned and self._planned[file][0] == names:
            return
        task = asyncio.ensure_future(self.locate(file, names, lesson_id))
        task.add_done_callback(lambda done: done.cancelled() or done.exception())
        self._planned[file] = (names, task)

    async def planned(self, file: str) -> LocatedParts | None:
        return await asyncio.shield(self._planned[file][1]) if file in self._planned else None

    def warm(self, picture_file: str, subject: str, lesson_id: str | None) -> None:
        if picture_file in self._warming or self._index.get(picture_file):
            return
        task = asyncio.ensure_future(self._remember(picture_file, WARM_PROMPT.format(subject=subject, count=WARM_PARTS, grid=GRID), None, lesson_id))
        self._warming[picture_file] = task
        task.add_done_callback(lambda done: (self._warming.pop(picture_file, None), done.cancelled() or done.exception()))

    async def locate(self, file: str, names: list[str], lesson_id: str | None) -> LocatedParts:
        known = self._known(file)
        absent = set(self._index.get(f"{file}#absent") or [])
        unknown = [name for name in names if name.lower() not in known and name.lower() not in absent]
        if unknown:
            own = asyncio.ensure_future(self._remember(file, PROMPT.format(names=", ".join(unknown), grid=GRID), set(unknown), lesson_id))
            racers = {own, *([self._warming[file]] if file in self._warming else [])}
            try:
                while own in racers and any(name.lower() not in self._known(file) for name in unknown):
                    done, racers = await asyncio.wait(racers, return_when=asyncio.FIRST_COMPLETED)
                    if own in done:
                        own.result()
            finally:
                own.cancel()
            known = self._known(file)
        found = {name: known[name.lower()] for name in names if name.lower() in known}
        return LocatedParts(found, [name for name in names if name.lower() not in known])

    async def _checked(self, file: str, located: dict[str, dict[str, float]], lesson_id: str | None) -> dict[str, dict[str, float]]:
        photo = PILImage.open(self._media_dir / file)
        photo.load()
        verdicts = await asyncio.gather(*(self._second_look(photo, name, box, lesson_id) for name, box in located.items()), return_exceptions=True)
        return {name: verdict if isinstance(verdict, dict) else located[name] for name, verdict in zip(located, verdicts, strict=True) if verdict is not None}

    async def _second_look(self, photo: PILImage.Image, name: str, box: dict[str, float], lesson_id: str | None) -> dict[str, float] | None:
        width, height = photo.size
        pad_x, pad_y = box["w"] * CROP_MARGIN, box["h"] * CROP_MARGIN
        left, top = max(box["x"] - pad_x, 0.0), max(box["y"] - pad_y, 0.0)
        right, bottom = min(box["x"] + box["w"] + pad_x, 1.0), min(box["y"] + box["h"] + pad_y, 1.0)
        crop = photo.convert("RGB").crop((round(left * width), round(top * height), round(right * width), round(bottom * height)))
        crop.thumbnail((CROP_SIDE, CROP_SIDE))
        data = io.BytesIO()
        crop.save(data, "JPEG", quality=88)
        completion = await self._gateway.complete(
            Job.VISION, CHECK_PROMPT.format(name=name, grid=GRID), system=SYSTEM, images=(Image("image/jpeg", data.getvalue()),), lesson_id=lesson_id, effort="low",
        )
        answer = _json_object(completion.text)
        if answer.get("present") is False:
            return None
        inner = _fractions(answer.get("box"))
        if inner is None:
            return box
        span_x, span_y = right - left, bottom - top
        corrected = {"x": left + inner["x"] * span_x, "y": top + inner["y"] * span_y, "w": inner["w"] * span_x, "h": inner["h"] * span_y}
        return box if _overlap(box, corrected) >= KEEP_OVERLAP else {key: round(value, 4) for key, value in corrected.items()}

    def _known(self, file: str) -> dict[str, dict[str, float]]:
        return self._index.get(file) or {}

    async def _remember(self, file: str, prompt: str, wanted: set[str] | None, lesson_id: str | None) -> None:
        located = await self._checked(file, await self._ask(file, prompt, wanted, lesson_id), lesson_id)
        self._index.put(file, {**(self._index.get(file) or {}), **located})
        if wanted:
            self._index.put(f"{file}#absent", sorted({*(self._index.get(f"{file}#absent") or []), *(wanted - located.keys())}))

    async def _ask(self, file: str, prompt: str, wanted: set[str] | None, lesson_id: str | None) -> dict[str, dict[str, float]]:
        completion = await self._gateway.complete(
            Job.VISION, prompt, system=SYSTEM, images=(Image.from_file(self._media_dir / file),), lesson_id=lesson_id, effort="low",
        )
        answer = _json_object(completion.text)
        if answer.get("usable") is False:
            raise PartsNotFound(str(answer.get("reason") or "it is not a clear photo of the whole subject"))
        located: dict[str, dict[str, float]] = {}
        for part in answer.get("parts") or []:
            name = str(part.get("name", "")).strip().lower()
            box = _fractions(part.get("box"))
            if (wanted is None or name in wanted) and box:
                located[name] = box
        return located


def _overlap(first: dict[str, float], second: dict[str, float]) -> float:
    across = min(first["x"] + first["w"], second["x"] + second["w"]) - max(first["x"], second["x"])
    down = min(first["y"] + first["h"], second["y"] + second["h"]) - max(first["y"], second["y"])
    shared = max(across, 0.0) * max(down, 0.0)
    return shared / (first["w"] * first["h"] + second["w"] * second["h"] - shared)


def _json_object(text: str) -> dict[str, Any]:
    start, end = text.find("{"), text.rfind("}")
    try:
        answer = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return {}
    return answer if isinstance(answer, dict) else {}


def _fractions(raw: Any) -> dict[str, float] | None:
    if not isinstance(raw, list) or len(raw) != 4 or not all(isinstance(value, int | float) for value in raw):
        return None
    left, top, right, bottom = (min(max(value / GRID, 0.0), 1.0) for value in raw)
    width, height = right - left, bottom - top
    if width < MIN_SIDE or height < MIN_SIDE or width * height > MAX_AREA:
        return None
    return {"x": round(left, 4), "y": round(top, 4), "w": round(width, 4), "h": round(height, 4)}
