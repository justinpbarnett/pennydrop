from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

CATCH_VERDICTS = ("corrected", "removed")
ROW = re.compile(r"^\|\s*\d+\s*\|.*\|\s*([a-z]+)\s*\|\s*$")


@dataclass(frozen=True)
class FilmMeasures:
    render_minutes: float | None
    stage_seconds: dict[str, float]
    tokens: dict[str, int]
    cost_usd: dict[str, float]
    review_minutes: float | None
    claims: Counter

    @property
    def catches(self) -> int:
        return sum(self.claims[verdict] for verdict in CATCH_VERDICTS)


def gather(mp4: Path, manifest: dict) -> FilmMeasures:
    rendered = manifest.get("measures", {})
    home = mp4.parent
    recorded = json.loads((home / "measures.json").read_text()) if (home / "measures.json").exists() else {}
    log = home / "fact-check.md"
    claims = Counter(match.group(1) for line in (log.read_text().splitlines() if log.exists() else []) if (match := ROW.match(line)))
    return FilmMeasures(
        render_minutes=rendered.get("renderMinutes"),
        stage_seconds=rendered.get("stageSeconds", {}),
        tokens=recorded.get("tokens", {}),
        cost_usd=recorded.get("costUsd", {}),
        review_minutes=recorded.get("reviewMinutes"),
        claims=claims,
    )


def format_measures(measures: FilmMeasures) -> list[str]:
    stages = ", ".join(f"{name} {seconds / 60:.1f}" for name, seconds in measures.stage_seconds.items()) or "not recorded"
    tokens = ", ".join(f"{stage} {count}" + (f" (${measures.cost_usd[stage]:.2f})" if stage in measures.cost_usd else "") for stage, count in measures.tokens.items()) or "none"
    review = "not recorded" if measures.review_minutes is None else f"{measures.review_minutes:.0f} min"
    render = "not recorded" if measures.render_minutes is None else f"{measures.render_minutes:.1f} min"
    verdicts = ", ".join(f"{count} {verdict}" for verdict, count in sorted(measures.claims.items())) or "no fact check log"
    return [
        f"measure  render minutes {render} (by stage, min: {stages})",
        f"measure  tokens by stage: {tokens}",
        f"measure  review minutes {review}",
        f"measure  fact check catches {measures.catches} over {sum(measures.claims.values())} claims ({verdicts})",
    ]
