from __future__ import annotations

from typing import Any

from .._support import DirectiveError, TracedRun

MARKERS = ("visit", "push", "pop")
SIDES = ("left", "right")

GUIDE = "\n".join([
    "The `graph` Lab plays a graph or tree traversal: nodes light up in the order the real run visits them.",
    'Set one object `{"lab":"graph"}` in the Step. The directive fills in `nodes`, `edges`, `root`, `directed`, `layout` and `frontier` from the traced input, and writes every `visit`, `push` and `pop` operation from the real run.',
    'Graph input: `{"graph": {"A": ["B", "C"], "B": ["A", "D"]}, "start": "A"}`. Tree input: `{"tree": {"F": ["B", "G"], "B": [null, null]}, "root": "F"}` where each node maps to [left child, right child].',
    "Use `breadth_first_search` (a queue frontier), `depth_first_search` or `tree_preorder`, `tree_inorder` and `tree_postorder`. Your own traced code reports a step by calling `visit(node)`, `push(node)` or `pop(node)`.",
    "Keep it to 5 to 7 nodes, because a Step plays at most 40 operations.",
])


def apply(step: dict[str, Any], object_id: str, run: TracedRun) -> dict[str, Any]:
    graph = _structure(run.input)
    frontier = "queue" if any(event.type == "call" and event.function == "push" for event in run.trace.events) else None
    spec = {**step["scene"][object_id], **graph, **({"frontier": frontier} if frontier else {})}
    return {
        **step,
        "scene": {**step["scene"], object_id: spec},
        "do": [*step.get("do", []), *_operations(run, object_id)],
    }


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
    links = {(str(node), str(neighbor)) for node, neighbors in adjacency.items() for neighbor in neighbors}
    directed = any((to, source) not in links for source, to in links)
    edges = sorted(links if directed else {tuple(sorted(link)) for link in links}, key=lambda link: _order(adjacency, link))
    nodes = [str(node) for node in adjacency] + sorted({to for _, to in links} - {str(node) for node in adjacency})
    return {"nodes": nodes, "edges": [list(edge) for edge in edges], "directed": directed, "root": str(start if start is not None else nodes[0]), "layout": "layers"}


def _order(adjacency: dict[str, Any], link: tuple[str, str]) -> tuple[int, int]:
    names = [str(node) for node in adjacency]
    return tuple(names.index(end) if end in names else len(names) for end in link)


def _tree(children: Any, root: Any) -> dict[str, Any]:
    if not isinstance(children, dict) or not all(isinstance(pair, list) and len(pair) == 2 for pair in children.values()):
        raise DirectiveError('trace directive: "tree" must map every node to [left child, right child], with null for no child')
    edges = [[str(node), str(child), side] for node, pair in children.items() for child, side in zip(pair, SIDES) if child is not None]
    return {"nodes": [str(node) for node in children], "edges": edges, "directed": False, "root": str(root if root is not None else next(iter(children))), "layout": "tree"}


def _operations(run: TracedRun, object_id: str) -> list[dict[str, Any]]:
    return [
        {"op": event.function, "on": [object_id], "node": str(event.arguments["node"])}
        for event in run.trace.events
        if event.type == "call" and event.function in MARKERS
    ]
