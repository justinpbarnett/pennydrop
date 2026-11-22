from __future__ import annotations

import json
import re
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from ..services import Services
from ..tether import lifeline, tethered_argv
from . import mix
from .audit import audit_problems
from .document import FilmDocument, FilmError
from .kits import kit_named
from .voices import speak_film

PLAYER_TOOL = "player/tools/film.ts"


@dataclass(frozen=True)
class RenderResult:
    output: Path
    voiced_film: Path
    video_seconds: float
    mix: mix.MixReport
    video_log: str
    problems: list[str]


STACK_LINE = re.compile(r"^\s+at ")


def film_tool(services: Services, *arguments: str, capture: bool = False, tool: str = PLAYER_TOOL) -> subprocess.CompletedProcess:
    with lifeline() as stdin:
        result = subprocess.run(
            tethered_argv(["bun", str(services.settings.repo_root / tool), *arguments]), stdin=stdin, cwd=services.settings.repo_root, capture_output=capture, text=True
        )
    if result.returncode != 0:
        message = "\n".join(line for line in (result.stderr or "").splitlines() if not STACK_LINE.match(line) and not line.startswith("Bun v"))
        raise FilmError(f"film tool {arguments[0]} failed:\n{message.strip()[:3000]}")
    return result


def theme_identity(services: Services, theme: str) -> dict:
    description = json.loads(film_tool(services, "theme", theme, capture=True).stdout)
    if not description["film"]:
        raise FilmError(f"theme '{theme}' has no film sound kit and voice")
    return description["film"]


async def render_film(services: Services, film_path: Path, output: Path | None, seconds: float | None = None) -> RenderResult:
    settings = services.settings
    document = FilmDocument.read(film_path)
    identity = theme_identity(services, document.header["theme"])
    home = settings.films_dir / document.name
    home.mkdir(parents=True, exist_ok=True)
    output = output or home / f"{document.name}.mp4"

    started = time.perf_counter()
    spoken = await speak_film(services.speaker, settings.tts_provider, identity["voice"], [line["say"] for line in document.lines])
    voice_seconds = time.perf_counter() - started
    voiced_film = home / f"{document.name}.voiced.jsonl"
    voiced_film.write_text(document.with_voices([line.voice.for_player() for line in spoken]))
    problems = audit_problems(json.loads(film_tool(services, "audit", "--film", str(voiced_film), capture=True).stdout))

    silent = home / f"{document.name}.silent.mp4"
    arguments = ["render", "--film", str(voiced_film), "--out", str(silent)]
    if seconds is not None:
        arguments += ["--seconds", str(seconds)]
    started = time.perf_counter()
    video = film_tool(services, *arguments, capture=True)
    video_seconds = time.perf_counter() - started

    manifest = json.loads(Path(f"{silent}.manifest.json").read_text())
    started = time.perf_counter()
    report = mix.build_mix(manifest, spoken, kit_named(identity["soundKit"]), home / "audio")
    output.parent.mkdir(parents=True, exist_ok=True)
    mix.mux(silent, home / "audio" / "master.wav", output)
    mix_seconds = time.perf_counter() - started
    stage_seconds = {"voice": voice_seconds, "draw": video_seconds, "mix": mix_seconds}
    measures = {"stageSeconds": stage_seconds, "renderMinutes": sum(stage_seconds.values()) / 60}
    sidecar = {**manifest, "voiceLines": [str(line.path) for line in spoken], "says": [line["say"] for line in document.lines], "voiceWords": [line.voice.for_player()["words"] for line in spoken], "measures": measures}
    Path(f"{output}.manifest.json").write_text(json.dumps(sidecar))
    return RenderResult(output, voiced_film, video_seconds, report, video.stdout.strip(), problems)
