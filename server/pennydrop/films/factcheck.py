from __future__ import annotations

from ..services import Services
from ..settings import Job
from .ask import answer, prompt
from .script import corrected
from .workspace import Workspace

VERDICTS = ("verified", "derived", "interpretation", "toy", "unconfirmed", "corrected", "removed")
NEEDS_FIX = ("corrected", "removed")


def claim_problems(table: dict, scene_count: int) -> list[str]:
    claims = table.get("claims")
    if not isinstance(claims, list) or not claims:
        return ['the answer needs a non-empty "claims" list']
    problems = []
    for position, claim in enumerate(claims, 1):
        if claim.get("verdict") not in VERDICTS:
            problems.append(f"claim {position} has verdict {claim.get('verdict')!r}; use one of {', '.join(VERDICTS)}")
        if not claim.get("claim") or not claim.get("source"):
            problems.append(f"claim {position} needs its claim and its source")
        if claim.get("verdict") in NEEDS_FIX and not claim.get("fix"):
            problems.append(f"claim {position} is {claim.get('verdict')} and needs a fix")
        if not isinstance(claim.get("scene"), int) or not 1 <= claim["scene"] <= scene_count:
            problems.append(f"claim {position} names scene {claim.get('scene')!r}, outside 1 to {scene_count}")
    checked = {claim.get("scene") for claim in claims}
    problems += [f"scene {number} has no claim checked" for number in range(1, scene_count + 1) if number not in checked]
    return problems


def table_rows(claims: list[dict]) -> str:
    def cell(text: object) -> str:
        return str(text).replace("|", "/").replace("\n", " ").strip()

    return "\n".join(f"| {number} | scene {claim['scene']}: {cell(claim['claim'])} | {cell(claim['source'])} | {claim['verdict']} |" for number, claim in enumerate(claims, 1))


def table_document(claims: list[dict]) -> str:
    return "# Fact check\n\n| # | Claim | Source | Verdict |\n|---|---|---|---|\n" + table_rows(claims) + "\n"


def claims_for_writer(claims: list[dict]) -> str:
    return "\n".join(f"- scene {claim['scene']} [{claim['verdict']}] {claim['claim']} -> fix: {claim['fix']} (source: {claim['source']})" for claim in claims if claim["verdict"] in NEEDS_FIX)


async def factcheck(services: Services, workspace: Workspace) -> dict:
    script = workspace.read("script")
    scenes = script["scenes"]
    shown = "\n\n".join(f"Scene {scene['n']}: {scene['say']}" for scene in scenes)
    question = prompt("factcheck", script=shown)
    table = await answer(services, workspace, "factcheck", Job.FILM_FACTCHECK, question, lambda found: claim_problems(found, len(scenes)), search=True)
    workspace.write("fact-check.json", table)
    workspace.fact_check_table.write_text(table_document(table["claims"]))
    if not any(claim["verdict"] in NEEDS_FIX for claim in table["claims"]):
        return table
    fixed = await corrected(services, workspace, claims_for_writer(table["claims"]))
    workspace.write("script.json", fixed)
    return table
