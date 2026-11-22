from __future__ import annotations

import argparse
import asyncio

from ..services import Services


def add_parser(commands) -> None:
    practice = commands.add_parser("practice", help="write Practice for Lessons and read pass rates")
    practice_commands = practice.add_subparsers(required=True, metavar="practice-command")
    write = practice_commands.add_parser("write", help="write and check the Rule and three cases for a Lesson, then store them (a hand Lesson gets its practice line)")
    write.add_argument("lesson_id")
    write.set_defaults(handler=_write)
    rates = practice_commands.add_parser("rates", help="show pass rates per Rule by Form")
    rates.add_argument("--profile", type=int, help="only this Profile's answers, default every Profile")
    rates.set_defaults(handler=_rates)


def _write(services: Services, arguments: argparse.Namespace) -> None:
    async def write():
        try:
            return await services.asks.practice.for_lesson(arguments.lesson_id)
        finally:
            await services.asks.close()

    wire = services.library.attach_practice(arguments.lesson_id, asyncio.run(write()))
    print(f"Rule {wire['rule_id']} for Lesson {arguments.lesson_id}: {wire['rule']} (when {wire['condition']})")
    for item in wire["items"]:
        direction = f" {item['direction']}" if item.get("direction") else ""
        print(f"  case {item['case_id']} {item['form']}{direction}: {item['say']}")


def _rates(services: Services, arguments: argparse.Namespace) -> None:
    rates = services.store.practice_rates(arguments.profile)
    if not rates:
        print("no Practice answers yet")
        return
    print(f"{'rule':5} {'form':8} {'answered':>8} {'passed':>6} {'rate':>6}  Rule")
    for rate in rates:
        print(f"{rate.rule_id:<5} {rate.form.value:8} {rate.answered:8} {rate.passed:6} {rate.rate:6.0%}  {rate.rule}")
