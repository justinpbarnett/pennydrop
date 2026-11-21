from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..settings import Settings

MINT_JOB_TIMEOUT_SECONDS = 1800.0


@dataclass(frozen=True)
class MintPaths:
    player: Path
    data: Path
    improve_references: Path

    @classmethod
    def of(cls, settings: Settings) -> MintPaths:
        return cls(settings.player_dir, settings.data_dir, settings.improve_references)

    @property
    def workspaces(self) -> Path:
        return self.data / "mint"

    @property
    def minted(self) -> Path:
        return self.data / "minted-labs"

    @property
    def minted_dist(self) -> Path:
        return self.minted / "dist"

    @property
    def tools(self) -> Path:
        return self.player / "tools"

    @property
    def labs(self) -> Path:
        return self.player / "src" / "labs"

    @property
    def lessons(self) -> Path:
        return self.player.parent / "lessons"

    def workspace(self, lab_id: str) -> Path:
        return self.workspaces / lab_id

    def minted_source(self, lab_id: str) -> Path:
        return self.minted / f"{lab_id}.ts"

    def minted_build(self, lab_id: str) -> Path:
        return self.minted_dist / f"{lab_id}.js"

    def example_lesson(self, lab_id: str) -> Path:
        return self.minted / f"{lab_id}-example.jsonl"
