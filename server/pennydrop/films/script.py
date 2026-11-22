from __future__ import annotations

import json
import re

from ..services import Services
from ..settings import Job
from .ask import answer, armature, craft_narration, prompt
from .document import FilmError
from .workspace import Workspace

SPINE_STARTERS = ("Once upon a time", "Every day", "But one day", "Because of that", "Because of that", "Because of that", "Until finally", "And ever since then")
WORDS_PER_MINUTE = 185
WORD_BUDGET_TOLERANCE = 0.12
SCENE_WORDS = (25, 80)
MIN_SCENES = 12
ARMATURE_WORDS = 40
DIGIT_OR_SYMBOL = re.compile(r"[0-9%$&+=<>/\\^*#@]")
EM_DASH = "\u2014"


def script_problems(script: dict, minutes: float) -> list[str]:
    problems = []
    armature_text = script.get("armature")
    if not isinstance(armature_text, str) or not armature_text.strip():
        problems.append("the script needs an armature sentence")
    elif len(armature_text.split()) > ARMATURE_WORDS or armature_text.count(".") > 1:
        problems.append(f"the armature must be one sentence of at most {ARMATURE_WORDS} words")
    spine = script.get("spine")
    if not isinstance(spine, list) or len(spine) != len(SPINE_STARTERS):
        problems.append(f"the spine needs exactly {len(SPINE_STARTERS)} sentences")
    else:
        problems += [f'spine sentence {number} must start with "{starter}"' for number, (starter, sentence) in enumerate(zip(SPINE_STARTERS, spine), 1) if not str(sentence).startswith(starter)]
    scenes = script.get("scenes")
    if not isinstance(scenes, list) or len(scenes) < MIN_SCENES:
        return problems + [f"the script needs at least {MIN_SCENES} scenes"]
    previous = 1
    for position, scene in enumerate(scenes, 1):
        label = f"scene {position}"
        if scene.get("n") != position:
            problems.append(f"{label} is numbered {scene.get('n')}; number scenes 1, 2, 3 in order")
        number = scene.get("spine")
        if not isinstance(number, int) or not 1 <= number <= len(SPINE_STARTERS):
            problems.append(f"{label} needs a spine number from 1 to {len(SPINE_STARTERS)}")
        else:
            if number < previous:
                problems.append(f"{label} serves spine sentence {number} after sentence {previous}; the story only moves forward")
            previous = number
        say = scene.get("say", "")
        words = len(say.split())
        if not SCENE_WORDS[0] <= words <= SCENE_WORDS[1]:
            problems.append(f"{label} has {words} words; a scene is {SCENE_WORDS[0]} to {SCENE_WORDS[1]}")
        if DIGIT_OR_SYMBOL.search(say):
            problems.append(f"{label} has a digit or symbol in its narration; write numbers as spoken words")
        if EM_DASH in say:
            problems.append(f"{label} has an em dash")
        if not scene.get("serves") or not scene.get("beat"):
            problems.append(f"{label} needs `serves` and `beat`")
    served = {scene.get("spine") for scene in scenes}
    problems += [f"no scene serves spine sentence {number}" for number in range(1, len(SPINE_STARTERS) + 1) if number not in served]
    if scenes[0].get("spine") != 1:
        problems.append("scene 1 is the cold open and serves spine sentence 1")
    if scenes[-1].get("spine") != len(SPINE_STARTERS):
        problems.append(f"the last scene serves spine sentence {len(SPINE_STARTERS)}")
    target = minutes * WORDS_PER_MINUTE
    total = sum(len(scene.get("say", "").split()) for scene in scenes)
    if abs(total - target) > target * WORD_BUDGET_TOLERANCE:
        problems.append(f"the narration is {total} words; {minutes:g} minutes needs about {target:.0f}, give or take {WORD_BUDGET_TOLERANCE:.0%}")
    return problems


async def script(services: Services, workspace: Workspace) -> dict:
    brief = workspace.brief()
    pattern = workspace.read("pattern")
    if pattern["verdict"] == "reject":
        raise FilmError("the pattern check rejected this Topic:\n" + "\n".join(f"- {reason}" for reason in pattern["reasons"]))
    minutes = float(brief["minutes"])
    question = prompt(
        "script",
        minutes=f"{minutes:g}",
        words=f"about {minutes * WORDS_PER_MINUTE:.0f}",
        brief=json.dumps(brief, indent=2),
        research=json.dumps(workspace.read("research"), indent=1, ensure_ascii=False),
        pattern=json.dumps(pattern, indent=1, ensure_ascii=False),
        armature=armature(),
        craft_narration=craft_narration(),
    )
    written = await answer(services, workspace, "script", Job.FILM_SCRIPT, question, lambda draft: script_problems(draft, minutes))
    workspace.write("script.json", written)
    return written


async def corrected(services: Services, workspace: Workspace, claims_table: str) -> dict:
    minutes = float(workspace.brief()["minutes"])
    question = prompt("correct", script=json.dumps(workspace.read("script"), indent=1, ensure_ascii=False), claims=claims_table, craft_narration=craft_narration())
    return await answer(services, workspace, "correct", Job.FILM_SCRIPT, question, lambda draft: script_problems(draft, minutes))
