from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy
import soundfile

from ..services import Services
from ..spoken import comparable_script, misheard
from .document import FilmError
from .voices import speak_film
from .workspace import Workspace

NARRATOR = "narrator-low"
LEAD_SECONDS = 0.6
GAP_SECONDS = 0.45
TAIL_SECONDS = 1.0


@dataclass(frozen=True)
class Word:
    line: int
    text: str
    start: float
    end: float


@dataclass(frozen=True)
class Narration:
    audio: Path
    duration: float
    lines: list[dict]
    words: list[Word]

    @classmethod
    def read(cls, workspace: Workspace) -> Narration:
        timing = workspace.narration / "timing.json"
        if not timing.exists():
            raise FilmError(f"{timing} is missing; run the narrate stage first")
        saved = json.loads(timing.read_text())
        words = [Word(word["line"], word["word"], word["start"], word["end"]) for word in saved["words"]]
        return cls(workspace.narration / "narration.wav", saved["duration"], saved["lines"], words)


async def narrate(services: Services, workspace: Workspace) -> dict:
    scenes = workspace.read("script")["scenes"]
    says = [scene["say"] for scene in scenes]
    spoken = await speak_film(services.speaker, services.settings.tts_provider, NARRATOR, says)
    clips = [soundfile.read(line.path, dtype="float32", always_2d=True) for line in spoken]
    rates = {rate for _, rate in clips}
    if len(rates) != 1:
        raise FilmError(f"the narrator's lines came back at different sample rates: {sorted(rates)}")
    rate = rates.pop()

    lines, words, placed = [], [], []
    clock = LEAD_SECONDS
    for scene, line, (audio, _) in zip(scenes, spoken, clips, strict=True):
        seconds = len(audio) / rate
        lines.append({"line": scene["n"], "say": scene["say"], "start": round(clock, 3), "end": round(clock + seconds, 3)})
        words += [{"line": scene["n"], "word": word.word, "start": round(clock + word.start, 3), "end": round(clock + word.end, 3)} for word in line.voice.words]
        placed.append((clock, audio.mean(axis=1)))
        clock += seconds + GAP_SECONDS
    duration = clock - GAP_SECONDS + TAIL_SECONDS

    track = numpy.zeros(int(duration * rate) + 1, dtype=numpy.float32)
    for start, audio in placed:
        offset = int(start * rate)
        track[offset : offset + len(audio)] += audio
    workspace.narration.mkdir(parents=True, exist_ok=True)
    soundfile.write(workspace.narration / "narration.wav", track, rate)

    heard = []
    try:
        for scene, line in zip(scenes, spoken, strict=True):
            transcript = await services.transcriber.transcribe(line.path)
            heard += [{"line": scene["n"], **miss} for miss in misheard(comparable_script(scene["say"]), comparable_script(transcript))]
    finally:
        await services.transcriber.close()
    timing = {"duration": round(duration, 3), "lines": lines, "words": words, "misheard": heard}
    (workspace.narration / "timing.json").write_text(json.dumps(timing, indent=1, ensure_ascii=False) + "\n")
    return timing
