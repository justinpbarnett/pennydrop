from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ..store import CallStats
from .document import FilmError

STAGE_FILES = {
    "research": "research.json",
    "pattern": "pattern.json",
    "script": "script.json",
    "factcheck": "fact-check.json",
    "plan": "plan.json",
}
BRIEF_FIELDS = ("topic", "thread", "minutes", "theme")


@dataclass(frozen=True)
class Workspace:
    home: Path

    @property
    def thread(self) -> str:
        return self.home.name

    @property
    def film(self) -> Path:
        return self.home / f"{self.thread}.film.jsonl"

    @property
    def voiced_film(self) -> Path:
        return self.home / f"{self.thread}.voiced.jsonl"

    @property
    def fact_check_table(self) -> Path:
        return self.home / "fact-check.md"

    @property
    def measures(self) -> Path:
        return self.home / "measures.json"

    def brief(self) -> dict:
        path = self.home / "brief.json"
        if not path.exists():
            raise FilmError(f"{path} is missing; write the brief first: {', '.join(BRIEF_FIELDS)}")
        brief = json.loads(path.read_text())
        missing = [field for field in BRIEF_FIELDS if field not in brief]
        if missing:
            raise FilmError(f"brief.json lacks {', '.join(missing)}")
        return brief

    def read(self, stage: str) -> dict:
        path = self.home / (STAGE_FILES[stage] if stage in STAGE_FILES else stage)
        if not path.exists():
            raise FilmError(f"{path.name} is missing in {self.home}; run the earlier stage first")
        return json.loads(path.read_text())

    def write(self, name: str, content: dict) -> Path:
        path = self.home / name
        path.write_text(json.dumps(content, indent=2, ensure_ascii=False) + "\n")
        return path

    def record(self, stage: str, calls: list[CallStats]) -> None:
        recorded = json.loads(self.measures.read_text()) if self.measures.exists() else {}
        tokens = {**recorded.get("tokens", {}), stage: sum(call.input_tokens + call.output_tokens for call in calls)}
        costs = {**recorded.get("costUsd", {})}
        known = [call.cost_usd for call in calls if call.cost_usd is not None]
        if known:
            costs[stage] = round(sum(known), 4)
        routes = {**recorded.get("routes", {}), stage: sorted({call.route for call in calls})}
        calls_made = {**recorded.get("calls", {}), stage: len(calls)}
        self.measures.write_text(
            json.dumps({**recorded, "tokens": tokens, "costUsd": costs, "routes": routes, "calls": calls_made, "reviewMinutes": recorded.get("reviewMinutes")}, indent=2) + "\n"
        )
