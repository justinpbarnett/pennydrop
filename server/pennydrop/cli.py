from __future__ import annotations

import argparse
import asyncio
import faulthandler
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import uvicorn

from . import course_cli
from .ask_client import AskClient, AskClientError, Arrival, Outcome, breakdown, median_and_max, p90
from .courses import CourseSeedError
from .films import STAGES, FilmError, Workspace, check_film, format_report, render_film
from .gateway import Choice, GatewayError, Image, YesNo
from .intake import IntakeError
from .judge import Comparison, Scorecard
from .loudness import TARGET_LUFS, TARGET_TRUE_PEAK
from .mint import MintError
from .mint import cli as mint_cli
from .services import Services
from .settings import Job
from .store import ProfileKind
from .tracer import ALGORITHMS, TraceError
from .tts import TtsError
from .tts.ab import compare

EXPECTED_ERRORS = (AskClientError, CourseSeedError, FilmError, GatewayError, IntakeError, MintError, TraceError, TtsError, LookupError)


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

    ask = commands.add_parser("ask", help="run one Ask against the running server and print the Lesson as it arrives")
    ask.add_argument("text", nargs="?")
    ask.add_argument("--audio", type=Path, help="a speech file to send instead of text")
    ask.add_argument("--profile", type=int, help="Profile id, default the first adult Profile if one exists")
    ask.add_argument("--from", dest="from_step", metavar="LESSON:STEP", help="ask a follow up to a Lesson at a Step")
    ask.set_defaults(handler=_ask)

    bench = commands.add_parser("bench", help="run ten Asks, five typed and five spoken, and print one row per Lesson")
    bench.set_defaults(handler=_bench)

    tts = commands.add_parser("tts", help="speak text and print its word timings")
    tts.add_argument("text")
    tts.add_argument("--provider")
    tts.add_argument("--voice")
    tts.set_defaults(handler=_tts)

    voice = commands.add_parser("voice", help="narration voice tools")
    voice_commands = voice.add_subparsers(required=True, metavar="voice-command")
    ab = voice_commands.add_parser("ab", help="voice one text file with several providers, loudness matched, and score each")
    ab.add_argument("file", type=Path)
    ab.add_argument("--providers", default="kokoro,qwen3", help="comma separated provider names")
    ab.add_argument("--out", type=Path, help="output directory, default data/voice-ab")
    ab.set_defaults(handler=_voice_ab)

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

    judge = commands.add_parser("judge", help="score Lessons against the story spine, or compare two blind")
    judge.add_argument("lessons", nargs="*", metavar="lesson_id", help="Lesson ids to score one by one")
    judge.add_argument("--pair", nargs=2, metavar=("lesson_a", "lesson_b"), help="show two Lessons to the judge in a random order, unlabeled, and print which is better")
    judge.set_defaults(handler=_judge)

    mint_cli.add_parser(commands)
    course_cli.add_parser(commands)

    profile = commands.add_parser("profile", help="manage learner profiles")
    profile_commands = profile.add_subparsers(required=True, metavar="profile-command")
    add = profile_commands.add_parser("add")
    add.add_argument("--name", required=True)
    add.add_argument("--kind", choices=[kind.value for kind in ProfileKind], required=True)
    add.add_argument("--born", help="YYYY-MM, for a kid only")
    add.add_argument("--theme", required=True)
    add.add_argument("--level", default="beginner")
    add.set_defaults(handler=_profile_add)
    listing = profile_commands.add_parser("list")
    listing.set_defaults(handler=_profile_list)

    film = commands.add_parser("film", help="render and check Films")
    film_commands = film.add_subparsers(required=True, metavar="film-command")
    render = film_commands.add_parser("render", help="voice, draw, mix and mux a Film into an MP4")
    render.add_argument("film", type=Path)
    render.add_argument("--out", type=Path)
    render.add_argument("--seconds", type=float, help="render only the first seconds, for a quick look")
    render.set_defaults(handler=_film_render)
    for stage in STAGES:
        stage_command = film_commands.add_parser(stage, help=f"run the {stage} stage of the Film writing pipeline for a thread")
        stage_command.add_argument("thread", help="the folder name under data/films")
        stage_command.set_defaults(handler=_film_stage, stage=stage)
    film_check = film_commands.add_parser("check", help="measure loudness, true peak and Cue offsets of a rendered Film")
    film_check.add_argument("mp4", type=Path)
    film_check.set_defaults(handler=_film_check)
    return parser


def _serve(services: Services, _) -> None:
    from .app import create_app

    services.settings.data_dir.mkdir(parents=True, exist_ok=True)
    crashes = (services.settings.data_dir / "crash.log").open("a")
    faulthandler.enable(file=crashes, all_threads=True)
    uvicorn.run(create_app(services), host=services.settings.host, port=services.settings.port)


BENCH_ASKS = [
    ("typed", "how does binary search work"),
    ("typed", "why is quicksort fast in the average case"),
    ("typed", "how do hash map collisions happen"),
    ("typed", "what happens when a page fault occurs"),
    ("typed", "explain the Pythagorean theorem with a 3 4 5 triangle"),
    ("spoken", "how does a mutex prevent a race"),
    ("spoken", "how does round robin scheduling work"),
    ("spoken", "how does DNS resolve a name"),
    ("spoken", "why is the sky blue"),
    ("spoken", "how does compound interest grow"),
]


def _ask(services: Services, arguments) -> None:
    if not arguments.text and not arguments.audio:
        sys.exit("give the Ask as text, or --audio with a speech file")
    client = AskClient(services.settings)
    profile_id = arguments.profile if arguments.profile is not None else client.profile_id()
    from_step = None
    if arguments.from_step:
        lesson_id, _, step = arguments.from_step.rpartition(":")
        from_step = {"lesson_id": lesson_id, "step": int(step)}
    outcome = client.ask(arguments.text, arguments.audio, profile_id, from_step, on_step=_print_arrival)
    _print_outcome(outcome)


def _print_arrival(arrival: Arrival) -> None:
    step = arrival.step
    voice = step.get("voice")
    print(f"[{arrival.seconds:6.2f} s] step {step['step']}: {step['say']}  ({len(step.get('do', []))} ops{', challenge' if 'challenge' in step else ''}{', voiced' if voice else ', no voice'})", flush=True)


def _print_outcome(outcome: Outcome) -> None:
    print(f"lesson {outcome.lesson_id}: {outcome.header.get('title', '(no header)')}  [ask: {outcome.transcript}]")
    if outcome.error:
        sys.exit(f"pd: the Lesson failed: {outcome.error}")
    done = outcome.done
    print(f"point: {outcome.header.get('point') or '(none)'}  [check: {done.get('point_check')}]")
    print(f"done in {done['seconds']:.2f} s, first Step {done['first_step_seconds']:.2f} s, {done['steps']} Steps, tier {done['tier']}, Labs {', '.join(done['labs']) or 'none'}, cost ${done['cost_usd']:.5f}")
    for name, seconds in breakdown(done):
        print(f"  {name:38} {seconds:6.2f} s")
    for repair in done["repairs"]:
        print(f"  step {repair['step']} check {repair['attempt']}: {' | '.join(repair['errors'])} -> {repair['outcome']}")


def _bench(services: Services, _) -> None:
    client = AskClient(services.settings)
    profile_id = client.profile_id()
    outcomes: list[tuple[str, Outcome]] = []
    with tempfile.TemporaryDirectory(prefix="pennydrop-bench-") as directory:
        for index, (how, text) in enumerate(BENCH_ASKS):
            audio = None
            if how == "spoken":
                audio = Path(directory) / f"ask{index}.aiff"
                subprocess.run(["say", "-o", str(audio), text], check=True)
            outcomes.append((how, client.ask(None if audio else text, audio, profile_id, None, bench=True)))
            _print_bench_row(services, *outcomes[-1])
    finished = [outcome for _, outcome in outcomes if outcome.done]
    if finished:
        for label, values in (
            ("first Step s", [o.done["first_step_seconds"] for o in finished]),
            ("done s", [o.done["seconds"] for o in finished]),
            ("cost $", [o.done["cost_usd"] for o in finished]),
        ):
            median, highest = median_and_max(values)
            print(f"{label:14} p50 {median:8.3f}   p90 {p90(values):8.3f}   max {highest:8.3f}")
        fired = [services.store.hedge_losses(outcome.lesson_id) for outcome in finished]
        print(f"hedge fired    {sum(1 for count, _ in fired if count)} of {len(finished)} Lessons, extra cost ${sum(cost for _, cost in fired):.5f}")
    failed = len(outcomes) - len(finished)
    if failed:
        sys.exit(f"pd: {failed} of {len(outcomes)} Lessons failed")


def _print_bench_row(services: Services, how: str, outcome: Outcome) -> None:
    if outcome.done is None:
        print(f"{how:6} {outcome.transcript[:46]:46} FAILED: {outcome.error}", flush=True)
        return
    done = outcome.done
    hedges, _ = services.store.hedge_losses(outcome.lesson_id)
    print(
        f"{how:6} {outcome.lesson_id} {outcome.transcript[:46]:46} {done['tier']:6} {','.join(done['labs']) or '-':12} "
        f"first {done['first_step_seconds']:5.2f}  done {done['seconds']:5.2f}  ${done['cost_usd']:.5f}"
        f"{'  repairs ' + str(len(done['repairs'])) if done['repairs'] else ''}{'  hedged' if hedges else ''}", flush=True,
    )


def _judge(services: Services, arguments) -> None:
    if bool(arguments.pair) == bool(arguments.lessons):
        sys.exit("give Lesson ids to score, or --pair with two ids")
    if arguments.pair:
        first, second = arguments.pair
        _print_comparison(first, second, asyncio.run(services.judge.compare(first, second)))
        return

    async def score_all():
        return await asyncio.gather(*(services.judge.score(lesson_id) for lesson_id in arguments.lessons))

    for scorecard in asyncio.run(score_all()):
        _print_scorecard(scorecard)


def _print_scorecard(scorecard: Scorecard) -> None:
    print(f"{scorecard.lesson_id}  {scorecard.title}  {scorecard.summary}")
    for name, mark in scorecard.marks.items():
        print(f"  {'pass' if mark.passed else 'FAIL'}  {name:26} {mark.reason}")


def _print_comparison(first: str, second: str, comparison: Comparison) -> None:
    print(f"{first} against {second}")
    for name, preference in comparison.by_criterion.items():
        print(f"  {name:26} {preference.better or 'tie':14} {preference.reason}")
    print(f"overall: {comparison.overall.better or 'tie'}  {comparison.overall.reason}")


def _tts(services: Services, arguments) -> None:
    voice = asyncio.run(services.speaker.voice(arguments.text, provider=arguments.provider, voice=arguments.voice))
    print(f"{'cache hit' if voice.cache_hit else 'synthesized'}: {voice.path}")
    print(f"duration {voice.duration:.2f} s, {len(voice.words)} words")
    for word in voice.words:
        print(f"  {word.start:6.3f} {word.end:6.3f}  {word.word}")


def _voice_ab(services: Services, arguments) -> None:
    out_dir = arguments.out or services.settings.data_dir / "voice-ab"
    providers = [name.strip() for name in arguments.providers.split(",") if name.strip()]
    results = asyncio.run(compare(services.settings, services.transcriber, arguments.file.read_text(), providers, out_dir))
    print(f"{'provider':12} {'seconds':>8} {'audio s':>8} {'RTF':>6} {'WER':>7} {'LUFS':>6} {'dBTP':>6}  file")
    for result in results:
        print(f"{result.provider:12} {result.seconds:8.2f} {result.audio_seconds:8.2f} {result.real_time_factor:6.3f} {result.word_error_rate:7.2%} {result.loudness_lufs:6.1f} {result.true_peak_dbtp:6.1f}  {result.file}")
    print(f"loudness matched to {TARGET_LUFS} LUFS with true peak at most {TARGET_TRUE_PEAK} dBTP, summary in {out_dir / 'ab.json'}")


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
    kind = ProfileKind(arguments.kind)
    if kind is ProfileKind.KID and arguments.born is None:
        raise SystemExit("a kid Profile needs --born YYYY-MM")
    if kind is ProfileKind.ADULT and arguments.born is not None:
        raise SystemExit("an adult Profile takes no --born")
    year, month = (int(part) for part in arguments.born.split("-")) if arguments.born else (None, None)
    profile = services.store.add_profile(arguments.name, kind, year, month, arguments.theme, arguments.level)
    print(f"added profile {profile.id}")


def _profile_list(services: Services, _) -> None:
    for profile in services.store.profiles():
        born = f"born {profile.born_year}-{profile.born_month:02d}" if profile.born_year is not None else "-"
        print(f"{profile.id}  {profile.name}  {profile.kind.value}  {born}  {profile.level}  {profile.theme}")


def _film_render(services: Services, arguments) -> None:
    result = asyncio.run(render_film(services, arguments.film, arguments.out, arguments.seconds))
    print(result.video_log)
    mix = result.mix
    print(f"voice {mix.voice.integrated:.2f} LUFS, bed {mix.bed.integrated:.2f} LUFS, master {mix.master.integrated:.2f} LUFS, master true peak {mix.master.true_peak:.2f} dBTP")
    for problem in result.problems:
        print(f"framing: {problem}")
    print(result.output)


def _film_stage(services: Services, arguments) -> None:
    workspace = Workspace(services.settings.films_dir / arguments.thread)
    result = asyncio.run(STAGES[arguments.stage](services, workspace))
    print(f"{arguments.stage} done for {arguments.thread}: {len(result)} top level fields, recorded in {workspace.measures}")


def _film_check(services: Services, arguments) -> None:
    report = format_report(check := check_film(arguments.mp4, services.transcriber))
    print(report)
    if not (check.loudness_ok and check.cues_ok and check.spoken_ok):
        sys.exit(1)
