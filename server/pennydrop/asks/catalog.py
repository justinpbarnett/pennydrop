from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass

from ..settings import Settings


class CatalogError(RuntimeError):
    pass


@dataclass(frozen=True)
class LabEntry:
    id: str
    title: str
    summary: str
    ops: dict[str, str]


@dataclass(frozen=True)
class CatalogSnapshot:
    labs: tuple[LabEntry, ...]
    markdown: str


class Catalog:
    def __init__(self, settings: Settings):
        self._player_dir = settings.player_dir
        self._minted_dir = settings.data_dir / "minted-labs" / "dist"
        self._signature: tuple | None = None
        self._snapshot: CatalogSnapshot | None = None
        self._lock = asyncio.Lock()

    async def current(self) -> CatalogSnapshot:
        async with self._lock:
            signature = self._lab_files_signature()
            if self._snapshot is None or signature != self._signature:
                labs_json, markdown = await asyncio.gather(self._run_tool(), self._run_tool("--md"))
                labs = tuple(LabEntry(lab["id"], lab["title"], lab["summary"], lab["ops"]) for lab in json.loads(labs_json)["labs"])
                self._snapshot = CatalogSnapshot(labs, markdown.decode().strip())
                self._signature = signature
            return self._snapshot

    def _lab_files_signature(self) -> tuple:
        labs_dir = self._player_dir / "src" / "labs"
        built_in = ((str(path), path.stat().st_mtime_ns) for path in labs_dir.rglob("*") if path.is_file())
        minted = ((str(path), hashlib.sha256(path.read_bytes()).hexdigest()) for path in self._minted_dir.glob("*.js"))
        return tuple(sorted((*built_in, *minted)))

    async def _run_tool(self, *flags: str) -> bytes:
        try:
            process = await asyncio.create_subprocess_exec(
                "bun", "tools/catalog.ts", *flags, cwd=self._player_dir,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            raise CatalogError("'bun' is not installed or not on PATH, and the player's catalog tool needs it") from None
        stdout, stderr = await process.communicate()
        if process.returncode != 0:
            raise CatalogError(f"bun tools/catalog.ts {' '.join(flags)} exited with {process.returncode}: {stderr.decode(errors='replace')[-600:]}")
        return stdout
