from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

from .land import install_land
from .paths import MintPaths
from .runtime import MintError

RULES_FILE = Path(__file__).with_name("RULES.md")
ROLES_FILE = Path(__file__).with_name("roles.md")
REFERENCE_FILES = ("smell-guide.md", "workflow.md")
SAMPLE_LESSON = "bubble-sort.jsonl"
LABS_WITH_LAND = ("map",)

CHECK_SCRIPT = """#!/bin/sh
cd "$(dirname "$0")" || exit 1
exec bun {tools}/mint-check.ts .
"""

TASK = """# Task: mint the "{lab_id}" Lab

{request}Read `RULES.md` first, and follow it exactly.
Then read the live player sources, which are the only truth about the contract: `{src}/lab.ts` (the Lab contract and its helpers), `{src}/labs/array.ts` and `{src}/labs/scheduler.ts` (exemplars of a good Lab and its catalog), `{src}/theme.ts` (the Theme roles) and `{src}/text-metrics.ts`.
Then read `reference/catalog.md` (every Lab as the writer sees it), `reference/roles.md`, `reference/code-standard.md`, `reference/smell-guide.md` and `reference/sample-lesson.jsonl`.

## What the Lab must teach and which ops it needs

{brief}

## Work

1. Write `src/labs/{lab_id}.ts` with `export const lab` and id `{lab_id}`.
2. Write `lesson.jsonl`, a short example Lesson of 3 to 6 Steps that uses the Lab and fires every op at least once.
3. Run `./check` and fix everything it reports until it prints `ok`.
   If the sandbox stops `./check` from running a stage, say so in your final message and still make the code correct by reading it carefully.
4. Reply with a few lines: the ops you gave the Lab, and anything you could not verify.

Touch only `src/labs/{lab_id}.ts` and `lesson.jsonl`.
"""


def require_references(paths: MintPaths) -> None:
    missing = [name for name in REFERENCE_FILES if not (paths.improve_references / name).is_file()]
    if missing:
        raise MintError(
            f"the code standard references {', '.join(missing)} are missing from {paths.improve_references}; "
            "set improve_references under [paths] in config.toml to the improve-codebase skill's references directory"
        )


def prepare(paths: MintPaths, lab_id: str, brief: str, ask: str | None) -> Path:
    workspace = paths.workspace(lab_id)
    (workspace / "src" / "labs").mkdir(parents=True, exist_ok=True)
    (workspace / "reference").mkdir(exist_ok=True)
    shutil.copy(RULES_FILE, workspace / "RULES.md")
    shutil.copy(ROLES_FILE, workspace / "reference" / "roles.md")
    shutil.copy(paths.lessons / SAMPLE_LESSON, workspace / "reference" / "sample-lesson.jsonl")
    shutil.copy(paths.improve_references / "smell-guide.md", workspace / "reference" / "smell-guide.md")
    (workspace / "reference" / "code-standard.md").write_text(_code_standard(paths))
    (workspace / "reference" / "catalog.md").write_text(_catalog(paths))
    (workspace / "tsconfig.json").write_text(json.dumps(_tsconfig(paths, workspace), indent=2))
    if lab_id in LABS_WITH_LAND:
        install_land(paths, workspace / "src" / "labs" / "assets" / lab_id)
    check = workspace / "check"
    check.write_text(CHECK_SCRIPT.format(tools=paths.tools))
    check.chmod(0o755)
    request = f"This Lab answers a request from a Lesson writer that no existing Lab could serve: {ask!r}.\n\n" if ask else ""
    (workspace / "TASK.md").write_text(TASK.format(lab_id=lab_id, brief=brief, request=request, src=paths.player / "src"))
    return workspace


def _tsconfig(paths: MintPaths, workspace: Path) -> dict:
    return {
        "extends": str(paths.player / "tsconfig.json"),
        "compilerOptions": {"rootDirs": [str(workspace / "src"), str(paths.player / "src")], "types": [], "noEmit": True, "resolveJsonModule": True},
        "include": [str(workspace / "src")],
    }


def _code_standard(paths: MintPaths) -> str:
    workflow = (paths.improve_references / "workflow.md").read_text()
    return (
        "# Code standard\n\n"
        "Write the Lab to the standard of the improve-codebase skill: deep modules, one home for each piece of knowledge, "
        "small functions, names that say what things are, no dead code and no speculative options.\n"
        "The smell guide lists what reviewers flag, and the workflow below shows the three review axes the finished Lab will meet.\n\n"
        + workflow
    )


def _catalog(paths: MintPaths) -> str:
    result = subprocess.run(["bun", str(paths.tools / "catalog.ts"), "--md"], capture_output=True, text=True, cwd=paths.player)
    return result.stdout if result.returncode == 0 else f"(the catalog could not be built: {result.stderr.strip()[-400:]})"
