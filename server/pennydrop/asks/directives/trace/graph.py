from __future__ import annotations

from typing import Any

from .._support import DirectiveError, TracedRun
from ._stages import Window, node_turns

MARKERS = ("visit", "push", "pop", "relax")
SIDES = ("left", "right")

OPERATIONS = frozenset({"visit", "push", "pop", "relax", "dist"})

LIBRARY = ("breadth_first_search", "depth_first_search", "dijkstra", "tree_preorder", "tree_inorder", "tree_postorder")

GUIDE = "\n".join([
    "The `graph` Lab plays a graph or tree traversal: nodes light up in the order the real run visits them.",
    "Name a library algorithm in `code` with its `input`, and write no traced code of your own: " + ", ".join(LIBRARY) + ".",
    'Set one object `{"lab":"graph"}` in the Step. The directive fills in `nodes`, `edges`, `root`, `directed`, `layout`, `frontier` and `distances` from the input, and writes every visit, push, pop and relax operation from the real run.',
    'BFS: `"trace": {"code": "breadth_first_search", "input": {"graph": {"A": ["B", "C"], "B": ["A", "D", "E"], "C": ["A", "F"], "D": ["B"], "E": ["B"], "F": ["C"]}, "start": "A"}}`',
    'DFS: `"trace": {"code": "depth_first_search", "input": {"graph": {"A": ["B", "C"], "B": ["A", "D"], "C": ["A", "E"], "D": ["B"], "E": ["C", "F"], "F": ["E"]}, "start": "A"}}`',
    'Dijkstra: `"trace": {"code": "dijkstra", "input": {"graph": {"A": [["B", 4], ["C", 1]], "B": [["A", 4], ["D", 1]], "C": [["A", 1], ["B", 2], ["D", 5]], "D": [["B", 1], ["C", 5]]}, "start": "A"}}`, with 4 or 5 nodes.',
    'In-order: `"trace": {"code": "tree_inorder", "input": {"tree": {"F": ["B", "G"], "B": ["A", "D"], "G": [null, "I"], "A": [null, null], "D": [null, null], "I": [null, null]}, "root": "F"}}`. Pre-order and post-order take the same input.',
    "Write no visit, push, pop or relax by hand, because a hand-written walk misses neighbors: tell the walk in stages with `until`, where one turn is one node taken, so each Step plays the nodes its narration names.",
    "The scene object has just `lab`, with no nodes or edges. Keep a graph to about 6 nodes and a tree to 7 nodes, because a Step plays at most 40 operations.",
])


def apply(step: dict[str, Any], object_id: str, run: TracedRun, window: Window) -> dict[str, Any]:
    graph = _structure(run.input)
    called = {event.function for event in run.trace.events if event.type == "call"}
    frontier = "heap" if "relax" in called else "queue" if "push" in called else None
    extras = {**({"frontier": frontier} if frontier else {}), **({"distances": True} if "relax" in called else {})}
    spec = {**step["scene"][object_id], **graph, **extras}
    return {
        **step,
        "scene": {**step["scene"], object_id: spec},
        "do": [*step.get("do", []), *window.of(operations_by_event(run, object_id))],
    }


def turns(run: TracedRun) -> list[int]:
    return node_turns(run)


def _structure(traced_input: Any) -> dict[str, Any]:
    if not isinstance(traced_input, dict):
        raise DirectiveError('trace directive: graph input must be an object like {"graph": {...}, "start": "A"} or {"tree": {...}, "root": "F"}')
    if "tree" in traced_input:
        return _tree(traced_input["tree"], traced_input.get("root"))
    if "graph" in traced_input:
        return _graph(traced_input["graph"], traced_input.get("start"))
    raise DirectiveError('trace directive: graph input needs a "graph" (node to list of neighbors) or a "tree" (node to [left, right])')


def _graph(adjacency: Any, start: Any) -> dict[str, Any]:
    if not isinstance(adjacency, dict) or not all(isinstance(neighbors, list) for neighbors in adjacency.values()):
        raise DirectiveError('trace directive: "graph" must map every node to the list of its neighbors')
    weights = {(str(node), str(_end(neighbor))): _weight(neighbor) for node, neighbors in adjacency.items() for neighbor in neighbors}
    links = set(weights)
    directed = any((to, source) not in links for source, to in links)
    edges = sorted(links if directed else {tuple(sorted(link)) for link in links}, key=lambda link: _order(adjacency, link))
    nodes = [str(node) for node in adjacency] + sorted({to for _, to in links} - {str(node) for node in adjacency})
    weighted = any(weight is not None for weight in weights.values())
    listed = [[*edge, weights.get(edge, weights.get(edge[::-1]))] if weighted else list(edge) for edge in edges]
    return {"nodes": nodes, "edges": listed, "directed": directed, "root": str(start if start is not None else nodes[0]), "layout": "layers"}


def _end(neighbor: Any) -> Any:
    return neighbor[0] if isinstance(neighbor, list) else neighbor


def _weight(neighbor: Any) -> Any:
    return neighbor[1] if isinstance(neighbor, list) and len(neighbor) > 1 else None


def _order(adjacency: dict[str, Any], link: tuple[str, str]) -> tuple[int, int]:
    names = [str(node) for node in adjacency]
    return tuple(names.index(end) if end in names else len(names) for end in link)


def _tree(children: Any, root: Any) -> dict[str, Any]:
    if not isinstance(children, dict) or not all(isinstance(pair, list) and len(pair) == 2 for pair in children.values()):
        raise DirectiveError('trace directive: "tree" must map every node to [left child, right child], with null for no child')
    edges = [[str(node), str(child), side] for node, pair in children.items() for child, side in zip(pair, SIDES) if child is not None]
    return {"nodes": [str(node) for node in children], "edges": edges, "directed": False, "root": str(root if root is not None else next(iter(children))), "layout": "tree"}


def operations_by_event(run: TracedRun, object_id: str) -> list[tuple[int, list[dict[str, Any]]]]:
    start = run.input.get("start") if isinstance(run.input, dict) else None
    relaxes = any(event.function == "relax" for event in run.trace.events if event.type == "call")
    found: list[tuple[int, list[dict[str, Any]]]] = [(-1, [{"op": "dist", "on": [object_id], "node": str(start), "value": 0}])] if relaxes and start is not None else []
    for position, event in enumerate(run.trace.events):
        if event.type == "call" and event.function in MARKERS:
            found.append((position, [_operation(event.function, event.arguments, object_id)]))
    return found


def _operation(function: str, arguments: dict[str, Any], object_id: str) -> dict[str, Any]:
    on = [object_id]
    if function == "relax":
        return {"op": "relax", "on": on, "from": str(arguments["source"]), "to": str(arguments["target"]), "dist": arguments["distance"]}
    key = {"key": arguments["key"]} if "key" in arguments else {}
    return {"op": function, "on": on, "node": str(arguments["node"]), **key}
