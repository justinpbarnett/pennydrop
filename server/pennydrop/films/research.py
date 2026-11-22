from __future__ import annotations

import json

from ..services import Services
from ..settings import Job
from .ask import answer, armature, prompt
from .workspace import Workspace

FIRST_HAND = ("own work", "correspondence", "memoir")
MIN_SOURCES = 8
MIN_FACTS = 30
MIN_TACTICS = 3


def source_pack_problems(pack: dict) -> list[str]:
    sources = pack.get("sources")
    facts = pack.get("facts")
    if not isinstance(sources, list) or not isinstance(facts, list):
        return ['the source pack needs a "sources" list and a "facts" list']
    problems = []
    if len(sources) < MIN_SOURCES:
        problems.append(f"only {len(sources)} sources; find at least {MIN_SOURCES}")
    if len(facts) < MIN_FACTS:
        problems.append(f"only {len(facts)} facts; collect at least {MIN_FACTS}")
    ids = set()
    for source in sources:
        label = source.get("id", "?")
        ids.add(source.get("id"))
        if not str(source.get("url", "")).startswith("http"):
            problems.append(f"source {label} has no http URL")
        for passage in source.get("passages", []):
            if not passage.get("quote"):
                problems.append(f"source {label} has a passage with no quotation")
            speaker = passage.get("speaker")
            trace = passage.get("trace") or {}
            if speaker and (trace.get("kind") not in FIRST_HAND or not trace.get("cite")):
                problems.append(f'source {label}: a quotation of {speaker} ("{passage.get("quote", "")[:60]}") has no trace to their own work, their correspondence or a contemporary memoir; trace it or move it to rejected_sayings')
    for fact in facts:
        unknown = [source for source in fact.get("sources", []) if source not in ids]
        if unknown or not fact.get("sources"):
            problems.append(f"fact {fact.get('id', '?')} cites no known source ({', '.join(map(str, unknown)) or 'none given'})")
    return problems


def pattern_problems(pattern: dict) -> list[str]:
    problems = []
    if pattern.get("verdict") not in ("accept", "reject"):
        problems.append('"verdict" must be "accept" or "reject"')
    if not pattern.get("reasons"):
        problems.append('"reasons" must say why')
    tactics = pattern.get("tactics", [])
    if len(tactics) < MIN_TACTICS:
        problems.append(f"test at least {MIN_TACTICS} tactics, found {len(tactics)}")
    for tactic in tactics:
        if tactic.get("verdict") not in ("holds", "partly", "breaks") or not tactic.get("holds") or not tactic.get("breaks"):
            problems.append(f'tactic "{tactic.get("tactic", "?")}" needs holds, breaks and a verdict of holds, partly or breaks')
    if pattern.get("verdict") == "accept" and not pattern.get("candidate_armatures"):
        problems.append("an accepted Thread needs candidate armatures")
    return problems


async def research(services: Services, workspace: Workspace) -> dict:
    brief = workspace.brief()
    question = prompt("research", brief=json.dumps(brief, indent=2))
    pack = await answer(services, workspace, "research", Job.FILM_RESEARCH, question, source_pack_problems, search=True)
    workspace.write("research.json", pack)
    return pack


async def pattern(services: Services, workspace: Workspace) -> dict:
    brief = workspace.brief()
    pack = workspace.read("research")
    question = prompt("pattern", brief=json.dumps(brief, indent=2), research=json.dumps(pack, indent=1, ensure_ascii=False), armature=armature())
    checked = await answer(services, workspace, "pattern", Job.FILM_RESEARCH, question, pattern_problems)
    workspace.write("pattern.json", checked)
    return checked
