from __future__ import annotations

import asyncio
import json
import math
import time
from pathlib import Path

from ..services import Services
from . import mix
from .blender import Engine
from .document import FilmError
from .kits import kit_named
from .narration import Narration
from .shoot import read_take
from .storyboard import Shot, read_shots
from .workspace import Workspace

FPS = 24
SIZE = (1920, 1080)
SOUND_KIT = "warm-hall"
ACCENTS = {"fire": ("hit", 0.5)}
QUALITY = ["-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p"]


async def ffmpeg(*arguments: str) -> None:
    process = await asyncio.create_subprocess_exec("ffmpeg", "-y", "-v", "error", *arguments, stderr=asyncio.subprocess.PIPE)
    _, errors = await process.communicate()
    if process.returncode != 0:
        raise FilmError(f"ffmpeg {' '.join(arguments[:4])} ... failed: {errors.decode(errors='replace')[-2000:]}")


async def frame_count(video: Path) -> int:
    process = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", str(video), stdout=asyncio.subprocess.PIPE
    )
    output, _ = await process.communicate()
    return int(output.strip() or 0)


class Cutter:
    """Renders each shot's frames on the Film's one clock and cuts them together, so shot k's first frame is the Film's frame round(start × fps)."""

    def __init__(self, services: Services, workspace: Workspace, narration: Narration):
        self._workspace = workspace
        self._engine = Engine(services.settings)
        self._design = workspace.read("design")
        self._total = math.ceil(narration.duration * FPS)

    @property
    def seconds(self) -> float:
        return self._total / FPS

    def frames_of(self, shot: Shot, last: bool) -> tuple[int, int]:
        return round(shot.start * FPS), self._total if last else round(shot.end * FPS)

    async def segment(self, shot: Shot, last: bool) -> tuple[Path, list[dict]]:
        """Renders one shot to a video segment, resuming frames already on disk, and returns the segment and its sound events on the Film clock."""
        taken = read_take(self._workspace, self._design, shot)
        if taken is None or not taken[1]:
            raise FilmError(f"shot {shot.id} has no current take; run the shoot stage first")
        first, end = self.frames_of(shot, last)
        folder = self._workspace.frames / shot.id
        segment = self._workspace.frames / f"{shot.id}.mp4"
        report_path = folder / "report.json"
        if not (segment.exists() and report_path.exists() and await frame_count(segment) == end - first):
            job = {
                "mode": "final",
                "out": str(folder),
                "design": self._design,
                "shot": taken[0],
                "words": shot.local_words(),
                "duration": round(shot.seconds, 3),
                "render": {"offset": round(first / FPS - shot.start, 6), "count": end - first},
                "fps": FPS,
                "size": list(SIZE),
            }
            report = await self._engine.run(job)
            if report["errors"]:
                raise FilmError(f"shot {shot.id}'s take no longer validates; run the shoot stage again:\n" + "\n".join(f"- {error}" for error in report["errors"]))
            await ffmpeg("-framerate", str(FPS), "-i", str(folder / "%04d.png"), *QUALITY, "-r", str(FPS), str(segment))
            if await frame_count(segment) != end - first:
                raise FilmError(f"shot {shot.id} rendered {await frame_count(segment)} frames, not {end - first}; its engine log is {folder / 'engine.log'}")
            for frame in folder.glob("[0-9][0-9][0-9][0-9].png"):
                frame.unlink()
        events = json.loads(report_path.read_text())["events"]
        return segment, [{**event, "time": round(shot.start + event["time"], 3)} for event in events]


async def render(services: Services, workspace: Workspace) -> dict:
    started = time.perf_counter()
    narration = Narration.read(workspace)
    shots = read_shots(workspace)
    workspace.frames.mkdir(parents=True, exist_ok=True)
    cutter = Cutter(services, workspace, narration)
    cut = await asyncio.gather(*(cutter.segment(shot, index == len(shots) - 1) for index, shot in enumerate(shots)))

    listing = workspace.frames / "segments.txt"
    listing.write_text("".join(f"file '{segment.name}'\n" for segment, _ in cut))
    picture = workspace.frames / "picture.mp4"
    await ffmpeg("-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(picture))
    if await frame_count(picture) != round(cutter.seconds * FPS):
        raise FilmError(f"{picture} has {await frame_count(picture)} frames, not the {round(cutter.seconds * FPS)} the narration needs")

    accents = [mix.Accent(event["time"], *ACCENTS[event["kind"]]) for _, events in cut for event in events if event["kind"] in ACCENTS]
    report = await asyncio.to_thread(mix.build_mix, narration.audio, accents, cutter.seconds, kit_named(SOUND_KIT), workspace.home / "audio")
    film = workspace.home / f"{workspace.thread}.mp4"
    await asyncio.to_thread(mix.mux, picture, workspace.home / "audio" / "master.wav", film)
    rendered = {
        "film": str(film),
        "seconds": round(cutter.seconds, 3),
        "shots": len(shots),
        "accents": len(accents),
        "loudness": {"voice": report.voice.integrated, "bed": report.bed.integrated, "master": report.master.integrated, "true_peak": report.master.true_peak},
        "minutes": round((time.perf_counter() - started) / 60, 1),
    }
    workspace.write("render.json", rendered)
    return rendered
