from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from pathlib import Path
from typing import Any

from .courses import Course, CourseContext, CourseSeed, CourseTopic
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
    """
    alter table lessons add column tier text;
    alter table lessons add column header text not null default '{}';
    alter table lessons add column transcription_seconds real;
    alter table lessons add column timings text not null default '{}';
    alter table lessons add column error text;
    alter table lessons add column repairs text not null default '[]';
    alter table model_calls add column lesson_id text;
    create index model_calls_lesson on model_calls (lesson_id);
    """,
    """
    alter table lab_requests add column minted_lab_id text;
    alter table minted_labs add column brief text not null default '';
    alter table minted_labs add column request_id integer references lab_requests(id);
    alter table minted_labs add column rounds integer not null default 0;
    alter table minted_labs add column seconds real not null default 0;
    alter table minted_labs add column input_tokens integer not null default 0;
    alter table minted_labs add column cached_tokens integer not null default 0;
    alter table minted_labs add column output_tokens integer not null default 0;
    alter table minted_labs add column cost_usd real not null default 0;
    alter table minted_labs add column round_log text not null default '[]';
    """,
    """
    create table lessons_rebuilt (
        id text primary key,
        ask text not null,
        title text not null,
        labs text not null default '[]',
        source text not null check (source in ('hand', 'live', 'course', 'bench')),
        status text not null default 'ready',
        topic_id integer references topics(id),
        first_step_seconds real,
        done_seconds real,
        cost_usd real not null default 0,
        created_at text not null,
        tier text,
        header text not null default '{}',
        transcription_seconds real,
        timings text not null default '{}',
        error text,
        repairs text not null default '[]',
        profile_id integer references profiles(id)
    );
    insert into lessons_rebuilt (id, ask, title, labs, source, status, topic_id, first_step_seconds, done_seconds, cost_usd, created_at,
        tier, header, transcription_seconds, timings, error, repairs)
        select id, ask, title, labs, source, status, topic_id, first_step_seconds, done_seconds, cost_usd, created_at,
        tier, header, transcription_seconds, timings, error, repairs from lessons;
    drop table lessons;
    alter table lessons_rebuilt rename to lessons;
    update lessons set profile_id = (select profile_id from lesson_log where lesson_log.lesson_id = lessons.id);
    """,
    """
    alter table courses add column slug text;
    alter table courses add column summary text not null default '';
    alter table courses add column honor_code text not null default '';
    alter table topics add column code text;
    alter table topics add column part integer;
    create unique index courses_slug on courses (slug);
    create unique index topics_code on topics (course_id, code) where code is not null;
    create unique index topics_position on topics (course_id, parent_id, position);
    """,
    """
    create table profiles_rebuilt (
        id integer primary key,
        name text not null unique,
        kind text not null check (kind in ('adult', 'kid')),
        born_year integer,
        born_month integer,
        level text not null default 'beginner',
        theme text not null,
        created_at text not null,
        check ((kind = 'kid') = (born_year is not null and born_month is not null))
    );
    insert into profiles_rebuilt (id, name, kind, born_year, born_month, level, theme, created_at)
        select id, name, kind, born_year, born_month, level, theme, created_at from profiles;
    drop table profiles;
    alter table profiles_rebuilt rename to profiles;
    """,
    """
    alter table model_calls add column stop_reason text;
    """,
]


class ProfileKind(StrEnum):
    ADULT = "adult"
    KID = "kid"


class LessonSource(StrEnum):
    HAND = "hand"
    LIVE = "live"
    COURSE = "course"
    BENCH = "bench"


@dataclass(frozen=True)
class Profile:
    id: int
    name: str
    kind: ProfileKind
    born_year: int | None
    born_month: int | None
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
    tier: str | None = None
    header: dict[str, Any] = field(default_factory=dict)
    transcription_seconds: float | None = None
    timings: dict[str, float] = field(default_factory=dict)
    error: str | None = None
    repairs: list[dict[str, Any]] = field(default_factory=list)
    profile_id: int | None = None
    topic_id: int | None = None


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
    lesson_id: str | None = None
    stop_reason: str | None = None


class MintStatus(StrEnum):
    MINTING = "minting"
    ACCEPTED = "accepted"
    FAILED = "failed"
    PROMOTED = "promoted"


@dataclass(frozen=True)
class LabRequest:
    id: int
    ask: str
    lab_hint: str | None
    status: str
    minted_lab_id: str | None
    created_at: str


@dataclass(frozen=True)
class MintRecord:
    lab_id: str
    brief: str
    status: MintStatus
    path: str
    request_id: int | None = None
    rounds: int = 0
    seconds: float = 0.0
    input_tokens: int = 0
    cached_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    round_log: list[dict[str, Any]] = field(default_factory=list)


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
        self._connection.execute("pragma foreign_keys = off")
        for version in range(current, len(SCHEMA)):
            self._connection.execute("begin")
            for statement in SCHEMA[version].split(";"):
                if statement.strip():
                    self._connection.execute(statement)
            self._connection.execute(f"pragma user_version = {version + 1}")
            self._connection.execute("commit")
        self._connection.execute("pragma foreign_keys = on")

    def add_profile(self, name: str, kind: ProfileKind, born_year: int | None, born_month: int | None, theme: str, level: str = "beginner") -> Profile:
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
            insert into lessons (id, ask, title, labs, source, status, first_step_seconds, done_seconds, cost_usd, created_at,
                tier, header, transcription_seconds, timings, error, repairs, profile_id, topic_id)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(id) do update set ask = excluded.ask, title = excluded.title, labs = excluded.labs,
                status = excluded.status, first_step_seconds = excluded.first_step_seconds,
                done_seconds = excluded.done_seconds, cost_usd = excluded.cost_usd, tier = excluded.tier,
                header = excluded.header, transcription_seconds = excluded.transcription_seconds,
                timings = excluded.timings, error = excluded.error, repairs = excluded.repairs, profile_id = excluded.profile_id,
                topic_id = excluded.topic_id
            """,
            (
                lesson.id, lesson.ask, lesson.title, json.dumps(lesson.labs), lesson.source.value, lesson.status,
                lesson.first_step_seconds, lesson.done_seconds, lesson.cost_usd, _iso(_now()),
                lesson.tier, json.dumps(lesson.header), lesson.transcription_seconds, json.dumps(lesson.timings), lesson.error, json.dumps(lesson.repairs), lesson.profile_id, lesson.topic_id,
            ),
        )

    def save_step(self, lesson_id: str, n: int, step: dict[str, Any], voice: dict[str, Any] | None = None) -> None:
        self._connection.execute(
            "insert or replace into steps (lesson_id, n, json, voice_json) values (?, ?, ?, ?)",
            (lesson_id, n, json.dumps(step), json.dumps(voice) if voice else None),
        )

    def lessons(self, profile_id: int | None = None) -> list[LessonRecord]:
        if profile_id is None:
            rows = self._connection.execute(
                "select * from lessons where source not in ('bench', 'course') and (profile_id is null or profile_id not in (select id from profiles where kind = 'kid')) order by created_at desc"
            )
        else:
            rows = self._connection.execute("select * from lessons where source not in ('bench', 'course') and profile_id = ? order by created_at desc", (profile_id,))
        return [_lesson_from(row) for row in rows]

    def lesson(self, lesson_id: str) -> LessonRecord | None:
        row = self._connection.execute("select * from lessons where id = ?", (lesson_id,)).fetchone()
        return _lesson_from(row) if row else None

    def fail_unfinished_lessons(self) -> None:
        self._connection.execute("update lessons set status = 'failed', error = 'the server stopped while this Lesson was being written' where status = 'writing'")

    def steps(self, lesson_id: str) -> list[dict[str, Any]]:
        rows = self._connection.execute("select json, voice_json from steps where lesson_id = ? order by n", (lesson_id,))
        return [{**json.loads(row["json"]), **({"voice": json.loads(row["voice_json"])} if row["voice_json"] else {})} for row in rows]

    def hedge_losses(self, lesson_id: str) -> tuple[int, float]:
        row = self._connection.execute(
            "select count(*) as fired, coalesce(sum(cost_usd), 0) as cost from model_calls where lesson_id = ? and error like 'hedge:%'", (lesson_id,)
        ).fetchone()
        return row["fired"], row["cost"]

    def lesson_cost(self, lesson_id: str) -> float:
        row = self._connection.execute("select coalesce(sum(cost_usd), 0) as total from model_calls where lesson_id = ?", (lesson_id,)).fetchone()
        return row["total"]

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

    def review_queue(self, profile_id: int) -> list[ReviewItem]:
        rows = self._connection.execute("select * from review_items where profile_id = ? order by due, id", (profile_id,))
        return [_review_from(row) for row in rows]

    def review_item(self, item_id: int) -> ReviewItem:
        row = self._connection.execute("select * from review_items where id = ?", (item_id,)).fetchone()
        if row is None:
            raise LookupError(f"no review item with id {item_id}")
        return _review_from(row)

    def seed_course(self, seed: CourseSeed) -> Course:
        self._connection.execute("begin")
        try:
            self._connection.execute(
                """
                insert into courses (slug, name, summary, honor_code, source, created_at) values (?, ?, ?, ?, ?, ?)
                on conflict(slug) do update set name = excluded.name, summary = excluded.summary, honor_code = excluded.honor_code, source = excluded.source
                """,
                (seed.id, seed.title, seed.summary, seed.honor_code, "\n".join(seed.sources), _iso(_now())),
            )
            course = self.course(seed.id)
            for position, topic in enumerate(seed.topics):
                parent_id = self._upsert_topic(course.id, None, position, topic.title, topic.code, topic.part)
                for child_position, subtopic in enumerate(topic.subtopics):
                    self._upsert_topic(course.id, parent_id, child_position, subtopic, None, None)
                self._connection.execute("delete from topics where parent_id = ? and position >= ?", (parent_id, len(topic.subtopics)))
            self._connection.execute("commit")
        except BaseException:
            self._connection.execute("rollback")
            raise
        return course

    def _upsert_topic(self, course_id: int, parent_id: int | None, position: int, title: str, code: str | None, part: int | None) -> int:
        if code is not None:
            existing = self._connection.execute("select id from topics where course_id = ? and code = ?", (course_id, code)).fetchone()
        else:
            existing = self._connection.execute("select id from topics where parent_id = ? and position = ?", (parent_id, position)).fetchone()
        if existing is None:
            return self._connection.execute(
                "insert into topics (course_id, parent_id, position, title, code, part) values (?, ?, ?, ?, ?, ?)",
                (course_id, parent_id, position, title, code, part),
            ).lastrowid
        self._connection.execute("update topics set position = ?, title = ?, part = ? where id = ?", (position, title, part, existing["id"]))
        return existing["id"]

    def courses(self) -> list[Course]:
        return [_course_from(row) for row in self._connection.execute("select * from courses order by id")]

    def course(self, reference: str | int) -> Course:
        row = self._connection.execute("select * from courses where slug = ? or id = ?", (str(reference), reference if str(reference).isdigit() else -1)).fetchone()
        if row is None:
            known = ", ".join(course.slug for course in self.courses()) or "none seeded yet; `pd course seed <file>` loads one"
            raise LookupError(f"no Course '{reference}', known Courses: {known}")
        return _course_from(row)

    def course_topics(self, course_id: int) -> list[CourseTopic]:
        rows = self._connection.execute(
            """
            select topics.id, topics.code, topics.title, topics.part,
                (select lessons.id from lessons where lessons.topic_id = topics.id order by lessons.status = 'ready' desc, lessons.created_at desc limit 1) as lesson_id,
                (select lessons.status from lessons where lessons.topic_id = topics.id order by lessons.status = 'ready' desc, lessons.created_at desc limit 1) as lesson_status
            from topics where topics.course_id = ? and topics.parent_id is null order by topics.position
            """,
            (course_id,),
        ).fetchall()
        subtopics = self._connection.execute(
            "select parent_id, title from topics where course_id = ? and parent_id is not null order by parent_id, position", (course_id,)
        ).fetchall()
        return [
            CourseTopic(row["id"], row["code"], row["title"], row["part"], [child["title"] for child in subtopics if child["parent_id"] == row["id"]], row["lesson_id"], row["lesson_status"])
            for row in rows
        ]

    def course_context(self, topic_id: int) -> CourseContext:
        row = self._connection.execute(
            "select topics.id, topics.title, topics.part, courses.id as course_id, courses.name, courses.honor_code from topics join courses on courses.id = topics.course_id where topics.id = ? and topics.parent_id is null",
            (topic_id,),
        ).fetchone()
        if row is None:
            raise LookupError(f"no top level Topic with id {topic_id}")
        terms = [child["title"] for child in self._connection.execute("select title from topics where parent_id = ? order by position", (topic_id,))]
        return CourseContext(row["id"], row["name"], row["honor_code"], row["title"], row["part"], terms)

    def log_ask(self, profile_id: int, lesson_id: str, ask: str) -> None:
        self.profile(profile_id)
        self._connection.execute(
            "insert into lesson_log (profile_id, lesson_id, ask, content_check, created_at) values (?, ?, ?, '', ?)",
            (profile_id, lesson_id, ask, _iso(_now())),
        )

    def record_content_check(self, lesson_id: str, outcome: str) -> None:
        self._connection.execute("update lesson_log set content_check = ? where lesson_id = ?", (outcome, lesson_id))

    def profile_log(self, profile_id: int) -> dict[str, Any]:
        profile = self.profile(profile_id)
        asks = self._connection.execute(
            """
            select log.ask, log.lesson_id, log.content_check, log.created_at, lessons.status, lessons.done_seconds, lessons.cost_usd
            from lesson_log as log left join lessons on lessons.id = log.lesson_id
            where log.profile_id = ? order by log.created_at desc, log.id desc
            """,
            (profile_id,),
        ).fetchall()
        answers = self._connection.execute(
            "select lesson_id, step_n, answer, correct, created_at from challenge_answers where profile_id = ? order by created_at desc, id desc",
            (profile_id,),
        ).fetchall()
        return {
            "profile": {"id": profile.id, "name": profile.name, "kind": profile.kind.value},
            "asks": [{"transcript": row["ask"], "lesson_id": row["lesson_id"], "content_check": row["content_check"], "at": row["created_at"]} for row in asks],
            "lessons": [
                {"lesson_id": row["lesson_id"], "status": row["status"], "at": row["created_at"], "seconds": row["done_seconds"], "cost_usd": row["cost_usd"]}
                for row in asks
            ],
            "answers": [
                {"lesson_id": row["lesson_id"], "step": row["step_n"], "answer": json.loads(row["answer"]), "correct": bool(row["correct"]), "at": row["created_at"]}
                for row in answers
            ],
        }

    def file_lab_request(self, ask: str, lab_hint: str | None = None) -> LabRequest:
        cursor = self._connection.execute("insert into lab_requests (ask, lab_hint, created_at) values (?, ?, ?)", (ask, lab_hint, _iso(_now())))
        return self.lab_request(cursor.lastrowid)

    def lab_request(self, request_id: int) -> LabRequest:
        row = self._connection.execute("select * from lab_requests where id = ?", (request_id,)).fetchone()
        if row is None:
            raise LookupError(f"no Lab request with id {request_id}; `pd mint requests` lists them")
        return _lab_request_from(row)

    def lab_requests(self, status: str | None = None) -> list[LabRequest]:
        query, arguments = ("select * from lab_requests order by id", ()) if status is None else ("select * from lab_requests where status = ? order by id", (status,))
        return [_lab_request_from(row) for row in self._connection.execute(query, arguments)]

    def resolve_lab_request(self, request_id: int, lab_id: str) -> None:
        self._connection.execute("update lab_requests set status = 'minted', minted_lab_id = ? where id = ?", (lab_id, request_id))

    def save_mint(self, mint: MintRecord) -> None:
        self._connection.execute(
            """
            insert into minted_labs (lab_id, path, status, created_at, brief, request_id, rounds, seconds, input_tokens, cached_tokens, output_tokens, cost_usd, round_log)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(lab_id) do update set path = excluded.path, status = excluded.status, brief = excluded.brief,
                request_id = excluded.request_id, rounds = excluded.rounds, seconds = excluded.seconds,
                input_tokens = excluded.input_tokens, cached_tokens = excluded.cached_tokens, output_tokens = excluded.output_tokens,
                cost_usd = excluded.cost_usd, round_log = excluded.round_log
            """,
            (
                mint.lab_id, mint.path, mint.status.value, _iso(_now()), mint.brief, mint.request_id, mint.rounds, mint.seconds,
                mint.input_tokens, mint.cached_tokens, mint.output_tokens, mint.cost_usd, json.dumps(mint.round_log),
            ),
        )

    def mint(self, lab_id: str) -> MintRecord:
        row = self._connection.execute("select * from minted_labs where lab_id = ?", (lab_id,)).fetchone()
        if row is None:
            raise LookupError(f"no mint for Lab '{lab_id}'; `pd mint list` shows what exists")
        return _mint_from(row)

    def mints(self) -> list[MintRecord]:
        return [_mint_from(row) for row in self._connection.execute("select * from minted_labs order by id")]

    def lessons_using_lab(self, lab_id: str) -> list[LessonRecord]:
        found = []
        for row in self._connection.execute("select * from lessons where status = 'ready' and (labs like ? or id in (select lesson_id from steps where json like ?))", (f"%{lab_id}%", f"%{lab_id}%")):
            lesson = _lesson_from(row)
            if lab_id in lesson.labs or any(_uses_lab(step, lab_id) for step in self.steps(lesson.id)):
                found.append(lesson)
        return found

    def delete_lesson(self, lesson_id: str) -> None:
        self._connection.execute("delete from steps where lesson_id = ?", (lesson_id,))
        self._connection.execute("delete from lessons where id = ?", (lesson_id,))

    def log_model_call(self, call: CallStats) -> None:
        self._connection.execute(
            """
            insert into model_calls (at, job, route, seconds, first_token_seconds, input_tokens, cached_tokens, output_tokens, cost_usd, error, lesson_id, stop_reason)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                _iso(_now()), str(call.job), call.route, call.seconds, call.first_token_seconds,
                call.input_tokens, call.cached_tokens, call.output_tokens, call.cost_usd, call.error, call.lesson_id, call.stop_reason,
            ),
        )


def _profile_from(row: sqlite3.Row) -> Profile:
    return Profile(row["id"], row["name"], ProfileKind(row["kind"]), row["born_year"], row["born_month"], row["level"], row["theme"])


def _uses_lab(value: Any, lab_id: str) -> bool:
    if isinstance(value, dict):
        return value.get("lab") == lab_id or any(_uses_lab(item, lab_id) for item in value.values())
    if isinstance(value, list):
        return any(_uses_lab(item, lab_id) for item in value)
    return False


def _lesson_from(row: sqlite3.Row) -> LessonRecord:
    return LessonRecord(
        row["id"], row["ask"], row["title"], json.loads(row["labs"]), LessonSource(row["source"]), row["status"],
        row["first_step_seconds"], row["done_seconds"], row["cost_usd"], row["tier"], json.loads(row["header"]),
        row["transcription_seconds"], json.loads(row["timings"]), row["error"], json.loads(row["repairs"]),
        row["profile_id"], row["topic_id"],
    )


def _course_from(row: sqlite3.Row) -> Course:
    return Course(row["id"], row["slug"], row["name"], row["summary"], row["honor_code"], row["source"])


def _lab_request_from(row: sqlite3.Row) -> LabRequest:
    return LabRequest(row["id"], row["ask"], row["lab_hint"], row["status"], row["minted_lab_id"], row["created_at"])


def _mint_from(row: sqlite3.Row) -> MintRecord:
    return MintRecord(
        row["lab_id"], row["brief"], MintStatus(row["status"]), row["path"], row["request_id"], row["rounds"], row["seconds"],
        row["input_tokens"], row["cached_tokens"], row["output_tokens"], row["cost_usd"], json.loads(row["round_log"]),
    )


def _schedule_from(row: sqlite3.Row) -> Schedule:
    return Schedule(row["ease"], row["interval_days"], row["reps"], row["lapses"])


def _review_from(row: sqlite3.Row) -> ReviewItem:
    return ReviewItem(row["id"], row["profile_id"], row["lesson_id"], row["step_n"], json.loads(row["prompt"]), _schedule_from(row), row["due"])
