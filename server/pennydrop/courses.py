from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, ConfigDict, ValidationError


class CourseSeedError(ValueError):
    pass


class SeedTopic(BaseModel):
    model_config = ConfigDict(extra="ignore")

    code: str
    title: str
    part: int
    subtopics: list[str] = []


class CourseSeed(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    title: str
    summary: str = ""
    honor_code: str = ""
    sources: list[str] = []
    topics: list[SeedTopic]

    @classmethod
    def read(cls, path: Path) -> CourseSeed:
        try:
            return cls.model_validate(json.loads(path.read_text()))
        except (OSError, json.JSONDecodeError) as error:
            raise CourseSeedError(f"cannot read the Course seed {path}: {error}") from None
        except ValidationError as error:
            problems = "; ".join(f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}" for item in error.errors())
            raise CourseSeedError(f"the Course seed {path} is not valid: {problems}") from None


@dataclass(frozen=True)
class Course:
    id: int
    slug: str
    title: str
    summary: str
    honor_code: str
    source: str


@dataclass(frozen=True)
class CourseTopic:
    id: int
    code: str
    title: str
    part: int
    subtopics: list[str]
    lesson_id: str | None
    lesson_status: str | None


@dataclass(frozen=True)
class CourseContext:
    topic_id: int
    course_title: str
    honor_code: str
    topic_title: str
    part: int
    terms: list[str]

    @property
    def ask(self) -> str:
        return f"{self.topic_title}, from {self.course_title}"
