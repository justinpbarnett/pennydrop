from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass

from ..services import Services
from ..settings import Job
from ..words import normalize_word
from .ask import answer, prompt
from .document import FilmError
from .narration import Narration, Word
from .workspace import Workspace

SIZES = ("wide", "full", "medium", "close")
SHOT_SECONDS = (2.5, 12.0)
MOST_SETS = 10
MOST_SUBJECTS = 2
CUT_BEFORE_WORD = 0.2


@dataclass(frozen=True)
class Shot:
    id: str
    start: float
    end: float
    words: list[Word]
    board: dict

    @property
    def seconds(self) -> float:
        return self.end - self.start

    def local_words(self) -> list[dict]:
        return [{"word": word.text, "start": round(word.start - self.start, 3), "end": round(word.end - self.start, 3)} for word in self.words]


def comparable(text: str) -> list[str]:
    return [word for word in (normalize_word(raw).lower() for raw in text.split()) if word]


def timed_shots(board: dict, narration: Narration) -> tuple[list[Shot], list[str]]:
    problems = []
    starts: list[float] = []
    line_words = {line["line"]: [word for word in narration.words if word.line == line["line"]] for line in narration.lines}
    previous_line, cursor = None, 0
    for position, shot in enumerate(board["shots"]):
        label = f"shot {shot.get('id', position + 1)}"
        words = line_words.get(shot.get("line"))
        if words is None:
            problems.append(f"{label} names line {shot.get('line')}, which the narration does not have")
            continue
        if previous_line is not None and shot["line"] < previous_line:
            problems.append(f"{label} is on line {shot['line']} after a shot on line {previous_line}; shots follow the narration in order")
            continue
        begin = cursor + 1 if shot["line"] == previous_line else 0
        index = _find(comparable(str(shot.get("from", ""))), [" ".join(comparable(word.text)) for word in words], begin)
        if index is None:
            spoken = " ".join(word.text for word in words[begin:])
            problems.append(f'{label}: "{shot.get("from")}" is not in line {shot["line"]} after the previous cut; copy the shot\'s first few words exactly from: {spoken}')
            continue
        if position == 0:
            if shot["line"] != narration.lines[0]["line"] or index != 0:
                problems.append(f"{label} is the first shot, so it starts on the first words of line {narration.lines[0]['line']}")
            starts.append(0.0)
        else:
            earliest = words[index - 1].end if index else _end_of_line_before(narration, shot["line"])
            starts.append(round(max(earliest, words[index].start - CUT_BEFORE_WORD), 3))
        previous_line, cursor = shot["line"], index
    if problems:
        return [], problems
    ends = starts[1:] + [narration.duration]
    shots = [
        Shot(shot["id"], start, end, [word for word in narration.words if start <= word.start < end], shot)
        for shot, start, end in zip(board["shots"], starts, ends, strict=True)
    ]
    return shots, []


def _find(phrase: list[str], words: list[str], begin: int) -> int | None:
    return next((start for start in range(begin, len(words) - len(phrase) + 1) if phrase and words[start : start + len(phrase)] == phrase), None)


def _end_of_line_before(narration: Narration, line: int) -> float:
    before = [word.end for word in narration.words if word.line < line]
    return before[-1] if before else 0.0


def storyboard_problems(board: dict, narration: Narration) -> list[str]:
    sets, roles, shots = board.get("sets"), board.get("cast"), board.get("shots")
    if not all(isinstance(entries, list) and entries and all(isinstance(entry, dict) for entry in entries) for entries in (sets, roles, shots)):
        return ['the storyboard needs "sets", "cast" and "shots", each a list of objects']
    if not all(isinstance(member, dict) for shot in shots for member in shot.get("cast", [])):
        return ['each shot\'s "cast" is a list of {"role": ..., "look": ...} objects']
    problems = []
    set_ids = [entry.get("id") for entry in sets]
    looks = {role.get("id"): [look.get("id") for look in role.get("looks", [])] for role in roles}
    problems += [f'set "{name}" is listed {count} times' for name, count in Counter(set_ids).items() if count > 1]
    problems += [f'role "{name}" is listed {count} times' for name, count in Counter(role.get("id") for role in roles).items() if count > 1]
    problems += [f'role "{role}" needs at least one look' for role, role_looks in looks.items() if not role_looks]
    if len(sets) > MOST_SETS:
        problems.append(f"the storyboard builds {len(sets)} sets; reuse places and build at most {MOST_SETS}")
    problems += [f'shot id "{name}" is used {count} times' for name, count in Counter(shot.get("id") for shot in shots).items() if count > 1]

    seen_sets: set[str] = set()
    for shot in shots:
        label = f"shot {shot.get('id')}"
        if shot.get("set") not in set_ids:
            problems.append(f'{label} is on set "{shot.get("set")}"; the sets are {", ".join(map(str, set_ids))}')
        elif shot["set"] not in seen_sets:
            seen_sets.add(shot["set"])
            if shot.get("size") != "wide":
                problems.append(f'{label} is the first shot on set "{shot["set"]}", so it is a wide shot that shows the place')
        if shot.get("size") not in SIZES:
            problems.append(f"{label} needs a size, one of {', '.join(SIZES)}")
        cast_roles = []
        for member in shot.get("cast", []):
            role, look = member.get("role"), member.get("look")
            if role not in looks:
                problems.append(f'{label} casts "{role}", which the cast list lacks')
                continue
            cast_roles.append(role)
            if look is None and len(looks[role]) > 1:
                problems.append(f'{label} casts "{role}" without a look; choose one of {", ".join(looks[role])}')
            elif look is not None and look not in looks[role]:
                problems.append(f'{label} dresses "{role}" in look "{look}"; the role\'s looks are {", ".join(looks[role])}')
        subject = shot.get("subject", [])
        if not isinstance(subject, list) or len(subject) > MOST_SUBJECTS:
            problems.append(f"{label}: subject is a list of at most {MOST_SUBJECTS} roles")
        else:
            problems += [f'{label}: subject "{role}" is not in the shot\'s cast' for role in subject if role not in cast_roles]
            if not subject and shot.get("size") != "wide":
                problems.append(f"{label} has no subject; only a wide shot may be about a place rather than a person")
        problems += [f"{label} needs {field}" for field in ("action", "camera", "shows") if not str(shot.get(field, "")).strip()]
    problems += [f'set "{name}" is never used' for name in set_ids if name not in seen_sets]
    used_roles = {member.get("role") for shot in shots for member in shot.get("cast", [])}
    problems += [f'role "{name}" is never cast' for name in looks if name not in used_roles]

    timed, timing_problems = timed_shots(board, narration)
    problems += timing_problems
    low, high = SHOT_SECONDS
    problems += [
        f"shot {shot.id} runs {shot.seconds:.1f} s ({' '.join(word.text for word in shot.words[:8])} ...); a shot runs {low:g} to {high:g} s, so {'move its cut' if shot.seconds < low else 'cut it in two'}"
        for shot in timed
        if not low <= shot.seconds <= high
    ]
    return problems


def narration_table(narration: Narration) -> str:
    return "\n".join(f"line {line['line']} ({line['end'] - line['start']:.1f} s): {line['say']}" for line in narration.lines)


async def storyboard(services: Services, workspace: Workspace) -> dict:
    narration = Narration.read(workspace)
    script = workspace.read("script")
    question = prompt(
        "storyboard",
        brief=json.dumps(workspace.brief(), indent=1, ensure_ascii=False),
        armature=script["armature"],
        people=json.dumps(script["people"], indent=1, ensure_ascii=False),
        beats="\n".join(f"line {scene['n']}: {scene['beat']}" for scene in script["scenes"]),
        narration=narration_table(narration),
        research=json.dumps(workspace.read("research"), indent=1, ensure_ascii=False),
        shortest=f"{SHOT_SECONDS[0]:g}",
        longest=f"{SHOT_SECONDS[1]:g}",
        most_sets=str(MOST_SETS),
    )
    board = await answer(services, workspace, "storyboard", Job.FILM_STORYBOARD, question, lambda board: storyboard_problems(board, narration))
    workspace.write("storyboard.json", board)
    return board


def read_shots(workspace: Workspace) -> list[Shot]:
    shots, problems = timed_shots(workspace.read("storyboard"), Narration.read(workspace))
    if problems:
        raise FilmError("the storyboard no longer fits the narration; run the storyboard stage again:\n" + "\n".join(f"- {problem}" for problem in problems))
    return shots
