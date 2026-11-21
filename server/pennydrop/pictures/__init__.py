from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

import httpx

from ..gateway import Gateway, GatewayError, Image
from ..settings import Job
from .dimensions import ImageShape, image_shape
from .index import JsonIndex
from .locator import LocatedParts, PartLocator, PartsNotFound
from .sources import USER_AGENT, Candidate, looks_like_a_photo, search_all

SHARP_WIDTH = 1600
MIN_WIDTH = 900
MAX_BYTES = 14_000_000
SHORTLIST = 6
OTHER_NAMES_PROMPT = 'Give the two other common English names people use for "{query}" when they look for photos of it, such as "steam locomotive" for "steam train". Answer with only a JSON list of two strings.'
FILE_PREFIX_LENGTH = 16
MIN_ASPECT, MAX_ASPECT = 0.5, 2.2
CROWDED = re.compile(r"\b(group|crowd|flock|herd|pair|couple|dozens|many)\b", re.I)
ARCHIVAL = re.compile(r"\b(1[0-8]\d\d|19[0-6]\d)s?\b|\bca\.? ?\d|archive|archival|historic|negative|glass|vintage|daguerreo|collection|album|scan|nzgr|fsac", re.I)
QUESTION_WORDS = frozenset("what whats does do did is are was a an the show me us see picture pictures photo photos of look looks like looking inside in how can i you tell about please to let my its it s".split())
CHOOSE_SYSTEM = "You choose the best photo for a children's lesson. You answer with one JSON object and nothing else."
CHOOSE_PROMPT = """These {count} photos, numbered from 1 in the order shown, are candidates for a lesson that shows: {query}.
Their widths in pixels: {widths}.
Choose the one photo that shows {query} most clearly: one sharp, real COLOUR photo of the whole subject, large in the frame, with an uncluttered background, not a drawing, diagram, toy, model, crowd, collage or close-up of a detail. A colour photo always beats a black and white, sepia, scanned or archival one, even when the old one is sharper. Reject photos with a scanned plate or film border, and photos where the subject is small in the frame or the scene is cluttered. The {query} itself must be what the photo is about and must fill most of the frame: reject a photo of a person holding it or standing near it, and a photo where it is small or only a background object. Be strict: choosing none is better than choosing a photo of something else. When two are about equally clear, take the wider one.
Reply {{"best": number}}, or {{"best": null}} when none of them shows {query} clearly as the main subject."""

__all__ = ["Credit", "LocatedParts", "PartLocator", "PartsNotFound", "Picture", "PictureFinder", "PictureNotFound", "prefetch", "subject_of"]


class PictureNotFound(LookupError):
    pass


@dataclass(frozen=True)
class Credit:
    title: str
    creator: str
    license: str
    source: str


@dataclass(frozen=True)
class Picture:
    file: str
    w: int
    h: int
    credit: Credit

    @property
    def src(self) -> str:
        return f"/media/{self.file}"


@dataclass(frozen=True)
class Downloaded:
    data: bytes
    shape: ImageShape
    candidate: Candidate


class PictureFinder:
    def __init__(self, media_dir: Path, gateway: Gateway, on_found: Callable[[str, str, str | None], None] | None = None):
        self._media_dir = media_dir
        self._gateway = gateway
        self._on_found = on_found
        self._index = JsonIndex(media_dir / "images.json")
        self._searches: dict[str, asyncio.Task[Picture]] = {}

    def holds(self, src: str) -> bool:
        return src.startswith("/media/") and (self._media_dir / src.removeprefix("/media/")).is_file()

    async def find(self, query: str, attribution_ok: bool, lesson_id: str | None) -> Picture:
        key = f"{'by' if attribution_ok else 'free'}:{' '.join(query.lower().split())}"
        if known := self._remembered(key):
            return known
        search = self._searches.get(key)
        if search is None:
            search = self._searches[key] = asyncio.ensure_future(self._search(key, query, attribution_ok, lesson_id))
            search.add_done_callback(lambda _: self._searches.pop(key, None))
        return await asyncio.shield(search)

    async def _search(self, key: str, query: str, attribution_ok: bool, lesson_id: str | None) -> Picture:
        other_names = asyncio.ensure_future(self._search_other_names(query, attribution_ok, lesson_id))
        candidates = [candidate for candidate in await search_all(query, attribution_ok) if looks_like_a_photo(candidate)]
        if sum(not _archival(candidate) for candidate in candidates) < SHORTLIST:
            seen = {candidate.url for candidate in candidates}
            candidates += [candidate for candidate in await other_names if candidate.url not in seen]
        else:
            other_names.cancel()
        ranked = sorted(candidates, key=lambda candidate: -_score(query, candidate))
        async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT}, timeout=40, follow_redirects=True) as client:
            fetched = await asyncio.gather(*(self._download(client, candidate) for candidate in ranked[:SHORTLIST]))
        usable = [item for item in fetched if item]
        if not usable:
            raise PictureNotFound(query)
        chosen = usable[0] if len(usable) == 1 else await self._choose(query, usable, lesson_id)
        picture = self._save(chosen)
        self._index.put(key, {"file": picture.file, "w": picture.w, "h": picture.h, "credit": asdict(picture.credit)})
        if self._on_found:
            self._on_found(picture.file, query, lesson_id)
        return picture

    async def _search_other_names(self, query: str, attribution_ok: bool, lesson_id: str | None) -> list[Candidate]:
        try:
            completion = await self._gateway.complete(Job.VISION_CHOOSE, OTHER_NAMES_PROMPT.format(query=query), lesson_id=lesson_id, effort="low")
            names = json.loads(completion.text[completion.text.find("["):completion.text.rfind("]") + 1])
            found = await asyncio.gather(*(search_all(name, attribution_ok) for name in names[:2] if isinstance(name, str)))
        except (GatewayError, json.JSONDecodeError, httpx.HTTPError):
            return []
        return [candidate for batch in found for candidate in batch if looks_like_a_photo(candidate)]

    def _remembered(self, key: str) -> Picture | None:
        entry = self._index.get(key)
        if entry and (self._media_dir / entry["file"]).is_file():
            return Picture(entry["file"], entry["w"], entry["h"], Credit(**entry["credit"]))
        return None

    async def _download(self, client: httpx.AsyncClient, candidate: Candidate) -> Downloaded | None:
        try:
            response = await client.get(candidate.url)
            response.raise_for_status()
        except httpx.HTTPError:
            return None
        data = response.content
        shape = image_shape(data)
        if shape is None or len(data) > MAX_BYTES or shape.width < MIN_WIDTH or not MIN_ASPECT <= shape.width / shape.height <= MAX_ASPECT:
            return None
        return Downloaded(data, shape, candidate)

    async def _choose(self, query: str, options: list[Downloaded], lesson_id: str | None) -> Downloaded:
        images = tuple(Image(f"image/{'jpeg' if option.shape.extension == 'jpg' else option.shape.extension}", option.data) for option in options)
        prompt = CHOOSE_PROMPT.format(count=len(options), query=query, widths=", ".join(str(option.shape.width) for option in options))
        completion = await self._gateway.complete(Job.VISION_CHOOSE, prompt, system=CHOOSE_SYSTEM, images=images, lesson_id=lesson_id, effort="low")
        try:
            best = json.loads(completion.text[completion.text.find("{"):completion.text.rfind("}") + 1])["best"]
        except (json.JSONDecodeError, KeyError):
            return options[0]
        if best is None:
            raise PictureNotFound(query)
        return options[best - 1] if isinstance(best, int) and 1 <= best <= len(options) else options[0]

    def _save(self, chosen: Downloaded) -> Picture:
        file = f"{hashlib.sha256(chosen.data).hexdigest()[:FILE_PREFIX_LENGTH]}.{chosen.shape.extension}"
        self._media_dir.mkdir(parents=True, exist_ok=True)
        (self._media_dir / file).write_bytes(chosen.data)
        candidate = chosen.candidate
        credit = Credit(candidate.title[:120], candidate.creator[:80], candidate.license, candidate.source)
        return Picture(file, chosen.shape.width, chosen.shape.height, credit)


def _score(query: str, candidate: Candidate) -> float:
    words = re.findall(r"[a-z]+", query.lower())
    named = sum(word in candidate.text for word in words) / max(len(words), 1)
    score = 4 * named + (1.5 if candidate.featured else 0) + (1.0 if candidate.public_domain else 0)
    score += 2 if candidate.width >= SHARP_WIDTH else candidate.width / SHARP_WIDTH
    if candidate.height and not MIN_ASPECT <= candidate.width / candidate.height <= MAX_ASPECT:
        score -= 3
    if CROWDED.search(candidate.title) and not CROWDED.search(query):
        score -= 2
    if _archival(candidate):
        score -= 3
    return score


def _archival(candidate: Candidate) -> bool:
    return bool(ARCHIVAL.search(candidate.title) or ARCHIVAL.search(candidate.source))


def subject_of(ask: str) -> str:
    words = re.findall(r"[a-z]+", ask.lower().replace("'", ""))
    return " ".join(word for word in words if word not in QUESTION_WORDS)


async def prefetch(finder: PictureFinder, subject: str, attribution_ok: bool, lesson_id: str) -> None:
    with contextlib.suppress(PictureNotFound, httpx.HTTPError, GatewayError):
        await finder.find(subject, attribution_ok, lesson_id)
