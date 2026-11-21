from __future__ import annotations

import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path

from ..gateway import CallStats, Gateway
from ..settings import Job, Settings
from ..store import MintRecord, MintStatus, Store
from . import runtime, workspace as workspace_builder
from .checks import Finding, run_checks
from .judge import Defect, judge
from .paths import MINT_JOB_TIMEOUT_SECONDS, MintPaths
from .runtime import MintError

DEFAULT_MAX_ROUNDS = 5
SANDBOX = "workspace-write"
FIRST_ROUND = "Read TASK.md in this directory and do the task it describes."
REPAIR_ROUND = """The task is in TASK.md and the rules are in RULES.md; reread both if you need them.
Your Lab in src/labs/{lab_id}.ts and your lesson.jsonl were reviewed after your last round and these problems remain.
Fix the cause of each one in place, never hide it, keep everything that already works, run ./check until it prints ok, and reply with a few lines on what you changed.

{problems}
"""


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

    @property
    def paths(self) -> MintPaths:
        return self._paths

    async def run(self, lab_id: str, brief: str, *, request_id: int | None = None, max_rounds: int = DEFAULT_MAX_ROUNDS, report: Callable[[str], None] = print) -> MintOutcome:
        workspace_builder.require_references(self._paths)
        ask = self._store.lab_request(request_id).ask if request_id is not None else None
        workspace_path = self._fresh_workspace(lab_id, brief, ask)
        started = time.monotonic()
        record = MintRecord(lab_id, brief, MintStatus.MINTING, str(workspace_path), request_id)
        self._store.save_mint(record)
        prompt = FIRST_ROUND
        remaining: list[str] = []
        for round_number in range(1, max_rounds + 1):
            round_started = time.monotonic()
            report(f"[{lab_id}] round {round_number}: codex is writing")
            completion = await self._gateway.complete(Job.MINT, prompt, cwd=workspace_path, sandbox=SANDBOX, timeout=MINT_JOB_TIMEOUT_SECONDS)
            findings = await run_checks(self._paths, workspace_path)
            defects: list[Defect] = []
            judge_calls: list[CallStats] = []
            if not findings:
                report(f"[{lab_id}] round {round_number}: checks pass, the judge is looking at the frames")
                verdict = await judge(self._gateway, workspace_path / "frames", lab_id)
                defects, judge_calls = verdict.defects, verdict.calls
            broken_tools = [item for item in findings if item.stage == "tool"]
            if broken_tools:
                self._store.save_mint(_finish(record, MintStatus.FAILED))
                raise MintError(f"the Mint's own tooling failed, so no round was wasted on the Lab: {broken_tools[0].message}")
            remaining = [str(item) for item in [*findings, *defects]]
            record = _with_round(record, round_number, time.monotonic() - round_started, completion.stats, judge_calls, findings, defects, time.monotonic() - started)
            self._store.save_mint(record)
            report(f"[{lab_id}] round {round_number}: {len(findings)} check findings, {len(defects)} judge findings")
            for line in remaining:
                report(f"    {line}")
            if not remaining:
                break
            prompt = REPAIR_ROUND.format(lab_id=lab_id, problems="\n".join(f"- {line}" for line in remaining))
        if remaining:
            record = _finish(record, MintStatus.FAILED)
        else:
            runtime.install(self._paths, self._store, lab_id, workspace_path)
            record = _finish(record, MintStatus.ACCEPTED)
            if request_id is not None:
                self._store.resolve_lab_request(request_id, lab_id)
        self._store.save_mint(record)
        return MintOutcome(record, remaining)

    def promote(self, lab_id: str) -> list[str]:
        notes = runtime.promote(self._paths, self._store, lab_id)
        record = self._store.mint(lab_id)
        self._store.save_mint(_finish(record, MintStatus.PROMOTED))
        return notes

    def _fresh_workspace(self, lab_id: str, brief: str, ask: str | None) -> Path:
        if self._store_has_promoted(lab_id):
            raise MintError(f"the Lab '{lab_id}' was already promoted; pick another id")
        shutil.rmtree(self._paths.workspace(lab_id), ignore_errors=True)
        return workspace_builder.prepare(self._paths, lab_id, brief, ask)

    def _store_has_promoted(self, lab_id: str) -> bool:
        try:
            return self._store.mint(lab_id).status is MintStatus.PROMOTED
        except LookupError:
            return False


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
