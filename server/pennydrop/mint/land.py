from __future__ import annotations

import json
import urllib.request
from pathlib import Path

from .paths import MintPaths

SOURCE_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-50m.json"
LICENSE_TEXT = "CC0-1.0\nNatural Earth land polygons, 1:50m, public domain (naturalearthdata.com), via the world-atlas npm package, simplified to 0.03 degrees.\n"
MIN_STEP_DEGREES = 0.03
MIN_RING_POINTS = 4


def ensure_land(paths: MintPaths) -> Path:
    cached = paths.data / "mint" / "_land" / "land.json"
    if not cached.is_file():
        with urllib.request.urlopen(SOURCE_URL, timeout=60) as response:
            topology = json.load(response)
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps({"rings": _rings(topology)}, separators=(",", ":")))
    return cached


def install_land(paths: MintPaths, assets_directory: Path) -> None:
    assets_directory.mkdir(parents=True, exist_ok=True)
    (assets_directory / "land.json").write_bytes(ensure_land(paths).read_bytes())
    (assets_directory / "LICENSE").write_text(LICENSE_TEXT)


def _rings(topology: dict) -> list[list[list[float]]]:
    scale, translate = topology["transform"]["scale"], topology["transform"]["translate"]
    arcs = []
    for arc in topology["arcs"]:
        x = y = 0
        points = []
        for dx, dy in arc:
            x, y = x + dx, y + dy
            points.append((x * scale[0] + translate[0], y * scale[1] + translate[1]))
        arcs.append(points)

    def ring_points(indexes: list[int]) -> list[tuple[float, float]]:
        points: list[tuple[float, float]] = []
        for index in indexes:
            arc = arcs[index] if index >= 0 else arcs[~index][::-1]
            points.extend(arc if not points else arc[1:])
        return points

    rings = []
    land = topology["objects"]["land"]
    geometries = land["geometries"] if land["type"] == "GeometryCollection" else [land]
    for geometry in geometries:
        polygons = geometry["arcs"] if geometry["type"] == "MultiPolygon" else [geometry["arcs"]]
        for polygon in polygons:
            for indexes in polygon:
                simplified = _thin(ring_points(indexes))
                if len(simplified) >= MIN_RING_POINTS:
                    rings.append([[round(lon, 2), round(lat, 2)] for lon, lat in simplified])
    return rings


def _thin(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    kept = [points[0]]
    for point in points[1:-1]:
        if abs(point[0] - kept[-1][0]) >= MIN_STEP_DEGREES or abs(point[1] - kept[-1][1]) >= MIN_STEP_DEGREES:
            kept.append(point)
    kept.append(points[-1])
    return kept
