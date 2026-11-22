from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


class FilmError(RuntimeError):
    pass


@dataclass(frozen=True)
class FilmDocument:
    path: Path
    header: dict
    lines: list[dict]

    @property
    def name(self) -> str:
        return self.path.name.removesuffix(".jsonl").removesuffix(".film")

    @classmethod
    def read(cls, path: Path) -> FilmDocument:
        if not path.exists():
            raise FilmError(f"no film file at {path}")
        header: dict | None = None
        lines: list[dict] = []
        for number, raw in enumerate(path.read_text().splitlines(), 1):
            if not raw.strip():
                continue
            try:
                row = json.loads(raw)
            except json.JSONDecodeError as error:
                raise FilmError(f"{path.name} line {number} is not valid JSON: {error}") from error
            if "film" in row:
                header = row["film"]
            else:
                lines.append(row)
        if header is None:
            raise FilmError(f'{path.name} has no {{"film": ...}} header line')
        return cls(path, header, lines)

    def with_voices(self, voices: list[dict]) -> str:
        rows = [{"film": self.header}] + [{**line, "voice": voice} for line, voice in zip(self.lines, voices, strict=True)]
        return "\n".join(json.dumps(row) for row in rows) + "\n"
