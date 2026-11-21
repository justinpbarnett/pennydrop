from __future__ import annotations

import argparse
import asyncio
import signal
import sys

from ..services import Services
from . import Mint
from .pipeline import DEFAULT_MAX_ROUNDS

USAGE = """pd mint <id> --brief "<what it must teach and its ops>"   mint a Lab
pd mint <id> --request N                                  mint the Lab a Lesson writer asked for (its Ask is read from request N)
pd mint <id> --seed                                       mint again from a failed attempt's Lab and lesson, with its last open findings as the brief
pd mint list                                              show every minted Lab with its rounds, seconds, tokens and cost
pd mint requests                                          show the Lab requests Lesson writers filed
pd mint promote <id>                                      copy an accepted Lab into player/src/labs/ for the build session to review and commit"""


def add_parser(commands) -> None:
    mint = commands.add_parser("mint", help="build a new Lab with the Mint", usage=USAGE)
    mint.add_argument("words", nargs="+", metavar="list | requests | promote ID | ID")
    mint.add_argument("--brief", help="what the Lab must teach and which ops it needs")
    mint.add_argument("--request", type=int, help="a Lab request id; its Ask and hint become the brief when --brief is absent")
    mint.add_argument("--seed", action="store_true", help="start from the failed attempt's Lab and lesson; the brief defaults to its brief")
    mint.add_argument("--max-rounds", type=int, default=DEFAULT_MAX_ROUNDS)
    mint.set_defaults(handler=run)


def run(services: Services, arguments: argparse.Namespace) -> None:
    mint = Mint(services.settings, services.store, services.gateway)
    first, *rest = arguments.words
    if first == "list" and not rest:
        _list(services)
    elif first == "requests" and not rest:
        _requests(services)
    elif first == "promote" and len(rest) == 1:
        for note in mint.promote(rest[0]):
            print(note)
        print("the build session reviews and commits the promoted files")
    elif not rest:
        _mint(services, mint, first, arguments)
    else:
        sys.exit(f"pd mint: not understood\n{USAGE}")


def _mint(services: Services, mint: Mint, lab_id: str, arguments: argparse.Namespace) -> None:
    brief = arguments.brief
    if arguments.request is not None and not brief:
        request = services.store.lab_request(arguments.request)
        brief = f"A Lesson writer asked: {request.ask!r}. {('Hint: ' + request.lab_hint) if request.lab_hint else ''} Design the ops a writer needs for that."
    if not brief and arguments.seed:
        brief = services.store.mint(lab_id).brief
    if not brief:
        sys.exit('pd mint: give --brief "<what it must teach and its ops>" or --request N')
    signal.signal(signal.SIGTERM, _interrupt)
    outcome = asyncio.run(mint.run(lab_id, brief, request_id=arguments.request, max_rounds=arguments.max_rounds, seed=arguments.seed))
    record = outcome.record
    print(f"{lab_id}: {record.status.value} after {record.rounds} rounds, {record.seconds:.0f} s, {record.input_tokens} in ({record.cached_tokens} cached) / {record.output_tokens} out tokens, ${record.cost_usd:.4f}")
    if not outcome.accepted:
        sys.exit(f"pd mint: '{lab_id}' still fails after {record.rounds} rounds:\n" + "\n".join(f"  {line}" for line in outcome.remaining))


def _interrupt(signal_number, frame) -> None:
    raise KeyboardInterrupt


def _list(services: Services) -> None:
    mints = services.store.mints()
    if not mints:
        print("no minted Labs yet; `pd mint <id> --brief ...` makes one")
    for item in mints:
        print(f"{item.lab_id:10} {item.status.value:9} rounds {item.rounds}  {item.seconds:6.0f} s  {item.input_tokens + item.output_tokens:>9} tokens  ${item.cost_usd:.4f}")


def _requests(services: Services) -> None:
    requests = services.store.lab_requests()
    if not requests:
        print("no Lab requests filed")
    for item in requests:
        print(f"{item.id:3} {item.status:7} {item.lab_hint or '-':12} {item.ask}")
