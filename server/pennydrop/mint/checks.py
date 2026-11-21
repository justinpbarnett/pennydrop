from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path

from ..tether import lifeline, tethered_argv
from .paths import MintPaths


@dataclass(frozen=True)
class Finding:
    stage: str
    message: str

    def __str__(self) -> str:
        return f"{self.stage}: {self.message}"


async def run_checks(paths: MintPaths, workspace: Path) -> list[Finding]:
    with lifeline() as stdin:
        process = await asyncio.create_subprocess_exec(
            *tethered_argv(["bun", str(paths.tools / "mint-check.ts"), str(workspace), "--json"]),
            stdin=stdin, cwd=paths.player, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
    try:
        return [Finding(item["stage"], item["message"]) for item in json.loads(stdout.decode().strip().splitlines()[-1])]
    except (json.JSONDecodeError, IndexError):
        return [Finding("tool", f"the check tool crashed: {(stderr or stdout).decode()[-600:].strip()}")]
