from __future__ import annotations

import re
from typing import Any

from ..tracer import ALGORITHMS
from .directives.trace.code import shown_source
from .stage import Stage, answer_given_away

NUMBER_WORDS = {
    word: str(number)
    for number, word in enumerate(
        "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split()
    )
}
NUMBER_WITH_COMMAS = re.compile(r"^-?\d{1,3}(,\d{3})+(\.\d+)?$|^-?\d+(\.\d+)?$")


def mended(step: dict[str, Any], stage: Stage) -> dict[str, Any]:
    step = _with_trace_out_of_scene(step)
    step = _without_unchanged_restates(step, stage)
    step = _with_numeric_answer(step)
    step = _without_the_answer_said(step, stage)
    return _with_every_send_settled(_with_library_listing(step), stage.in_flight)


def mended_cues(step: dict[str, Any]) -> dict[str, Any]:
    say = step.get("say")
    operations = step.get("do")
    if not isinstance(say, str) or not isinstance(operations, list):
        return step
    words = say.split()
    spoken = [_plain(word) for word in words]
    exact = [_with_exact_cue(operation, words, spoken) for operation in operations]
    spoken_forms = [_spoken_form(word) for word in words]
    return {**step, "do": _without_cues_heard_too_early(_in_spoken_order(exact, spoken_forms), spoken_forms)}


def _spoken_form(word: str) -> str:
    return "".join(character for character in word.lower() if character.isalnum())


def _cue_words(operation: Any) -> list[str] | None:
    cue = operation.get("cue") if isinstance(operation, dict) else None
    return [word for word in map(_spoken_form, cue.split()) if word] if isinstance(cue, str) else None


def _found_at(spoken: list[str], wanted: list[str], start: int) -> int | None:
    return next((at for at in range(start, len(spoken) - len(wanted) + 1) if spoken[at : at + len(wanted)] == wanted), None) if wanted else None


def _cues_resolved(operations: list[Any], spoken: list[str]) -> list[bool]:
    resolved = []
    previous: tuple[int, int, list[str]] | None = None
    for operation in operations:
        wanted = _cue_words(operation)
        if wanted is None:
            resolved.append(True)
            continue
        start = 0 if previous is None else previous[0] if wanted == previous[2] else previous[1]
        at = _found_at(spoken, wanted, start)
        resolved.append(at is not None)
        if at is not None:
            previous = (at, at + len(wanted), wanted)
    return resolved


def _every_cue_resolves(operations: list[Any], spoken: list[str]) -> bool:
    return all(_cues_resolved(operations, spoken))


def _without_cues_heard_too_early(operations: list[Any], spoken: list[str]) -> list[Any]:
    def heard_earlier(operation: Any) -> bool:
        return _found_at(spoken, _cue_words(operation) or [], 0) is not None

    return [
        operation if resolved or not heard_earlier(operation) else {key: value for key, value in operation.items() if key != "cue"}
        for operation, resolved in zip(operations, _cues_resolved(operations, spoken), strict=True)
    ]


def _in_spoken_order(operations: list[Any], spoken: list[str]) -> list[Any]:
    if _every_cue_resolves(operations, spoken):
        return operations
    groups: list[list[Any]] = []
    for operation in operations:
        if groups and _cue_words(operation) is None:
            groups[-1].append(operation)
        else:
            groups.append([operation])
    heard = [None if (wanted := _cue_words(group[0])) is None else _found_at(spoken, wanted, 0) for group in groups]
    if any(at is None for at, group in zip(heard, groups, strict=True) if _cue_words(group[0]) is not None):
        return operations
    order = sorted(range(len(groups)), key=lambda index: (-1 if heard[index] is None else heard[index], index))
    targets = [_group_targets(group) for group in groups]
    for later, earlier in ((later, earlier) for position, later in enumerate(order) for earlier in order[position + 1 :] if earlier < later):
        if not targets[later] or not targets[earlier] or targets[later] & targets[earlier]:
            return operations
    reordered = [operation for index in order for operation in groups[index]]
    return reordered if _every_cue_resolves(reordered, spoken) else operations


def _group_targets(group: list[Any]) -> set[str]:
    return {re.split(r"[\[.]", str(name))[0] for operation in group if isinstance(operation, dict) for name in operation.get("on") or []}


def _without_unchanged_restates(step: dict[str, Any], stage: Stage) -> dict[str, Any]:
    scene = step.get("scene")
    if not isinstance(scene, dict):
        return step
    worked_on = {name for operation in step.get("do", []) if isinstance(operation, dict) for name in operation.get("on", []) if isinstance(name, str)}
    kept = {name: spec for name, spec in scene.items() if not (isinstance(spec, dict) and stage.specs.get(name) == spec and name not in worked_on)}
    if len(kept) == len(scene):
        return step
    return {key: value for key, value in {**step, "scene": kept}.items() if key != "scene" or kept}


def _with_numeric_answer(step: dict[str, Any]) -> dict[str, Any]:
    challenge = step.get("challenge")
    if not (isinstance(challenge, dict) and challenge.get("type") == "number" and isinstance(challenge.get("answer"), str)):
        return step
    text = challenge["answer"].strip()
    if not NUMBER_WITH_COMMAS.match(text):
        return step
    number = float(text.replace(",", ""))
    return {**step, "challenge": {**challenge, "answer": int(number) if number.is_integer() else number}}


def _with_library_listing(step: dict[str, Any]) -> dict[str, Any]:
    scene = step.get("scene")
    if not isinstance(scene, dict):
        return step
    return {**step, "scene": {name: _library_name_for(spec) for name, spec in scene.items()}}


def _library_name_for(spec: Any) -> Any:
    if not (isinstance(spec, dict) and spec.get("lab") == "code" and isinstance(spec.get("source"), str)):
        return spec
    for algorithm in ALGORITHMS.values():
        if _lists(spec["source"], algorithm) and spec["source"].strip() != shown_source(algorithm.source).strip():
            return {key: value for key, value in spec.items() if key != "vars"} | {"source": algorithm.name}
    return spec


def _lists(source: str, algorithm: Any) -> bool:
    defined = {re.sub(r"\W", "", name.lower()) for name in re.findall(r"def\s+(\w+)\s*\(", source)}
    return bool(defined & {re.sub(r"\W", "", algorithm.entry.lower()), re.sub(r"\W", "", algorithm.name.lower())})


def _with_every_send_settled(step: dict[str, Any], pending: set[str]) -> dict[str, Any]:
    operations = step.get("do")
    if not isinstance(operations, list):
        return step
    in_flight = set(pending)
    settled: list[Any] = []
    for operation in operations:
        targets = operation.get("on") if isinstance(operation, dict) else None
        name = targets[0] if isinstance(targets, list) and len(targets) == 1 and isinstance(targets[0], str) else None
        if name is not None and operation["op"] == "send":
            if name in in_flight:
                settled.append({"op": "receive", "on": [name]})
            in_flight.add(name)
        elif name is not None and operation["op"] in ("receive", "drop"):
            in_flight.discard(name)
        settled.append(operation)
    return {**step, "do": settled}


def _plain(word: str) -> str:
    plain = re.sub(r"[^\w]", "", word.lower())
    return NUMBER_WORDS.get(plain, plain)


def _with_exact_cue(operation: Any, words: list[str], spoken: list[str]) -> Any:
    cue = operation.get("cue") if isinstance(operation, dict) else None
    if not isinstance(cue, str):
        return operation
    wanted = [_plain(word) for word in cue.split() if _plain(word)]
    if not wanted:
        return operation
    exact = [re.sub(r"[^\w]", "", word.lower()) for word in cue.split()]
    spoken_exact = [re.sub(r"[^\w]", "", word.lower()) for word in words]
    if _spans(spoken_exact, [word for word in exact if word]):
        return operation
    found = _spans(spoken, wanted)
    if len(found) == 0:
        found = _closest_span(spoken, wanted)
    if len(found) != 1:
        return operation
    return {**operation, "cue": " ".join(words[found[0] : found[0] + len(wanted)])}


def _closest_span(spoken: list[str], wanted: list[str]) -> list[int]:
    scores = {
        start: sum(_same_stem(heard, word) for heard, word in zip(spoken[start : start + len(wanted)], wanted, strict=True))
        for start in range(len(spoken) - len(wanted) + 1)
    }
    best = max(scores.values(), default=0)
    return [start for start, score in scores.items() if score == best] if best * 2 >= len(wanted) and best > 0 else []


def _same_stem(heard: str, word: str) -> bool:
    return heard == word or (min(len(heard), len(word)) >= 4 and heard[:4] == word[:4])


def _spans(spoken: list[str], wanted: list[str]) -> list[int]:
    return [start for start in range(len(spoken) - len(wanted) + 1) if spoken[start : start + len(wanted)] == wanted]


CROWDED_STAGE = re.compile(r"too much on stage: (?P<names>[\w, ]+?) fit only")
UNKNOWN_OBJECT = re.compile(r'unknown object "(?P<name>[^"]+)"; objects in the Scene')


REDUNDANT_OPERATION = re.compile(r"do\[(?P<index>\d+)\] \w+: \w+: (?:the TLB was already looked up|all \d+ levels are walked)")


def mended_by_verdict(step: dict[str, Any], errors: list[str], stage: Stage) -> dict[str, Any] | None:
    fixed = _with_room_made(step, errors)
    fixed = _with_retired_objects(fixed or step, errors, stage) or fixed
    fixed = _without_operations_on_missing(fixed or step, errors) or fixed
    fixed = _without_redundant_operations(fixed or step, errors) or fixed
    fixed = _with_rewritten_operations(fixed or step, errors) or fixed
    return fixed


def _with_retired_objects(step: dict[str, Any], errors: list[str], stage: Stage) -> dict[str, Any] | None:
    missing = {found["name"] for error in errors if (found := UNKNOWN_OBJECT.search(error))}
    brought_back = {name: stage.retired[name] for name in missing if name in stage.retired}
    if not brought_back:
        return None
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    return {**step, "scene": {**scene, **brought_back}}


def _without_redundant_operations(step: dict[str, Any], errors: list[str]) -> dict[str, Any] | None:
    operations = step.get("do")
    redundant = {int(found["index"]) for error in errors if (found := REDUNDANT_OPERATION.search(error))}
    if not redundant or not isinstance(operations, list):
        return None
    return {**step, "do": [operation for index, operation in enumerate(operations) if index not in redundant]}


def _with_room_made(step: dict[str, Any], errors: list[str]) -> dict[str, Any] | None:
    crowded = next((found for error in errors if (found := CROWDED_STAGE.search(error))), None)
    if crowded is None:
        return None
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    worked_on = {name.split("[")[0] for operation in step.get("do", []) if isinstance(operation, dict) for name in operation.get("on", []) if isinstance(name, str)}
    names = crowded["names"].split(", ")
    idle = [name for name in names if name not in worked_on and scene.get(name) is None]
    if idle:
        return {**step, "scene": {**scene, **dict.fromkeys(idle)}}
    def touches(operation: Any, name: str) -> bool:
        return isinstance(operation, dict) and any(str(target).split("[")[0] == name for target in operation.get("on", []))

    weight = {name: sum(1 for operation in step.get("do", []) if touches(operation, name)) for name in names}
    least = min(names, key=lambda name: weight[name])
    if len(names) < 2 or weight[least] == max(weight.values()):
        return None
    return {**step, "scene": {**scene, least: None}, "do": [operation for operation in step.get("do", []) if not touches(operation, least)]}


def _without_operations_on_missing(step: dict[str, Any], errors: list[str]) -> dict[str, Any] | None:
    missing = {found["name"] for error in errors if (found := UNKNOWN_OBJECT.search(error))}
    operations = step.get("do")
    if not missing or not isinstance(operations, list):
        return None
    kept = [operation for operation in operations if not (isinstance(operation, dict) and any(str(name).split("[")[0] in missing for name in operation.get("on", [])))]
    return {**step, "do": kept} if len(kept) < len(operations) else None


def _without_the_answer_said(step: dict[str, Any], stage: Stage) -> dict[str, Any]:
    say = step.get("say")
    if not isinstance(say, str) or not answer_given_away(step):
        return step
    sentences = re.findall(r"[^.?!]+[.?!]*\s*", say)
    kept = [sentence for sentence in sentences if not answer_given_away({**step, "say": sentence, "scene": None})]
    if not kept or len(kept) == len(sentences):
        return step
    return {**step, "say": "".join(kept).strip()}


OPERATION_ERROR = re.compile(r"do\[(?P<index>\d+)\] (?P<op>\w+): (?P<message>.*)")
LOCK_AGREEMENT = {"acquire": ("block", "use \"block\""), "block": ("acquire", "use \"acquire\"")}


def _with_rewritten_operations(step: dict[str, Any], errors: list[str]) -> dict[str, Any] | None:
    operations = step.get("do")
    if not isinstance(operations, list):
        return None
    rewritten = list(operations)
    dropped: set[int] = set()
    for error in errors:
        found = OPERATION_ERROR.search(error)
        if not found or int(found["index"]) >= len(operations):
            continue
        index, message = int(found["index"]), found["message"]
        operation = operations[index]
        agreed = LOCK_AGREEMENT.get(found["op"])
        if agreed and agreed[1] in message:
            rewritten[index] = {**operation, "op": agreed[0]}
        elif found["op"] == "compare" and "needs exactly two cells" in message:
            rewritten[index] = {**operation, "op": "highlight"}
        elif found["op"] == "release" and ("cannot" in message or "only the owner" in message):
            dropped.add(index)
        elif "is out of range" in message and found["op"] in ("mark", "line"):
            dropped.add(index)
    if rewritten == operations and not dropped:
        return None
    return {**step, "do": [operation for index, operation in enumerate(rewritten) if index not in dropped]}


def _with_trace_out_of_scene(step: dict[str, Any]) -> dict[str, Any]:
    scene = step.get("scene")
    inside = scene.get("trace") if isinstance(scene, dict) else None
    if not isinstance(inside, dict) or "trace" in step or not {"code", "input"} <= inside.keys() or {"lab", "kind"} & inside.keys():
        return step
    kept = {name: spec for name, spec in scene.items() if name != "trace"}
    return {**{key: value for key, value in step.items() if key != "scene"}, **({"scene": kept} if kept else {}), "trace": inside}
