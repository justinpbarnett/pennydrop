from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

import uvicorn

from .gateway import Choice, GatewayError, Image, YesNo
from .intake import IntakeError
from .services import Services
from .settings import Job
from .store import ProfileKind
from .tracer import ALGORITHMS, TraceError
from .tts import TtsError

EXPECTED_ERRORS = (GatewayError, IntakeError, TraceError, TtsError, LookupError)


def main() -> None:
    arguments = _parser().parse_args()
    try:
        arguments.handler(Services.open(), arguments)
    except EXPECTED_ERRORS as error:
        sys.exit(f"pd: {error}")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="pd", description="Pennydrop server tools")
    commands = parser.add_subparsers(required=True, metavar="command")

    serve = commands.add_parser("serve", help="run the API and the built player")
    serve.set_defaults(handler=_serve)

    tts = commands.add_parser("tts", help="speak text and print its word timings")
    tts.add_argument("text")
    tts.add_argument("--provider")
    tts.add_argument("--voice")
    tts.set_defaults(handler=_tts)

    transcribe = commands.add_parser("transcribe", help="turn a speech file into text")
    transcribe.add_argument("file", type=Path)
    transcribe.set_defaults(handler=_transcribe)

    trace = commands.add_parser("trace", help="trace a library algorithm or your own source")
    trace.add_argument("name", nargs="?", help=f"one of: {', '.join(ALGORITHMS)}")
    trace.add_argument("--input", required=True, help="JSON: a list, or an object of named arguments")
    trace.add_argument("--source", type=Path, help="Python file to trace instead of a library algorithm")
    trace.add_argument("--entry", help="function to call in --source")
    trace.add_argument("--events", action="store_true", help="print the full event list")
    trace.set_defaults(handler=_trace)

    jev = commands.add_parser("jev", help="classify a sentence with JEV")
    jev.add_argument("text")
    jev.set_defaults(handler=_jev)

    gateway = commands.add_parser("gateway", help="gateway tools")
    gateway_commands = gateway.add_subparsers(required=True, metavar="gateway-command")
    ping = gateway_commands.add_parser("ping", help="call every configured route with a tiny prompt")
    ping.add_argument("job", nargs="?", choices=[job.value for job in Job])
    ping.set_defaults(handler=_ping)
    vision = gateway_commands.add_parser("vision", help="ask the vision job about an image")
    vision.add_argument("image", type=Path)
    vision.add_argument("question")
    vision.set_defaults(handler=_vision)

    profile = commands.add_parser("profile", help="manage learner profiles")
    profile_commands = profile.add_subparsers(required=True, metavar="profile-command")
    add = profile_commands.add_parser("add")
    add.add_argument("--name", required=True)
    add.add_argument("--kind", choices=[kind.value for kind in ProfileKind], required=True)
    add.add_argument("--born", required=True, help="YYYY-MM")
    add.add_argument("--theme", required=True)
    add.add_argument("--level", default="beginner")
    add.set_defaults(handler=_profile_add)
    listing = profile_commands.add_parser("list")
    listing.set_defaults(handler=_profile_list)
    return parser


def _serve(services: Services, _) -> None:
    from .app import create_app

    uvicorn.run(create_app(services), host=services.settings.host, port=services.settings.port)


def _tts(services: Services, arguments) -> None:
    voice = asyncio.run(services.speaker.voice(arguments.text, provider=arguments.provider, voice=arguments.voice))
    print(f"{'cache hit' if voice.cache_hit else 'synthesized'}: {voice.path}")
    print(f"duration {voice.duration:.2f} s, {len(voice.words)} words")
    for word in voice.words:
        print(f"  {word.start:6.3f} {word.end:6.3f}  {word.word}")


def _transcribe(services: Services, arguments) -> None:
    print(asyncio.run(services.transcriber.transcribe(arguments.file)))


def _trace(services: Services, arguments) -> None:
    payload = json.loads(arguments.input)
    if arguments.source:
        if not arguments.entry:
            sys.exit("--source needs --entry")
        trace = asyncio.run(services.tracer.trace_source(arguments.source.read_text(), arguments.entry, payload))
    elif arguments.name:
        trace = asyncio.run(services.tracer.trace_named(arguments.name, payload))
    else:
        sys.exit("give a library algorithm name or --source with --entry")
    counters = trace.counters
    print(f"comparisons {counters.comparisons}, swaps {counters.swaps}, writes {counters.writes}")
    print(f"events {len(trace.events)}{' (truncated)' if trace.truncated else ''}, result {json.dumps(trace.result)}, error {trace.error}")
    if trace.stdout:
        print(f"stdout {trace.stdout!r}")
    if arguments.events:
        for event in trace.events:
            print(json.dumps(event, default=lambda item: item.__dict__))


def _jev(services: Services, arguments) -> None:
    questions = {
        "area": Choice("Which subject does the learner want to study?", {
            "computing": "computers, programming or algorithms",
            "mathematics": "numbers, shapes or proofs",
            "science": "physics, chemistry or biology",
            "other": "anything else",
        }),
        "visual": YesNo("Would an animated drawing help explain this?"),
    }
    result = asyncio.run(services.gateway.classify(arguments.text, questions))
    for name, answer in result.answers.items():
        print(f"{name}: {answer}")
    print(f"{result.stats.seconds:.2f} s, ${result.stats.cost_usd:.6f}")


def _ping(services: Services, arguments) -> None:
    jobs = [Job(arguments.job)] if arguments.job else list(Job)

    async def ping_all():
        for job in jobs:
            for result in await services.gateway.ping(job):
                seconds = f"{result.seconds:5.2f} s" if result.seconds is not None else "      -"
                print(f"{job.value:15} {result.route:42} {seconds}  {result.detail}", flush=True)

    asyncio.run(ping_all())


def _vision(services: Services, arguments) -> None:
    completion = asyncio.run(services.gateway.complete(Job.VISION, arguments.question, images=(Image.from_file(arguments.image),)))
    print(completion.text)
    print(f"{completion.stats.route}, {completion.stats.seconds:.2f} s, ${completion.stats.cost_usd:.6f}")


def _profile_add(services: Services, arguments) -> None:
    year, month = arguments.born.split("-")
    profile = services.store.add_profile(arguments.name, ProfileKind(arguments.kind), int(year), int(month), arguments.theme, arguments.level)
    print(f"added profile {profile.id}")


def _profile_list(services: Services, _) -> None:
    for profile in services.store.profiles():
        print(f"{profile.id}  {profile.name}  {profile.kind.value}  born {profile.born_year}-{profile.born_month:02d}  {profile.level}  {profile.theme}")
