from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from ..store import LessonRecord, LessonSource, Store
from .paths import MintPaths

ALLOWED_ASSET_LICENSES = ("MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC0-1.0", "CC-BY-4.0", "CC-BY-3.0", "OFL-1.1", "Unlicense")
PACKAGE_IMPORT = re.compile(r"""(?:from\s+|import\s*\(\s*)["']([^./"'][^"']*)["']""")


class MintError(RuntimeError):
    pass


def example_lesson_id(lab_id: str) -> str:
    return f"{lab_id}-example"


def install(paths: MintPaths, store: Store, lab_id: str, workspace: Path) -> None:
    paths.minted.mkdir(parents=True, exist_ok=True)
    shutil.copy(workspace / "src" / "labs" / f"{lab_id}.ts", paths.minted_source(lab_id))
    shutil.copy(workspace / "lesson.jsonl", paths.example_lesson(lab_id))
    build(paths, lab_id)
    _save_example_lesson(store, lab_id, paths.example_lesson(lab_id))


def build(paths: MintPaths, lab_id: str) -> None:
    result = subprocess.run(
        ["bun", str(paths.tools / "mint-build.ts"), str(paths.minted_source(lab_id)), str(paths.minted_build(lab_id))],
        capture_output=True, text=True, cwd=paths.player,
    )
    if result.returncode != 0:
        raise MintError(f"building the minted Lab '{lab_id}' failed: {(result.stderr or result.stdout).strip()[-600:]}")


def _save_example_lesson(store: Store, lab_id: str, lesson_file: Path) -> None:
    lines = [json.loads(line) for line in lesson_file.read_text().splitlines() if line.strip()]
    header = lines[0]["lesson"]
    steps = [line for line in lines[1:] if "step" in line]
    lesson_id = example_lesson_id(lab_id)
    store.delete_lesson(lesson_id)
    store.save_lesson(LessonRecord(lesson_id, "", header.get("title", lesson_id), header.get("labs", [lab_id]), LessonSource.HAND, header=header))
    for step in steps:
        store.save_step(lesson_id, step["step"], step)


def promote(paths: MintPaths, store: Store, lab_id: str) -> list[str]:
    source = paths.minted_source(lab_id)
    if not source.is_file():
        raise LookupError(f"no accepted minted Lab '{lab_id}' in {paths.minted}; `pd mint list` shows what exists")
    target = paths.labs / f"{lab_id}.ts"
    if target.exists():
        raise MintError(f"{target} already exists; remove or rename it before promoting '{lab_id}'")
    notes = _promote_assets(paths, lab_id)
    shutil.copy(source, target)
    lesson_target = paths.lessons / f"{example_lesson_id(lab_id)}.jsonl"
    shutil.copy(paths.example_lesson(lab_id), lesson_target)
    paths.minted_build(lab_id).unlink(missing_ok=True)
    source.unlink()
    paths.example_lesson(lab_id).unlink(missing_ok=True)
    store.delete_lesson(example_lesson_id(lab_id))
    packages = sorted({match for match in PACKAGE_IMPORT.findall(target.read_text())})
    notes += [f"copied {source.name} to {target}", f"copied the example Lesson to {lesson_target}"]
    notes += [f"the Lab imports the npm package '{package}': add it to player/package.json before building" for package in packages]
    return notes


def _promote_assets(paths: MintPaths, lab_id: str) -> list[str]:
    assets = paths.workspace(lab_id) / "assets"
    if not assets.is_dir():
        return []
    license_file = next(iter(sorted(assets.glob("LICENSE*"))), None)
    declared = license_file.read_text().strip().splitlines()[0].strip() if license_file else ""
    if declared not in ALLOWED_ASSET_LICENSES:
        raise MintError(
            f"the Lab '{lab_id}' carries assets in {assets} but their license is "
            f"{declared!r}; promotion copies assets only under {', '.join(ALLOWED_ASSET_LICENSES)}, "
            f"given as the first line of {assets}/LICENSE"
        )
    destination = paths.labs / "assets" / lab_id
    shutil.copytree(assets, destination, dirs_exist_ok=True)
    return [f"copied assets ({declared}) to {destination}"]
