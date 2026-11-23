from __future__ import annotations

import json
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path

from ..asks.validator import Validator
from ..gateway import CallStats, Gateway
from ..settings import Job, Settings
from ..store import MintRecord, MintStatus, Store
from . import runtime
from . import workspace as workspace_builder
from .checks import Finding, run_checks
from .judge import Defect, confirm, judge
from .paths import MINT_JOB_TIMEOUT_SECONDS, MintPaths
from .runtime import MintError

DEFAULT_MAX_ROUNDS = 5
SANDBOX = "workspace-write"
CLAUDE_TOOLS = "Read,Edit,Write,Glob,Grep,Bash"
CLAUDE_PERMISSION_MODE = "acceptEdits"
CLAUDE_CHECK_COMMAND = "Bash(./check:*)"
FIRST_ROUND = "Read TASK.md in this directory and do the task it describes."
SEEDED_ROUND = """Read TASK.md in this directory and do the task it describes.
src/labs/{lab_id}.ts and lesson.jsonl already hold an earlier attempt that came close, so start from them instead of writing anew.
These problems were still open on it, and TASK.md repeats them:

{problems}

Fix the cause of each one in place, keep everything that already works, and run ./check until it prints ok.
{earlier}"""
REPAIR_ROUND = """The task is in TASK.md and the rules are in RULES.md; reread both if you need them.
Your Lab in src/labs/{lab_id}.ts and your lesson.jsonl were reviewed after your last round and these problems remain.
Fix the cause of each one in place, never hide it, keep everything that already works, run ./check until it prints ok, and reply with a few lines on what you changed.
A fix must not move, resize or recolor anything that was not reported; fixing one mark must not break its neighbours.

{problems}
{earlier}"""
EARLIER_HEADING = """
Reviews in earlier rounds also reported these problems, which you fixed or replaced since.
Each one must stay fixed, so check your changes against them before you finish:

{problems}
"""
MAX_EARLIER_PROBLEMS = 30


@dataclass(frozen=True)
class Seed:
    source: str
    lesson: str
    problems: list[str]
    reviewed: list[str]
    reported: list[str]
    history: list[dict]


@dataclass(frozen=True)
class MintOutcome:
    record: MintRecord
    remaining: list[str]

    @property
    def accepted(self) -> bool:
        return self.record.status is MintStatus.ACCEPTED


class Mint:
    def __init__(self, settings: Settings, store: Store, gateway: Gateway):
        self._store = store
        self._gateway = gateway
        self._paths = MintPaths.of(settings)
        self._validator = Validator(settings)

    @property
    def paths(self) -> MintPaths:
        return self._paths

    async def run(self, lab_id: str, brief: str, *, request_id: int | None = None, max_rounds: int = DEFAULT_MAX_ROUNDS, seed: bool = False, report: Callable[[str], None] = print) -> MintOutcome:
        workspace_builder.require_references(self._paths)
        ask = self._store.lab_request(request_id).ask if request_id is not None else None
        seeding = self._seed(lab_id) if seed else None
        if seeding:
            task_brief = f"{brief}\n\nAn earlier attempt at this Lab is in src/labs/{lab_id}.ts and lesson.jsonl. These problems were still open on it:\n" + "\n".join(f"- {line}" for line in seeding.problems)
        workspace_path = self._fresh_workspace(lab_id, task_brief if seeding else brief, ask)
        self._dump_stored_lessons(lab_id, workspace_path)
        if seeding:
            (workspace_path / "src" / "labs" / f"{lab_id}.ts").write_text(seeding.source)
            (workspace_path / "lesson.jsonl").write_text(seeding.lesson)
        started = time.monotonic()
        record = MintRecord(lab_id, brief, MintStatus.MINTING, str(workspace_path), request_id)
        if seeding:
            record = replace(record, round_log=seeding.history)
        self._store.save_mint(record)
        prompt = SEEDED_ROUND.format(lab_id=lab_id, problems="\n".join(f"- {line}" for line in seeding.problems), earlier=_earlier_section([line for line in seeding.reported if line not in seeding.problems][-MAX_EARLIER_PROBLEMS:])) if seeding else FIRST_ROUND
        remaining: list[str] = []
        reported: list[str] = list(seeding.reported) if seeding else []
        reviewed: list[str] = list(seeding.reviewed) if seeding else []
        try:
            for round_number in range(1, max_rounds + 1):
                round_started = time.monotonic()
                report(f"[{lab_id}] round {round_number}: the model is writing")
                completion = await self._gateway.complete(Job.MINT, prompt, cwd=workspace_path, sandbox=SANDBOX, tools=CLAUDE_TOOLS, permission_mode=CLAUDE_PERMISSION_MODE, allowed_tools=f"{CLAUDE_CHECK_COMMAND},Read(/{self._paths.player / 'src'}/**)", timeout=MINT_JOB_TIMEOUT_SECONDS)
                if not (workspace_path / "src" / "labs" / f"{lab_id}.ts").is_file():
                    self._store.save_mint(_finish(record, MintStatus.FAILED))
                    raise MintError(f"the Mint's model wrote no Lab file in round {round_number} (route {completion.stats.route if completion.stats else 'unknown'}); no more rounds were spent. Its reply: {completion.text.strip()[-600:]}")
                runtime.format_source(self._paths, workspace_path / "src" / "labs" / f"{lab_id}.ts")
                findings = await run_checks(self._paths, workspace_path)
                defects: list[Defect] = []
                judge_calls: list[CallStats] = []
                if not findings:
                    report(f"[{lab_id}] round {round_number}: checks pass, the judge is looking at the frames")
                    verdict = await judge(self._gateway, workspace_path / "frames", lab_id, reviewed)
                    raised = verdict.defects
                    confirmation = await confirm(self._gateway, workspace_path / "frames", raised)
                    defects, judge_calls = confirmation.confirmed, [*verdict.calls, *confirmation.calls]
                    reviewed = [str(defect) for defect in defects]
                    report(f"[{lab_id}] round {round_number}: the judge raised {len(raised)} findings and {len(defects)} held up on a second look")
                broken_tools = [item for item in findings if item.stage == "tool"]
                if broken_tools:
                    self._store.save_mint(_finish(record, MintStatus.FAILED))
                    raise MintError(f"the Mint's own tooling failed, so no round was wasted on the Lab: {broken_tools[0].message}")
                installed = False
                if not findings and not defects:
                    try:
                        runtime.install(self._paths, self._store, self._validator, lab_id, workspace_path)
                        installed = True
                    except MintError as error:
                        stored = self._dump_stored_lessons(lab_id, workspace_path)
                        findings = [*findings, f"{str(error)[:3000]}. Lessons already stored play this Lab, so it must keep accepting their scenes and ops exactly as they wrote them; they are in {stored}, one JSON line per step"]
                remaining = [str(item) for item in [*findings, *defects]]
                record = _with_round(record, round_number, time.monotonic() - round_started, completion.stats, judge_calls, findings, defects, time.monotonic() - started)
                self._store.save_mint(record)
                report(f"[{lab_id}] round {round_number}: {len(findings)} check findings, {len(defects)} judge findings")
                for line in remaining:
                    report(f"    {line}")
                if installed:
                    break
                reported = list(dict.fromkeys([*reported, *remaining]))
                earlier = [line for line in reported if line not in remaining][-MAX_EARLIER_PROBLEMS:]
                prompt = REPAIR_ROUND.format(lab_id=lab_id, problems="\n".join(f"- {line}" for line in remaining), earlier=_earlier_section(earlier))
        except BaseException:
            self._store.save_mint(_finish(record, MintStatus.FAILED))
            raise
        if remaining:
            record = _finish(record, MintStatus.FAILED)
        else:
            record = _finish(record, MintStatus.ACCEPTED)
            if request_id is not None:
                self._store.resolve_lab_request(request_id, lab_id)
        self._store.save_mint(record)
        return MintOutcome(record, remaining)

    def promote(self, lab_id: str) -> list[str]:
        notes = runtime.promote(self._paths, self._store, self._validator, lab_id)
        record = self._store.mint(lab_id)
        self._store.save_mint(_finish(record, MintStatus.PROMOTED))
        return notes

    def _dump_stored_lessons(self, lab_id: str, workspace_path: Path) -> str:
        lines = []
        for lesson in self._store.lessons_using_lab(lab_id):
            if lesson.id != runtime.example_lesson_id(lab_id):
                lines.extend(json.dumps(step) for step in self._store.steps(lesson.id))
        target = workspace_path / "stored-lessons.jsonl"
        target.write_text("\n".join(lines))
        return target.name

    def _seed(self, lab_id: str) -> Seed:
        try:
            previous = self._store.mint(lab_id)
        except LookupError:
            raise MintError(f"there is no earlier attempt at '{lab_id}' to seed from") from None
        workspace = Path(previous.path)
        source, lesson = workspace / "src" / "labs" / f"{lab_id}.ts", workspace / "lesson.jsonl"
        if previous.status is not MintStatus.FAILED or not source.is_file() or not lesson.is_file():
            raise MintError(f"only a failed attempt that still has its Lab and lesson.jsonl can seed a mint; '{lab_id}' is {previous.status.value}")
        last = previous.round_log[-1]
        reported = list(dict.fromkeys(line for entry in previous.round_log for line in [*entry["check_findings"], *entry["judge_findings"]]))
        return Seed(source.read_text(), lesson.read_text(), [*last["check_findings"], *last["judge_findings"]], list(last["judge_findings"]), reported, list(previous.round_log))

    def _fresh_workspace(self, lab_id: str, brief: str, ask: str | None) -> Path:
        if (self._paths.labs / f"{lab_id}.ts").exists():
            raise MintError(f"{self._paths.labs / f'{lab_id}.ts'} already exists; move it away to re-mint '{lab_id}', or pick another id")
        shutil.rmtree(self._paths.workspace(lab_id), ignore_errors=True)
        return workspace_builder.prepare(self._paths, lab_id, brief, ask)



def _earlier_section(earlier: list[str]) -> str:
    return EARLIER_HEADING.format(problems="\n".join(f"- {line}" for line in earlier)) if earlier else ""


def _with_round(record: MintRecord, number: int, seconds: float, codex: CallStats | None, judge_calls: list[CallStats], findings: list[Finding], defects: list[Defect], total_seconds: float) -> MintRecord:
    calls = [call for call in [codex, *judge_calls] if call]
    entry = {
        "round": number,
        "seconds": round(seconds, 1),
        "codex_tokens": {"input": codex.input_tokens, "cached": codex.cached_tokens, "output": codex.output_tokens} if codex else None,
        "cost_usd": round(sum(call.cost_usd for call in calls), 5),
        "check_findings": [str(item) for item in findings],
        "judge_findings": [str(item) for item in defects],
    }
    return replace(
        record,
        rounds=number,
        seconds=round(total_seconds, 1),
        input_tokens=record.input_tokens + sum(call.input_tokens for call in calls),
        cached_tokens=record.cached_tokens + sum(call.cached_tokens for call in calls),
        output_tokens=record.output_tokens + sum(call.output_tokens for call in calls),
        cost_usd=round(record.cost_usd + sum(call.cost_usd for call in calls), 5),
        round_log=[*record.round_log, entry],
    )


def _finish(record: MintRecord, status: MintStatus) -> MintRecord:
    return replace(record, status=status)
