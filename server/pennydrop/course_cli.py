from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from .courses import CourseSeed
from .practice.progress import course_progress
from .pregen import Pregenerated, pregenerate
from .services import Services


def add_parser(commands) -> None:
    course = commands.add_parser("course", help="seed, read and pregenerate Courses")
    course_commands = course.add_subparsers(required=True, metavar="course-command")
    seed = course_commands.add_parser("seed", help="load a Course seed file into the store, updating the Course when it already exists")
    seed.add_argument("file", type=Path)
    seed.set_defaults(handler=_seed)
    listing = course_commands.add_parser("list", help="show every Course with how many Topics have a ready Lesson")
    listing.add_argument("--profile", type=int, help="also show the Rules this Profile holds in each Course")
    listing.set_defaults(handler=_list)
    show = course_commands.add_parser("show", help="show one Course with its Topics and their Lessons")
    show.add_argument("course", help="the Course id or slug")
    show.add_argument("--profile", type=int, help="also show each Topic's Rules and whether this Profile holds them")
    show.set_defaults(handler=_show)
    pregen = course_commands.add_parser("pregen", help="write one Lesson per top level Topic through the Ask pipeline")
    pregen.add_argument("course", help="the Course id or slug")
    pregen.add_argument("--topics", help="comma separated Topic codes, default every Topic")
    pregen.add_argument("--concurrency", type=int, default=2)
    pregen.add_argument("--redo", action="store_true", help="write Topics again even when they have a ready Lesson; the newest ready Lesson is the one the Course shows")
    pregen.add_argument("--profile", type=int, help="after the Topics, write a link Lesson for each related pair of Rules this Profile holds in the Course")
    pregen.set_defaults(handler=_pregen)


def _seed(services: Services, arguments: argparse.Namespace) -> None:
    seed = CourseSeed.read(arguments.file)
    course = services.store.seed_course(seed)
    subtopics = sum(len(topic.subtopics) for topic in seed.topics)
    print(f"Course {course.slug} (id {course.id}): {len(seed.topics)} Topics, {subtopics} subtopics")


def _list(services: Services, arguments: argparse.Namespace) -> None:
    courses = services.store.courses()
    if not courses:
        print("no Courses yet; `pd course seed <file>` loads one")
    for course in courses:
        topics = services.store.course_topics(course.id)
        ready = sum(1 for topic in topics if topic.lesson_status == "ready")
        held = ""
        if arguments.profile is not None:
            progress = course_progress(services.store, course, arguments.profile)
            held = f" {progress.rules_held:3}/{progress.rules_total:<3} Rules held"
        print(f"{course.id:3} {course.slug:10} {len(topics):3} Topics {ready:3} ready{held}  {course.title}")


def _show(services: Services, arguments: argparse.Namespace) -> None:
    course = services.store.course(arguments.course)
    progress = course_progress(services.store, course, arguments.profile)
    print(f"{course.slug} (id {course.id}): {course.title}")
    print(course.summary)
    print(f"Honor code: {course.honor_code}")
    if arguments.profile is not None:
        print(f"Rules held by Profile {arguments.profile}: {progress.rules_held} of {progress.rules_total}")
    print()
    print(f"{'code':6} {'part':4} {'subs':4} {'lesson':14} {'status':8} title")
    for item in progress.topics:
        topic = item.topic
        print(f"{topic.code:6} {topic.part:4} {len(topic.subtopics):4} {topic.lesson_id or '-':14} {topic.lesson_status or '-':8} {topic.title}")
        if item.rule:
            print(f"{'':6} {'held' if item.held else 'open':>4}  Rule {item.rule.id}: {item.rule.statement} (when {item.rule.condition})")
    for link in progress.links:
        print(f"link {link.lesson_id}: Rules {link.rule_ids[0]} and {link.rule_ids[1]}")


def _pregen(services: Services, arguments: argparse.Namespace) -> None:
    course = services.store.course(arguments.course)
    codes = [code.strip() for code in arguments.topics.split(",") if code.strip()] if arguments.topics else None
    results = asyncio.run(pregenerate(services, course, codes, arguments.concurrency, arguments.redo, arguments.profile, _log))
    print()
    print(f"{'code':11} {'status':8} {'lesson':14} {'seconds':>8} {'cost':>9} {'judge':>6}  title")
    for result in results:
        judged = f"{result.scorecard.overall}/10" if result.scorecard else "-"
        print(f"{result.label:11} {result.status:8} {result.lesson_id or '-':14} {result.seconds:8.1f} {'$' + format(result.cost_usd, '.4f'):>9} {judged:>6}  {result.topic.title}")
    written = [result for result in results if result.status != "skipped"]
    print(f"{len(written)} written in {sum(result.seconds for result in written):.1f} s of Lesson time, ${sum(result.cost_usd for result in written):.4f}, {len(results) - len(written)} skipped")
    failed = [result for result in results if result.status not in ("ready", "skipped")]
    if failed:
        raise SystemExit(f"pd: {len(failed)} Lessons failed: " + "; ".join(f"{result.label} {result.error}" for result in failed))


def _log(result: Pregenerated) -> None:
    detail = result.error or ""
    if result.scorecard:
        detail = f"judge {result.scorecard.summary}; failed: {', '.join(name for name, mark in result.scorecard.marks.items() if not mark.passed) or 'none'}"
    elif result.scoring_error:
        detail = f"judge failed: {result.scoring_error}"
    print(f"{result.label} {result.status} {result.lesson_id or '-'} {result.seconds:.1f} s ${result.cost_usd:.4f} {detail}".rstrip(), flush=True)
