from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
ESTIMATE_SUFFIX = "-estimate"


class Job(StrEnum):
    CLASSIFY = "classify"
    WRITER_FAST = "writer_fast"
    WRITER_STRONG = "writer_strong"
    VISION = "vision"
    GRADE = "grade"
    FILM_RESEARCH = "film_research"
    FILM_SCRIPT = "film_script"
    FILM_FACTCHECK = "film_factcheck"
    FILM_PLAN = "film_plan"
    MINT = "mint"


class RouteKind(StrEnum):
    CLAUDE = "claude"
    CODEX = "codex"
    JEV = "jev"
    ANTHROPIC = "anthropic"
    OPENROUTER = "openrouter"


@dataclass(frozen=True)
class RouteSpec:
    kind: RouteKind
    model: str

    @classmethod
    def parse(cls, text: str) -> RouteSpec:
        kind, separator, model = text.partition(":")
        if not separator or not model:
            raise ValueError(f"route '{text}' must look like 'kind:model'")
        try:
            return cls(RouteKind(kind), model)
        except ValueError:
            known = ", ".join(k.value for k in RouteKind)
            raise ValueError(f"route '{text}' has unknown kind '{kind}', expected one of {known}") from None

    def __str__(self) -> str:
        return f"{self.kind.value}:{self.model}"


@dataclass(frozen=True)
class Price:
    input: float
    cached_input: float
    output: float
    estimated: bool

    def cost(self, input_tokens: int, cached_tokens: int, output_tokens: int) -> float:
        fresh = max(input_tokens - cached_tokens, 0)
        return (fresh * self.input + cached_tokens * self.cached_input + output_tokens * self.output) / 1_000_000


@dataclass(frozen=True)
class Settings:
    repo_root: Path
    host: str
    port: int
    data_dir: Path
    lessons_dir: Path
    player_dist: Path
    improve_references: Path
    routes: dict[Job, tuple[RouteSpec, ...]]
    tts_provider: str
    tts_sections: dict[str, dict]
    whisper_model: Path
    whisper_threads: int
    prices: dict[str, Price]

    @property
    def database_path(self) -> Path:
        return self.data_dir / "pennydrop.db"

    @property
    def player_dir(self) -> Path:
        return self.repo_root / "player"

    @property
    def tts_cache_dir(self) -> Path:
        return self.data_dir / "tts"

    @property
    def scratch_dir(self) -> Path:
        return self.data_dir / "scratch"

    def secret(self, name: str) -> str | None:
        return os.environ.get(name) or None


def load_settings(config_path: Path | None = None) -> Settings:
    root = REPO_ROOT
    load_dotenv(root / ".env")
    with open(config_path or root / "config.toml", "rb") as handle:
        raw = tomllib.load(handle)
    paths = raw["paths"]
    return Settings(
        repo_root=root,
        host=raw["server"]["host"],
        port=raw["server"]["port"],
        data_dir=root / paths["data_dir"],
        lessons_dir=root / paths["lessons_dir"],
        player_dist=root / paths["player_dist"],
        improve_references=root / Path(paths["improve_references"]).expanduser(),
        routes=_parse_routes(raw["routes"]),
        tts_provider=raw["tts"]["provider"],
        tts_sections={name: section for name, section in raw["tts"].items() if isinstance(section, dict)},
        whisper_model=Path(raw["voice_in"]["whisper_model"]).expanduser(),
        whisper_threads=raw["voice_in"]["threads"],
        prices=_parse_prices(raw["prices"]),
    )


def _parse_routes(raw: dict[str, list[str]]) -> dict[Job, tuple[RouteSpec, ...]]:
    missing = [job.value for job in Job if job.value not in raw]
    if missing:
        raise ValueError(f"config.toml [routes] has no entry for: {', '.join(missing)}")
    return {Job(name): tuple(RouteSpec.parse(text) for text in texts) for name, texts in raw.items()}


def _parse_prices(raw: dict[str, dict[str, float]]) -> dict[str, Price]:
    prices = {}
    for key, row in raw.items():
        estimated = key.endswith(ESTIMATE_SUFFIX)
        model = key.removesuffix(ESTIMATE_SUFFIX)
        prices[model] = Price(row["input"], row["cached_input"], row["output"], estimated)
    return prices
