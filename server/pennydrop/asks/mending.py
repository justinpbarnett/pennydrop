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
    return {**step, "do": [_with_exact_cue(operation, words, spoken) for operation in operations]}


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
    idle = [name for name in crowded["names"].split(", ") if name not in worked_on and scene.get(name) is None]
    return {**step, "scene": {**scene, **dict.fromkeys(idle)}} if idle else None


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
