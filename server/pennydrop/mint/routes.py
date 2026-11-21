from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .paths import MintPaths


def minted_labs_router(paths: MintPaths) -> APIRouter:
    router = APIRouter(prefix="/api/minted-labs")

    @router.get("")
    def listing() -> list[dict[str, str]]:
        built = sorted(paths.minted_dist.glob("*.js")) if paths.minted_dist.is_dir() else []
        return [{"id": file.stem, "url": f"/api/minted-labs/{file.name}"} for file in built]

    @router.get("/{name}.js")
    def module(name: str) -> FileResponse:
        file = paths.minted_dist / f"{name}.js"
        if file.parent != paths.minted_dist or not file.is_file():
            raise HTTPException(404, f"no minted Lab '{name}'; `pd mint list` shows what exists")
        return FileResponse(file, media_type="text/javascript", headers={"cache-control": "no-cache"})

    return router
