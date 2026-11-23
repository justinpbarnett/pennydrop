from __future__ import annotations

import asyncio
import json
from pathlib import Path

from ..settings import Settings
from ..tether import lifeline, tethered_argv

ENGINE = Path(__file__).parent / "diorama" / "main.py"
NICENESS = 10
LOG_TAIL_LINES = 40


class EngineError(RuntimeError):
    """The engine itself crashed, as opposed to reporting errors in a spec, which a writer can fix."""


class Engine:
    """Runs the diorama engine in Blender, a few processes at a time and at low priority, because a laptop renders whole Films overnight."""

    def __init__(self, settings: Settings):
        self._blender = settings.blender
        self._slots = asyncio.Semaphore(settings.blender.workers)

    async def run(self, job: dict) -> dict:
        out = Path(job["out"])
        out.mkdir(parents=True, exist_ok=True)
        job_path = out / "job.json"
        job_path.write_text(json.dumps(job, indent=1, ensure_ascii=False))
        report_path = out / "report.json"
        report_path.unlink(missing_ok=True)
        command = ["nice", "-n", str(NICENESS), str(self._blender.program), "-b", "--factory-startup", "-t", str(self._blender.threads), "--python-exit-code", "1", "-P", str(ENGINE), "--", str(job_path)]
        async with self._slots:
            with lifeline() as stdin:
                process = await asyncio.create_subprocess_exec(*tethered_argv(command), stdin=stdin, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
                output, _ = await process.communicate()
        log = output.decode(errors="replace")
        (out / "engine.log").write_text(log)
        if process.returncode != 0 or not report_path.exists():
            tail = "\n".join(log.splitlines()[-LOG_TAIL_LINES:])
            raise EngineError(f"the diorama engine failed on {job_path} with exit code {process.returncode}; the end of its log:\n{tail}")
        return json.loads(report_path.read_text())

    async def catalog(self, out: Path) -> dict:
        return (await self.run({"mode": "catalog", "out": str(out)}))["catalog"]
