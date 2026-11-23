from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass

from .workspace import Workspace

CATCH_VERDICTS = ("corrected", "removed")
ROW = re.compile(r"^\|\s*\d+\s*\|.*\|\s*([a-z]+)\s*\|\s*$")


@dataclass(frozen=True)
class FilmMeasures:
    render_minutes: float | None
    tokens: dict[str, int]
    cost_usd: dict[str, float]
    review_minutes: float | None
    claims: Counter

    @property
    def catches(self) -> int:
        return sum(self.claims[verdict] for verdict in CATCH_VERDICTS)


def _by_stage(recorded: dict[str, float]) -> dict[str, float]:
    """Folds per-shot entries such as "shot s07" into one "shot" entry."""
    folded: dict[str, float] = defaultdict(float)
    for stage, amount in recorded.items():
        folded[stage.split()[0]] += amount
    return dict(folded)


def gather(workspace: Workspace) -> FilmMeasures:
    recorded = json.loads(workspace.measures.read_text()) if workspace.measures.exists() else {}
    rendered_path = workspace.home / "render.json"
    rendered = json.loads(rendered_path.read_text()) if rendered_path.exists() else {}
    log = workspace.fact_check_table
    claims = Counter(match.group(1) for line in (log.read_text().splitlines() if log.exists() else []) if (match := ROW.match(line)))
    return FilmMeasures(
        render_minutes=rendered.get("minutes"),
        tokens={stage: int(count) for stage, count in _by_stage(recorded.get("tokens", {})).items()},
        cost_usd=_by_stage(recorded.get("costUsd", {})),
        review_minutes=recorded.get("reviewMinutes"),
        claims=claims,
    )


def format_measures(measures: FilmMeasures) -> list[str]:
    tokens = ", ".join(f"{stage} {count}" + (f" (${measures.cost_usd[stage]:.2f})" if stage in measures.cost_usd else "") for stage, count in measures.tokens.items()) or "none"
    review = "not recorded" if measures.review_minutes is None else f"{measures.review_minutes:.0f} min"
    render = "not recorded" if measures.render_minutes is None else f"{measures.render_minutes:.1f} min"
    verdicts = ", ".join(f"{count} {verdict}" for verdict, count in sorted(measures.claims.items())) or "no fact check log"
    return [
        f"measure  last render run {render}",
        f"measure  tokens by stage: {tokens}",
        f"measure  review minutes {review}",
        f"measure  fact check catches {measures.catches} over {sum(measures.claims.values())} claims ({verdicts})",
    ]
