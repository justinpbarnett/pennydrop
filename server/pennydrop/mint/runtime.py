from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ..asks.validator import Validator, ValidatorError
from ..store import LessonRecord, LessonSource, Store
from ..tether import lifeline, tethered_argv
from .paths import MintPaths

ALLOWED_ASSET_LICENSES = ("MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC0-1.0", "CC-BY-4.0", "CC-BY-3.0", "OFL-1.1", "Unlicense")
PACKAGE_IMPORT = re.compile(r"""(?:^\s*(?:import|export)\b[^;"'`]*?\bfrom\s+|\bimport\s*\(\s*)["']([^./"'][^"']*)["']""", re.MULTILINE)


class MintError(RuntimeError):
    pass


def example_lesson_id(lab_id: str) -> str:
    return f"{lab_id}-example"


def install(paths: MintPaths, store: Store, validator: Validator, lab_id: str, workspace: Path) -> None:
    paths.minted.mkdir(parents=True, exist_ok=True)
    kept = {file: file.read_bytes() for file in (paths.minted_source(lab_id), paths.example_lesson(lab_id), paths.minted_build(lab_id)) if file.is_file()}
    try:
        shutil.copy(workspace / "src" / "labs" / f"{lab_id}.ts", paths.minted_source(lab_id))
        shutil.copy(workspace / "lesson.jsonl", paths.example_lesson(lab_id))
        own_assets = workspace / "src" / "labs" / "assets" / lab_id
        if own_assets.is_dir():
            shutil.copytree(own_assets, paths.minted / "assets" / lab_id, dirs_exist_ok=True)
        build(paths, lab_id)
        verify(paths, store, validator, lab_id)
    except MintError:
        for file in (paths.minted_source(lab_id), paths.example_lesson(lab_id), paths.minted_build(lab_id)):
            if file in kept:
                file.write_bytes(kept[file])
            else:
                file.unlink(missing_ok=True)
        raise
    _save_example_lesson(store, lab_id, paths.example_lesson(lab_id))


def verify(paths: MintPaths, store: Store, validator: Validator, lab_id: str) -> None:
    catalog = _run_tool(paths, "catalog.ts")
    if catalog.returncode != 0:
        raise MintError(f"the catalog tool crashes with the Lab '{lab_id}' in place, so it is refused: {_tail(catalog)}")
    entry = next((lab for lab in json.loads(catalog.stdout)["labs"] if lab["id"] == lab_id), None)
    if entry is None or not isinstance(entry.get("ops"), dict) or not entry["ops"]:
        raise MintError(f"the Lab '{lab_id}' has no catalog.ops in the catalog, so it is refused; every op must be in the Lab's ops table")
    markdown = _run_tool(paths, "catalog.ts", "--md")
    if markdown.returncode != 0:
        raise MintError(f"`catalog.ts --md` crashes with the Lab '{lab_id}' in place, so it is refused: {_tail(markdown)}")
    broken = _failed_replays(validator, store, lab_id)
    if broken:
        raise MintError(f"the Lab '{lab_id}' breaks stored Lessons that use it, so it is refused: {'; '.join(broken)}")


def _failed_replays(validator: Validator, store: Store, lab_id: str) -> list[str]:
    lessons = [lesson for lesson in store.lessons_using_lab(lab_id) if lesson.id != example_lesson_id(lab_id)]

    async def replay_all() -> list[str]:
        broken = []
        try:
            for lesson in lessons:
                try:
                    replay = await validator.replay(store.steps(lesson.id), reading=lesson.header.get("reading") is not False)
                except ValidatorError as error:
                    broken.append(f"{lesson.id}: {error}"[:600])
                    continue
                if replay.skipped:
                    broken.append(f"{lesson.id}: the player now skips {'; '.join(replay.skipped)}"[:600])
        finally:
            await validator.close()
        return broken

    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, replay_all()).result()


def _run_tool(paths: MintPaths, tool: str, *arguments: str) -> subprocess.CompletedProcess[str]:
    with lifeline() as stdin:
        return subprocess.run(tethered_argv(["bun", str(paths.tools / tool), *arguments]), stdin=stdin, capture_output=True, text=True, cwd=paths.player)


def _problems(result: subprocess.CompletedProcess[str]) -> list[str]:
    return [line for line in (result.stderr or result.stdout).strip().splitlines() if line.strip() and not re.match(r"^step \d+: ok$", line)]


def _tail(result: subprocess.CompletedProcess[str]) -> str:
    return " | ".join(_problems(result)[-4:])[-600:]

PRETTIER = "prettier@3.3.3"
PRETTIER_OPTIONS = ["--print-width=200", "--trailing-comma=all"]


def format_source(paths: MintPaths, source: Path) -> None:
    result = subprocess.run(["bunx", PRETTIER, *PRETTIER_OPTIONS, "--write", str(source)], capture_output=True, text=True, cwd=paths.player)
    if result.returncode != 0:
        raise MintError(f"prettier could not format {source.name}: {(result.stderr or result.stdout).strip()[-400:]}")


def build(paths: MintPaths, lab_id: str) -> None:
    with lifeline() as stdin:
        result = subprocess.run(
            tethered_argv(["bun", str(paths.tools / "mint-build.ts"), str(paths.minted_source(lab_id)), str(paths.minted_build(lab_id))]),
            stdin=stdin, capture_output=True, text=True, cwd=paths.player,
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


def promote(paths: MintPaths, store: Store, validator: Validator, lab_id: str) -> list[str]:
    source = paths.minted_source(lab_id)
    if not source.is_file():
        raise LookupError(f"no accepted minted Lab '{lab_id}' in {paths.minted}; `pd mint list` shows what exists")
    target = paths.labs / f"{lab_id}.ts"
    if target.exists():
        raise MintError(f"{target} already exists; remove or rename it before promoting '{lab_id}'")
    assets_destination = paths.labs / "assets" / lab_id
    assets_existed = assets_destination.exists()
    notes = _promote_assets(paths, lab_id)
    shutil.copy(source, target)
    try:
        format_source(paths, target)
        verify(paths, store, validator, lab_id)
    except MintError:
        target.unlink(missing_ok=True)
        if not assets_existed:
            shutil.rmtree(assets_destination, ignore_errors=True)
        raise
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
    assets = paths.workspace(lab_id) / "src" / "labs" / "assets" / lab_id
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
