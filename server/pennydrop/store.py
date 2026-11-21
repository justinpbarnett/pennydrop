from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from pathlib import Path
from typing import Any

from .settings import Job
from .review import NEW_ITEM, Schedule, next_schedule, quality_for

SCHEMA = [
    """
    create table profiles (
        id integer primary key,
        name text not null unique,
        kind text not null check (kind in ('adult', 'kid')),
        born_year integer not null,
        born_month integer not null,
        level text not null default 'beginner',
        theme text not null,
        created_at text not null
    );
    create table courses (
        id integer primary key,
        name text not null,
        source text not null default '',
        created_at text not null
    );
    create table topics (
        id integer primary key,
        course_id integer not null references courses(id),
        parent_id integer references topics(id),
        position integer not null,
        title text not null
    );
    create table lessons (
        id text primary key,
        ask text not null,
        title text not null,
        labs text not null default '[]',
        source text not null check (source in ('hand', 'live', 'course')),
        status text not null default 'ready',
        topic_id integer references topics(id),
        first_step_seconds real,
        done_seconds real,
        cost_usd real not null default 0,
        created_at text not null
    );
    create table steps (
        lesson_id text not null references lessons(id),
        n integer not null,
        json text not null,
        voice_json text,
        primary key (lesson_id, n)
    );
    create table films (
        id integer primary key,
        topic_id integer references topics(id),
        title text not null,
        status text not null,
        path text,
        created_at text not null
    );
    create table challenge_answers (
        id integer primary key,
        profile_id integer not null references profiles(id),
        lesson_id text not null,
        step_n integer not null,
        answer text not null,
        correct integer not null,
        created_at text not null
    );
    create table review_items (
        id integer primary key,
        profile_id integer not null references profiles(id),
        lesson_id text not null,
        step_n integer not null,
        prompt text not null,
        ease real not null,
        interval_days integer not null,
        due text not null,
        reps integer not null,
        lapses integer not null,
        unique (profile_id, lesson_id, step_n)
    );
    create table lesson_log (
        id integer primary key,
        profile_id integer not null references profiles(id),
        lesson_id text not null,
        ask text not null,
        content_check text not null,
        created_at text not null
    );
    create table lab_requests (
        id integer primary key,
        ask text not null,
        lab_hint text,
        status text not null default 'open',
        created_at text not null
    );
    create table minted_labs (
        id integer primary key,
        lab_id text not null unique,
        path text not null,
        status text not null,
        created_at text not null
    );
    create table model_calls (
        id integer primary key,
        at text not null,
        job text not null,
        route text not null,
        seconds real not null,
        first_token_seconds real,
        input_tokens integer not null,
        cached_tokens integer not null,
        output_tokens integer not null,
        cost_usd real not null,
        error text
    );
    """,
]


class ProfileKind(StrEnum):
    ADULT = "adult"
    KID = "kid"


class LessonSource(StrEnum):
    HAND = "hand"
    LIVE = "live"
    COURSE = "course"


@dataclass(frozen=True)
class Profile:
    id: int
    name: str
    kind: ProfileKind
    born_year: int
    born_month: int
    level: str
    theme: str


@dataclass(frozen=True)
class LessonRecord:
    id: str
    ask: str
    title: str
    labs: list[str]
    source: LessonSource
    status: str = "ready"
    first_step_seconds: float | None = None
    done_seconds: float | None = None
    cost_usd: float = 0.0


@dataclass(frozen=True)
class ReviewItem:
    id: int
    profile_id: int
    lesson_id: str
    step_n: int
    prompt: dict[str, Any]
    schedule: Schedule
    due: str


@dataclass(frozen=True)
class CallStats:
    job: Job
    route: str
    seconds: float
    first_token_seconds: float | None
    input_tokens: int
    cached_tokens: int
    output_tokens: int
    cost_usd: float
    error: str | None = None


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("pragma journal_mode = wal")
        self._connection.execute("pragma foreign_keys = on")
        self._migrate()

    def _migrate(self) -> None:
        current = self._connection.execute("pragma user_version").fetchone()[0]
        for version in range(current, len(SCHEMA)):
            self._connection.execute("begin")
            for statement in SCHEMA[version].split(";"):
                if statement.strip():
                    self._connection.execute(statement)
            self._connection.execute(f"pragma user_version = {version + 1}")
            self._connection.execute("commit")

    def add_profile(self, name: str, kind: ProfileKind, born_year: int, born_month: int, theme: str, level: str = "beginner") -> Profile:
        cursor = self._connection.execute(
            "insert into profiles (name, kind, born_year, born_month, level, theme, created_at) values (?, ?, ?, ?, ?, ?, ?)",
            (name, kind.value, born_year, born_month, level, theme, _iso(_now())),
        )
        return self.profile(cursor.lastrowid)

    def profile(self, profile_id: int) -> Profile:
        row = self._connection.execute("select * from profiles where id = ?", (profile_id,)).fetchone()
        if row is None:
            raise LookupError(f"no profile with id {profile_id}")
        return _profile_from(row)

    def profiles(self) -> list[Profile]:
        return [_profile_from(row) for row in self._connection.execute("select * from profiles order by id")]

    def save_lesson(self, lesson: LessonRecord) -> None:
        self._connection.execute(
            """
            insert into lessons (id, ask, title, labs, source, status, first_step_seconds, done_seconds, cost_usd, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(id) do update set ask = excluded.ask, title = excluded.title, labs = excluded.labs,
                status = excluded.status, first_step_seconds = excluded.first_step_seconds,
                done_seconds = excluded.done_seconds, cost_usd = excluded.cost_usd
            """,
            (
                lesson.id, lesson.ask, lesson.title, json.dumps(lesson.labs), lesson.source.value, lesson.status,
                lesson.first_step_seconds, lesson.done_seconds, lesson.cost_usd, _iso(_now()),
            ),
        )

    def save_step(self, lesson_id: str, n: int, step: dict[str, Any], voice: dict[str, Any] | None = None) -> None:
        self._connection.execute(
            "insert or replace into steps (lesson_id, n, json, voice_json) values (?, ?, ?, ?)",
            (lesson_id, n, json.dumps(step), json.dumps(voice) if voice else None),
        )

    def lessons(self) -> list[LessonRecord]:
        return [_lesson_from(row) for row in self._connection.execute("select * from lessons order by created_at desc")]

    def lesson(self, lesson_id: str) -> LessonRecord | None:
        row = self._connection.execute("select * from lessons where id = ?", (lesson_id,)).fetchone()
        return _lesson_from(row) if row else None

    def steps(self, lesson_id: str) -> list[dict[str, Any]]:
        rows = self._connection.execute("select json from steps where lesson_id = ? order by n", (lesson_id,))
        return [json.loads(row["json"]) for row in rows]

    def record_answer(self, profile_id: int, lesson_id: str, step_n: int, prompt: dict[str, Any], answer: Any, correct: bool) -> ReviewItem:
        self.profile(profile_id)
        now = _now()
        self._connection.execute(
            "insert into challenge_answers (profile_id, lesson_id, step_n, answer, correct, created_at) values (?, ?, ?, ?, ?, ?)",
            (profile_id, lesson_id, step_n, json.dumps(answer), int(correct), _iso(now)),
        )
        existing = self._connection.execute(
            "select * from review_items where profile_id = ? and lesson_id = ? and step_n = ?",
            (profile_id, lesson_id, step_n),
        ).fetchone()
        current = NEW_ITEM if existing is None else _schedule_from(existing)
        updated = next_schedule(current, quality_for(correct))
        due = _iso(now + timedelta(days=updated.interval_days))
        self._connection.execute(
            """
            insert into review_items (profile_id, lesson_id, step_n, prompt, ease, interval_days, due, reps, lapses)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(profile_id, lesson_id, step_n) do update set prompt = excluded.prompt, ease = excluded.ease,
                interval_days = excluded.interval_days, due = excluded.due, reps = excluded.reps, lapses = excluded.lapses
            """,
            (profile_id, lesson_id, step_n, json.dumps(prompt), updated.ease, updated.interval_days, due, updated.reps, updated.lapses),
        )
        row = self._connection.execute(
            "select * from review_items where profile_id = ? and lesson_id = ? and step_n = ?",
            (profile_id, lesson_id, step_n),
        ).fetchone()
        return _review_from(row)

    def due_reviews(self, profile_id: int | None = None) -> list[ReviewItem]:
        query = "select * from review_items where due <= ?"
        arguments: list[Any] = [_iso(_now())]
        if profile_id is not None:
            query += " and profile_id = ?"
            arguments.append(profile_id)
        return [_review_from(row) for row in self._connection.execute(query + " order by due", arguments)]

    def log_model_call(self, call: CallStats) -> None:
        self._connection.execute(
            """
            insert into model_calls (at, job, route, seconds, first_token_seconds, input_tokens, cached_tokens, output_tokens, cost_usd, error)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                _iso(_now()), str(call.job), call.route, call.seconds, call.first_token_seconds,
                call.input_tokens, call.cached_tokens, call.output_tokens, call.cost_usd, call.error,
            ),
        )


def _profile_from(row: sqlite3.Row) -> Profile:
    return Profile(row["id"], row["name"], ProfileKind(row["kind"]), row["born_year"], row["born_month"], row["level"], row["theme"])


def _lesson_from(row: sqlite3.Row) -> LessonRecord:
    return LessonRecord(
        row["id"], row["ask"], row["title"], json.loads(row["labs"]), LessonSource(row["source"]), row["status"],
        row["first_step_seconds"], row["done_seconds"], row["cost_usd"],
    )


def _schedule_from(row: sqlite3.Row) -> Schedule:
    return Schedule(row["ease"], row["interval_days"], row["reps"], row["lapses"])


def _review_from(row: sqlite3.Row) -> ReviewItem:
    return ReviewItem(row["id"], row["profile_id"], row["lesson_id"], row["step_n"], json.loads(row["prompt"]), _schedule_from(row), row["due"])
