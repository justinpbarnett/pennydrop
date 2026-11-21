from __future__ import annotations

import asyncio
import html
import re
from dataclasses import dataclass, replace

import httpx

USER_AGENT = "pennydrop/0.1"
OPENVERSE = "https://api.openverse.org/v1/images/"
COMMONS = "https://commons.wikimedia.org/w/api.php"
WIKIPEDIA = "https://en.wikipedia.org/w/api.php"
OPENVERSE_PAGES = (1, 2)
OPENVERSE_PAGE_SIZE = 20
COMMONS_LIMIT = 50
COMMONS_THUMB_WIDTH = 2400
PREVIEW_WIDTH = 500
NOT_A_PHOTO = re.compile(r"drawing|painting|illustration|diagram|\bmap\b|engraving|stamp|poster|logo|icon|sketch|lithograph|plate|cartoon|clipart|\bsvg\b|collage|montage|screenshot|mosaic", re.I)
PUBLIC_DOMAIN_NAMES = ("cc0", "public domain", "pd")
ATTRIBUTION_NAMES = ("cc by",)
EXCLUDED_TERMS = ("-nc", "-nd", " nc", " nd")


@dataclass(frozen=True)
class Candidate:
    url: str
    width: int
    height: int
    title: str
    creator: str
    license: str
    source: str
    text: str
    featured: bool
    public_domain: bool
    lead: bool = False


def _plain(text: str | None) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", text or ""))).strip()


def _license_allowed(name: str, attribution_ok: bool) -> bool:
    lowered = name.lower()
    if any(term in lowered for term in EXCLUDED_TERMS):
        return False
    return lowered.startswith(PUBLIC_DOMAIN_NAMES) or (attribution_ok and lowered.startswith(ATTRIBUTION_NAMES))


def _is_public_domain(name: str) -> bool:
    return name.lower().startswith(PUBLIC_DOMAIN_NAMES)


async def search_all(query: str, attribution_ok: bool) -> list[Candidate]:
    headers = {"User-Agent": USER_AGENT}
    async with httpx.AsyncClient(headers=headers, timeout=20, follow_redirects=True) as client:
        found = await asyncio.gather(_openverse(client, query, attribution_ok), _commons(client, query, attribution_ok), _lead_image(client, query, attribution_ok), return_exceptions=True)
    candidates = [candidate for source in found if isinstance(source, list) for candidate in source]
    leads = {candidate.source for candidate in candidates if candidate.lead}
    candidates = [candidate for candidate in candidates if candidate.lead or candidate.source not in leads]
    failures = [source for source in found if isinstance(source, BaseException)]
    if not candidates and failures:
        raise failures[0]
    return candidates


async def _openverse(client: httpx.AsyncClient, query: str, attribution_ok: bool) -> list[Candidate]:
    licenses = "cc0,pdm,by,by-sa" if attribution_ok else "cc0,pdm"
    responses = []
    for page in OPENVERSE_PAGES:
        response = await client.get(OPENVERSE, params={"q": query, "license": licenses, "category": "photograph", "page_size": OPENVERSE_PAGE_SIZE, "page": page})
        if response.is_success:
            responses.append(response)
        elif page == OPENVERSE_PAGES[0]:
            response.raise_for_status()
    candidates = []
    for item in (item for response in responses for item in response.json()["results"]):
        name = _openverse_license(item["license"], item.get("license_version"))
        if item.get("mature") or not item.get("url") or not _license_allowed(name, attribution_ok):
            continue
        tags = " ".join(tag["name"] for tag in item.get("tags") or [])
        candidates.append(Candidate(
            url=item["url"], width=item.get("width") or 0, height=item.get("height") or 0, title=_plain(item.get("title")) or query,
            creator=_plain(item.get("creator")) or "Unknown", license=name, source=item.get("foreign_landing_url") or item["url"],
            text=f"{item.get('title') or ''} {tags}".lower(), featured=False, public_domain=_is_public_domain(name),
        ))
    return candidates


def _openverse_license(kind: str, version: str | None) -> str:
    if kind == "pdm":
        return "Public domain"
    return f"CC {kind.upper()} {version}" if version else f"CC {kind.upper()}"


async def _commons(client: httpx.AsyncClient, query: str, attribution_ok: bool) -> list[Candidate]:
    response = await client.get(COMMONS, params={
        "action": "query", "format": "json", "generator": "search", "gsrsearch": f"{query} filetype:bitmap", "gsrnamespace": 6,
        "gsrlimit": COMMONS_LIMIT, "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": COMMONS_THUMB_WIDTH,
    })
    response.raise_for_status()
    return _commons_candidates(response.json(), attribution_ok)


async def _lead_image(client: httpx.AsyncClient, query: str, attribution_ok: bool) -> list[Candidate]:
    article = await client.get(WIKIPEDIA, params={"action": "query", "format": "json", "titles": query, "redirects": 1, "prop": "pageimages", "piprop": "name"})
    article.raise_for_status()
    names = [page["pageimage"] for page in (article.json().get("query") or {}).get("pages", {}).values() if page.get("pageimage")]
    if not names:
        return []
    response = await client.get(COMMONS, params={
        "action": "query", "format": "json", "titles": f"File:{names[0]}", "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": COMMONS_THUMB_WIDTH,
    })
    response.raise_for_status()
    return [replace(candidate, lead=True) for candidate in _commons_candidates(response.json(), attribution_ok)]


def _commons_candidates(body: dict, attribution_ok: bool) -> list[Candidate]:
    candidates = []
    for page in (body.get("query") or {}).get("pages", {}).values():
        if not page.get("imageinfo"):
            continue
        info = page["imageinfo"][0]
        meta = info.get("extmetadata", {})
        name = _plain(meta.get("LicenseShortName", {}).get("value"))
        if info.get("mime") not in ("image/jpeg", "image/png", "image/webp") or not _license_allowed(name, attribution_ok):
            continue
        title = _plain(meta.get("ObjectName", {}).get("value")) or re.sub(r"\.\w+$", "", page["title"].removeprefix("File:"))
        categories = _plain(meta.get("Categories", {}).get("value"))
        description = _plain(meta.get("ImageDescription", {}).get("value"))
        scale = info["thumbwidth"] / info["width"] if info.get("thumbwidth") else 1
        candidates.append(Candidate(
            url=info.get("thumburl") or info["url"], width=round(info["width"] * scale), height=round(info["height"] * scale), title=title,
            creator=_plain(meta.get("Artist", {}).get("value")) or "Unknown", license=name, source=info["descriptionurl"],
            text=f"{page['title']} {description} {categories}".lower(), featured=bool(meta.get("Assessments", {}).get("value")),
            public_domain=_is_public_domain(name),
        ))
    return candidates


THUMB_PATH = re.compile(r"/\d+px-([^/?]+)")
COMMONS_ORIGINAL = re.compile(r"^(https://upload\.wikimedia\.org/wikipedia/commons)/(\w/\w\w/([^/?]+))(\?.*)?$")


def preview_url(url: str) -> str:
    if original := COMMONS_ORIGINAL.match(url):
        return f"{original[1]}/thumb/{original[2]}/{PREVIEW_WIDTH}px-{original[3]}"
    return THUMB_PATH.sub(rf"/{PREVIEW_WIDTH}px-\1", url)


def looks_like_a_photo(candidate: Candidate) -> bool:
    return not NOT_A_PHOTO.search(f"{candidate.title} {candidate.text}")
