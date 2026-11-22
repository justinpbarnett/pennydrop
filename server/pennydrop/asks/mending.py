from __future__ import annotations

import json
import re
from typing import Any

from ..tracer import ALGORITHMS
from .directives._support import operation_targets
from .directives.simulate import filled_from
from .directives.trace.code import shown_source
from .played_hops import says_number
from .stage import FRONTIER_OPERATIONS, TRACE_TOTAL_PREFIX, Stage, answer_given_away

NUMBER_WORDS = {
    word: str(number)
    for number, word in enumerate(
        "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split()
    )
}
PROMISE_WORDS = 14
SENTENCE = re.compile(r"[^.!?]+[.!?]+")
NUMBER_WITH_COMMAS = re.compile(r"^-?\d{1,3}(,\d{3})+(\.\d+)?$|^-?\d+(\.\d+)?$")


def mended(step: dict[str, Any], stage: Stage) -> dict[str, Any]:
    step = _with_promise_alone(step)
    step = _with_trace_for_its_values(step, stage)
    step = _with_simulation_filled(step, stage)
    step = _with_trace_filled(step, stage)
    step = _with_hand_search_as_trace(step, stage)
    step = _without_unchanged_restates(step, stage)
    step = _with_numeric_answer(step)
    step = _with_tap_answer_on_its_node(step, stage)
    step = _without_the_answer_said(step, stage)
    step = _without_the_landing_said(step, stage)
    step = stage.setups.with_reveal_run(step)
    return _with_every_send_settled(_with_library_listing(step), stage.in_flight)


def _with_promise_alone(step: dict[str, Any]) -> dict[str, Any]:
    say = step.get("say")
    if step.get("step") != 1 or step.get("do") or not isinstance(say, str):
        return step
    question, *after = [sentence.strip() for sentence in SENTENCE.findall(say)] or [""]
    if not after or not question.endswith("?") or any(sentence.endswith("?") for sentence in after) or len(question.split()) > PROMISE_WORDS:
        return step
    return {**step, "say": question}


def with_one_figure_on_stage(step: dict[str, Any], stage: Stage) -> dict[str, Any]:
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    if not any(isinstance(spec, dict) and isinstance(spec.get("lab"), str) and name not in stage.labs for name, spec in scene.items()):
        return step
    leaving = {name: None for name in stage.on_stage() if name not in scene}
    return {**step, "scene": {**leaving, **scene}} if leaving else step


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
    kept = {name: spec for name, spec in scene.items() if not (isinstance(spec, dict) and (_part_of(spec, stage.specs.get(name)) or stage.specs.get(name) == spec and name not in worked_on))}
    if len(kept) == len(scene):
        return step
    return {key: value for key, value in {**step, "scene": kept}.items() if key != "scene" or kept}


def _part_of(spec: dict[str, Any], staged: Any) -> bool:
    return isinstance(staged, dict) and len(spec) < len(staged) and all(key in staged and staged[key] == value for key, value in spec.items())


def _with_numeric_answer(step: dict[str, Any]) -> dict[str, Any]:
    challenge = step.get("challenge")
    if not (isinstance(challenge, dict) and challenge.get("type") == "number" and isinstance(challenge.get("answer"), str)):
        return step
    text = challenge["answer"].strip()
    if not NUMBER_WITH_COMMAS.match(text):
        return step
    number = float(text.replace(",", ""))
    return {**step, "challenge": {**challenge, "answer": int(number) if number.is_integer() else number}}


def _with_tap_answer_on_its_node(step: dict[str, Any], stage: Stage) -> dict[str, Any]:
    challenge = step.get("challenge")
    if not (isinstance(challenge, dict) and challenge.get("type") == "click" and isinstance(challenge.get("answer"), str | list)):
        return step
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    nodes = {name: {str(node.get("id") if isinstance(node, dict) else node) for node in spec.get("nodes") or []} for name, spec in {**stage.on_stage(), **scene}.items() if isinstance(spec, dict)}

    def on_its_node(answer: Any) -> Any:
        holders = [name for name, held in nodes.items() if str(answer) in held] if isinstance(answer, str) and "[" not in answer else []
        return f"{holders[0]}[{answer}]" if len(holders) == 1 else answer

    answer = challenge["answer"]
    placed = [on_its_node(one) for one in answer] if isinstance(answer, list) else on_its_node(answer)
    return step if placed == answer else {**step, "challenge": {**challenge, "answer": placed}}


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
REMOVED_MISSING = re.compile(r'"(?P<name>[^"]+)": null takes an object off the stage, and "(?P=name)" is not on stage')


EMPTY_STAGE = "nothing is on stage when this Step ends"
REDUNDANT_OPERATION = re.compile(r'do\[(?P<index>\d+)\] (?:\w+: \w+: (?:the TLB was already looked up|all \d+ levels are walked)|trace: op "trace" draws on a line)')


def mended_by_verdict(step: dict[str, Any], errors: list[str], stage: Stage) -> dict[str, Any] | None:
    fixed = _with_room_made(step, errors)
    fixed = _with_retired_objects(fixed or step, errors, stage) or fixed
    fixed = _without_operations_on_missing(fixed or step, errors) or fixed
    fixed = _without_redundant_operations(fixed or step, errors) or fixed
    fixed = _with_rewritten_operations(fixed or step, errors) or fixed
    fixed = _with_stage_kept(fixed or step, errors) or fixed
    fixed = _without_removals_of_missing(fixed or step, errors) or fixed
    return fixed


def _without_removals_of_missing(step: dict[str, Any], errors: list[str]) -> dict[str, Any] | None:
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    missing = {found["name"] for error in errors if (found := REMOVED_MISSING.search(error))}
    if not any(name in scene and scene[name] is None for name in missing):
        return None
    return {**step, "scene": {name: spec for name, spec in scene.items() if not (name in missing and spec is None)}}


def _with_stage_kept(step: dict[str, Any], errors: list[str]) -> dict[str, Any] | None:
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    removed = [name for name, spec in scene.items() if spec is None]
    if not removed or not any(EMPTY_STAGE in error for error in errors):
        return None
    return {**step, "scene": {name: spec for name, spec in scene.items() if spec is not None}}


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
    if len(kept) == len(operations) or not (kept or step.get("scene") or "challenge" in step):
        return None
    return {**step, "do": kept}


def _without_the_answer_said(step: dict[str, Any], stage: Stage) -> dict[str, Any]:
    say = step.get("say")
    if not isinstance(say, str) or not answer_given_away(step):
        return step
    sentences = re.findall(r"[^.?!]+[.?!]*\s*", say)
    kept = [sentence for sentence in sentences if not answer_given_away({**step, "say": sentence, "scene": None})]
    if not kept or len(kept) == len(sentences):
        return step
    return {**step, "say": "".join(kept).strip()}


def _without_the_landing_said(step: dict[str, Any], stage: Stage) -> dict[str, Any]:
    landing = stage.hops.landing_told(step)
    if landing is None:
        return step
    sentences = re.findall(r"[^.?!]+[.?!]*\s*", step["say"])
    kept = [sentence for sentence in sentences if not says_number(landing, sentence)]
    return {**step, "say": "".join(kept).strip()} if kept else step


OPERATION_ERROR = re.compile(r"do\[(?P<index>\d+)\] (?P<op>\w+): (?P<message>.*)")
OPERATION_AGREEMENT = (
    ("acquire", 'use "block"', "block"),
    ("block", 'use "acquire"', "acquire"),
    ("hash", 'is already in the table; use "find"', "find"),
    ("probe", 'use "chain" instead', "chain"),
    ("chain", 'use "probe" instead', "probe"),
)
NOTHING_COLLIDED = re.compile(r'^op "(?:chain|probe)" on \w+: no key is waiting on a collision;')
KEY_STILL_WAITING = re.compile(r'still waits outside bucket \d+ after a collision; use "(?P<resolve>chain|probe)" first')


def _with_rewritten_operations(step: dict[str, Any], errors: list[str]) -> dict[str, Any] | None:
    operations = step.get("do")
    if not isinstance(operations, list):
        return None
    rewritten = list(operations)
    dropped: set[int] = set()
    resolving: dict[int, dict[str, Any]] = {}
    for error in errors:
        found = OPERATION_ERROR.search(error)
        if not found or int(found["index"]) >= len(operations):
            continue
        index, message = int(found["index"]), found["message"]
        operation = operations[index]
        agreed = next((becomes for name, fragment, becomes in OPERATION_AGREEMENT if name == found["op"] and fragment in message), None)
        if agreed:
            rewritten[index] = {**operation, "op": agreed}
        elif NOTHING_COLLIDED.search(message):
            dropped.add(index)
        elif waiting := KEY_STILL_WAITING.search(message):
            resolving[index] = {"op": waiting["resolve"], "on": operation["on"]}
        elif found["op"] == "compare" and "needs exactly two cells" in message:
            rewritten[index] = {**operation, "op": "highlight"}
        elif found["op"] == "release" and ("cannot" in message or "only the owner" in message):
            dropped.add(index)
        elif "is out of range" in message and found["op"] in ("mark", "line"):
            dropped.add(index)
    if rewritten == operations and not dropped and not resolving:
        return None
    mended_operations: list[Any] = []
    for index, operation in enumerate(rewritten):
        if index in resolving:
            mended_operations.append(resolving[index])
        if index not in dropped:
            mended_operations.append(operation)
    return {**step, "do": mended_operations}


def _with_trace_for_its_values(step: dict[str, Any], stage: Stage) -> dict[str, Any]:
    challenge = step.get("challenge") if isinstance(step.get("challenge"), dict) else {}
    answer = challenge.get("answer")
    names_values = "{" + TRACE_TOTAL_PREFIX in json.dumps(step) or (isinstance(answer, str) and answer.startswith(TRACE_TOTAL_PREFIX))
    if "trace" in step or "simulate" in step or not stage.last_trace or not names_values:
        return step
    return {**step, "trace": {**stage.last_trace, **({} if stage.trace_until is None else {"until": stage.trace_until})}}


def _with_trace_filled(step: dict[str, Any], stage: Stage) -> dict[str, Any]:
    raw = step.get("trace")
    filled = stage.filled_trace(raw)
    return step if filled is raw else {**step, "trace": filled}


def _with_hand_search_as_trace(step: dict[str, Any], stage: Stage) -> dict[str, Any]:
    if "trace" in step or "simulate" in step:
        return step
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    named = {name for name, lab in stage.labs.items() if lab == "graph"} | {name for name, spec in scene.items() if isinstance(spec, dict) and spec.get("lab") == "graph"}
    graphs = {name: {**stage.specs.get(name, {}), **(scene[name] if isinstance(scene.get(name), dict) else {})} for name in named}
    operations = [operation for operation in step.get("do") or [] if isinstance(operation, dict)]
    searched = {name for operation in operations if operation.get("op") in (*FRONTIER_OPERATIONS, "visit") for name in operation_targets(operation) if graphs.get(name, {}).get("frontier")}
    if len(searched) != 1:
        return step
    (name,) = searched
    if stage.last_trace:
        if stage.trace_until is None:
            return step
        trace, shown = {**stage.last_trace, "on": name}, stage.trace_until
    elif (inferred := _search_of(graphs[name])) is not None:
        trace, shown = {**inferred, "on": name}, 0
    else:
        return step
    mine = [operation for operation in operations if name in operation_targets(operation)]
    taken = sum(operation.get("op") == "pop" for operation in mine) or sum(operation.get("op") == "visit" for operation in mine)
    return {**step, "trace": {**trace, "until": shown + taken}}


def _search_of(spec: dict[str, Any]) -> dict[str, Any] | None:
    code = {"queue": "breadth_first_search", "heap": "dijkstra"}.get(spec.get("frontier"))
    nodes, edges = spec.get("nodes"), spec.get("edges")
    if code is None or not isinstance(nodes, list) or not isinstance(edges, list) or not nodes:
        return None
    names = [str(node.get("id") if isinstance(node, dict) else node) for node in nodes]
    adjacency: dict[str, list[Any]] = {node: [] for node in names}
    for edge in edges:
        if not isinstance(edge, list) or len(edge) < 2 or (code == "dijkstra" and len(edge) < 3):
            return None
        source, target = str(edge[0]), str(edge[1])
        for start, end in ((source, target), *(() if spec.get("directed") else ((target, source),))):
            adjacency.setdefault(start, []).append([end, edge[2]] if code == "dijkstra" else end)
    return {"code": code, "input": {"graph": adjacency, "start": str(spec.get("root") or names[0])}}


def _with_simulation_filled(step: dict[str, Any], stage: Stage) -> dict[str, Any]:
    raw = step.get("simulate")
    filled = filled_from(raw, {**_labs_drawn_in(step), **stage.simulations})
    return step if filled is raw else {**step, "simulate": filled}


def _labs_drawn_in(step: dict[str, Any]) -> dict[str, dict[str, Any]]:
    scene = step.get("scene") if isinstance(step.get("scene"), dict) else {}
    drawn = [spec for spec in scene.values() if isinstance(spec, dict) and isinstance(spec.get("lab"), str)]
    labs = [spec["lab"] for spec in drawn]
    return {spec["lab"]: spec for spec in drawn if labs.count(spec["lab"]) == 1}


