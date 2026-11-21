from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

import httpx

from ..gateway import Gateway, GatewayError, Image
from ..settings import Job
from .dimensions import ImageShape, image_shape
from .fetcher import PoliteFetcher
from .index import JsonIndex
from .locator import LocatedParts, PartLocator, PartsNotFound
from .sources import SHARP_WIDTH, Candidate, looks_like_a_photo, preview_url, search_all

MIN_WIDTH = 900
MAX_BYTES = 14_000_000
SHORTLIST = 6
CHOOSE_BUDGET = 3.0
OTHER_NAMES_PROMPT = 'Give the two other common English names people use for "{query}" when they look for photos of it, such as "steam locomotive" for "steam train". Answer with only a JSON list of two strings.'
FILE_PREFIX_LENGTH = 16
MIN_ASPECT, MAX_ASPECT = 0.5, 2.2
NOT_LIVE = re.compile(r"\b(skeleton|skull|fossil|specimen|museum|mnhn|statue|sculpture|skulptur|toy|model|drawing|painting|diagram|cartoon|illustration|bone|bones|taxidermy|mounted|distant|view of|landscape|panorama|silhouette|detail|close-up|closeup|handlebar|handlebars|interior|cockpit|background|backgrounds|banner|wallpaper|graphic|template|poster)\b", re.I)
CROWDED = re.compile(r"\b(group|crowd|flock|herd|pair|couple|dozens|many)\b", re.I)
ARCHIVAL = re.compile(r"\b(1[0-8]\d\d|19[0-6]\d)s?\b|\bca\.? ?\d|archive|archival|historic|negative|glass|vintage|daguerreo|collection|album|scan|nzgr|fsac", re.I)
QUESTION_WORDS = frozenset("what whats does do did is are was a an the show me us see picture pictures photo photos of look looks like looking inside in how can i you tell about please to let my its it s".split())
CHOOSE_SYSTEM = "You choose the best photo for a children's lesson. You answer with one JSON object and nothing else."
CHOOSE_PROMPT = """These {count} photos, numbered from 1 in the order shown, are candidates for a lesson that shows: {query}.
Their widths in pixels: {widths}.
Choose the one photo that shows {query} most clearly: one sharp, real COLOUR photo of the whole subject, large in the frame, with an uncluttered background, not a drawing, diagram, toy, model, crowd, collage or close-up of a detail. A colour photo always beats a black and white, sepia, scanned or archival one, even when the old one is sharper. Reject photos with a scanned plate or film border, and photos where the subject is small in the frame or the scene is cluttered. The {query} itself must be what the photo is about and must fill most of the frame: reject a photo of a person holding it or standing near it, and a photo where it is small or only a background object. Prefer the photo where the {query} covers the most of the frame, is whole and in focus, and shows the parts a child would name (such as head, legs, wings or wheels) clearly and unhidden, with nothing in front of it or taking more room than it does. Choosing none is better than choosing a photo of something else. When two are about equally clear, take the wider one.
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


@dataclass
class DeferredPicture:
    task: asyncio.Future[Picture]
    parts: list[str] = field(default_factory=list)

    def landed(self) -> Picture | None:
        return self.task.result() if self.task.done() and not self.task.cancelled() and not self.task.exception() else None


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
        self._fetcher = PoliteFetcher()
        self._searches: dict[str, asyncio.Task[Picture]] = {}
        self._misses: set[str] = set()
        self._upgrades: set[asyncio.Future[None]] = set()
        self._without_photo: dict[str | None, set[str]] = {}
        self._deferred: dict[tuple[str | None, str], DeferredPicture] = {}

    def lacks(self, lesson_id: str | None, name: str) -> bool:
        return name in self._without_photo.get(lesson_id, ()) or ((deferred := self._deferred.get((lesson_id, name))) is not None and deferred.landed() is None)

    def peek(self, query: str, attribution_ok: bool) -> Picture | None:
        key = _key(query, attribution_ok)
        if known := self._remembered(key):
            return known
        if key in self._misses:
            raise PictureNotFound(query)
        return None

    def defer(self, lesson_id: str | None, name: str, query: str, attribution_ok: bool) -> None:
        if (lesson_id, name) not in self._deferred:
            task = asyncio.ensure_future(self.find(query, attribution_ok, lesson_id))
            task.add_done_callback(lambda done: done.cancelled() or done.exception())
            self._deferred[(lesson_id, name)] = DeferredPicture(task)

    def pending(self, lesson_id: str | None, name: str) -> bool:
        deferred = self._deferred.get((lesson_id, name))
        return deferred is not None and not deferred.task.done()

    async def wait_to_land(self, lesson_id: str | None, name: str, seconds: float) -> None:
        if self.pending(lesson_id, name):
            with contextlib.suppress(TimeoutError, PictureNotFound, GatewayError, httpx.HTTPError):
                await asyncio.wait_for(asyncio.shield(self._deferred[(lesson_id, name)].task), seconds)

    def want_parts(self, lesson_id: str | None, name: str, parts: list[str]) -> None:
        self._deferred[(lesson_id, name)].parts = parts

    def landed(self, lesson_id: str | None, name: str) -> tuple[Picture, list[str]] | None:
        deferred = self._deferred.get((lesson_id, name))
        landed = deferred.landed() if deferred else None
        return (landed, deferred.parts) if deferred and landed else None

    def note_lacking(self, lesson_id: str | None, name: str) -> None:
        self._without_photo.setdefault(lesson_id, set()).add(name)

    def holds(self, src: str) -> bool:
        return src.startswith("/media/") and (self._media_dir / src.removeprefix("/media/")).is_file()

    async def find(self, query: str, attribution_ok: bool, lesson_id: str | None) -> Picture:
        key = _key(query, attribution_ok)
        if known := self._remembered(key):
            return known
        if key in self._misses:
            raise PictureNotFound(query)
        search = self._searches.get(key)
        if search is None:
            search = self._searches[key] = asyncio.ensure_future(self._search(key, query, attribution_ok, lesson_id))
            search.add_done_callback(lambda _: self._searches.pop(key, None))
        try:
            return await asyncio.shield(search)
        except PictureNotFound:
            self._misses.add(key)
            raise

    async def _search(self, key: str, query: str, attribution_ok: bool, lesson_id: str | None) -> Picture:
        other_names = asyncio.ensure_future(self._search_other_names(query, attribution_ok, lesson_id))
        candidates = [candidate for candidate in await search_all(query, attribution_ok) if looks_like_a_photo(candidate)]
        if sum(not _archival(candidate) for candidate in candidates) < SHORTLIST:
            seen = {candidate.url for candidate in candidates}
            candidates += [candidate for candidate in await other_names if candidate.url not in seen]
        else:
            other_names.cancel()
        ranked = sorted(candidates, key=lambda candidate: -_score(query, candidate))
        sharp = [candidate for candidate in ranked if candidate.width >= MIN_WIDTH and (not candidate.height or MIN_ASPECT <= candidate.width / candidate.height <= MAX_ASPECT)]
        previews = [item for item in await asyncio.gather(*(self._preview(candidate) for candidate in sharp[:SHORTLIST])) if item]
        if not previews:
            if sharp:
                raise httpx.TransportError("no preview could be fetched")
            raise PictureNotFound(query)
        top = previews[0]
        top_full = asyncio.ensure_future(self._download(top.candidate))
        top_full.add_done_callback(lambda done: self._warm(done, query, lesson_id))
        best = top
        if len(previews) > 1:
            choice = asyncio.ensure_future(self._choose(query, previews, lesson_id))
            try:
                best = await asyncio.wait_for(asyncio.shield(choice), CHOOSE_BUDGET)
            except TimeoutError:
                self._upgrades.add(upgrade := asyncio.ensure_future(self._upgrade(key, query, lesson_id, top, choice)))
                upgrade.add_done_callback(self._upgrades.discard)
        try:
            full = await (top_full if best is top else self._download(best.candidate))
        except httpx.HTTPError:
            full = None
        full = full or await top_full
        if full is None:
            raise PictureNotFound(query)
        return self._remember(key, query, lesson_id, full)

    def _remember(self, key: str, query: str, lesson_id: str | None, full: Downloaded) -> Picture:
        picture = self._save(full)
        self._index.put(key, {"file": picture.file, "w": picture.w, "h": picture.h, "credit": asdict(picture.credit)})
        if self._on_found:
            self._on_found(picture.file, query, lesson_id)
        return picture

    def _warm(self, done: asyncio.Future[Downloaded | None], query: str, lesson_id: str | None) -> None:
        if self._on_found and not done.cancelled() and not done.exception() and (full := done.result()):
            self._on_found(self._save(full).file, query, lesson_id)

    async def _upgrade(self, key: str, query: str, lesson_id: str | None, top: Downloaded, choice: asyncio.Future[Downloaded]) -> None:
        try:
            best = await choice
            full = await self._download(best.candidate) if best is not top else None
        except (PictureNotFound, GatewayError, httpx.HTTPError):
            return
        if full:
            self._remember(key, query, lesson_id, full)

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
            return Picture(entry["file"], entry["w"], entry["h"], Credit(**{**entry["credit"], "title": clean_title(entry["credit"]["title"], entry["credit"]["creator"])}))
        return None

    async def _preview(self, candidate: Candidate) -> Downloaded | None:
        try:
            data = await self._fetcher.get(preview_url(candidate.url), 20)
        except httpx.HTTPError:
            return None
        shape = image_shape(data)
        return Downloaded(data, shape, candidate) if shape else None

    async def _download(self, candidate: Candidate) -> Downloaded | None:
        data = await self._fetcher.get(candidate.url, 40)
        shape = image_shape(data)
        if shape is None or len(data) > MAX_BYTES or shape.width < MIN_WIDTH or not MIN_ASPECT <= shape.width / shape.height <= MAX_ASPECT:
            return None
        return Downloaded(data, shape, candidate)

    async def _choose(self, query: str, options: list[Downloaded], lesson_id: str | None) -> Downloaded:
        images = tuple(Image(f"image/{'jpeg' if option.shape.extension == 'jpg' else option.shape.extension}", option.data) for option in options)
        prompt = CHOOSE_PROMPT.format(count=len(options), query=query, widths=", ".join(str(option.candidate.width) for option in options))
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
        creator = clean_creator(candidate.creator)
        credit = Credit(clean_title(candidate.title, creator)[:120], creator, candidate.license, candidate.source)
        return Picture(file, chosen.shape.width, chosen.shape.height, credit)


def _key(query: str, attribution_ok: bool) -> str:
    return f"{'by' if attribution_ok else 'free'}:{' '.join(query.lower().split())}"


def clean_creator(creator: str) -> str:
    named = re.sub(r"^\s*(?:this\s+)?(?:photo(?:graph)?|picture|image)?\s*(?:was\s+)?(?:taken|made|created|shot)?\s*by\s+", "", creator, flags=re.I)
    first = re.split(r"\s+[.;|]\s+|(?<=\w{3})[.;|]\s+(?=[A-Z])|\s{2,}", named)[0]
    return " ".join(first.split())[:80] or creator[:80]


def clean_title(title: str, creator: str) -> str:
    plain = re.sub(r"[_]+", " ", title)
    plain = re.sub(r"\s*[,.(\-–]?\s*\b(?:photo(?:graph)?|picture|image|credit)s?\s+(?:by|of)\s+.*$", "", plain, flags=re.I)
    if creator and creator != "Unknown":
        plain = re.sub(rf"\s*[,(\-–]?\s*(?:by\s+)?{re.escape(creator)}\)?\s*$", "", plain, flags=re.I)
    numbered = re.sub(r"^\s*[(\[]?\d[\w-]*[)\]]?\s+", "", plain)
    kept = numbered if len(numbered.split()) >= 2 else plain
    return " ".join(kept.split()).strip(" ,.-–") or title


def _score(query: str, candidate: Candidate) -> float:
    words = re.findall(r"[a-z]+", query.lower())
    named = sum(word in candidate.text for word in words) / max(len(words), 1)
    score = 4 * named + (1.5 if candidate.featured else 0) + (1.0 if candidate.public_domain else 0)
    score += 5 if candidate.lead else 0
    score += 2 if candidate.width >= SHARP_WIDTH else candidate.width / SHARP_WIDTH
    if candidate.height and not MIN_ASPECT <= candidate.width / candidate.height <= MAX_ASPECT:
        score -= 3
    if CROWDED.search(candidate.title) and not CROWDED.search(query):
        score -= 2
    if _archival(candidate):
        score -= 3
    if NOT_LIVE.search(candidate.title) and not NOT_LIVE.search(query):
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
