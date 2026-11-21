from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from pathlib import Path

from ..gateway import Gateway, Image, RequestOptions
from ..settings import Job
from ..store import CallStats

THEMES = ("pattern", "film", "kids", "plain")
MAX_DEFECTS_PER_THEME = 6
JUDGE_TIMEOUT_SECONDS = 240.0

SYSTEM = """You are a strict visual reviewer for an educational animation app.
You are shown frames from one Lesson, taken at different times, all drawn in one visual theme on a 1600 by 900 stage.
List only concrete, visible defects, each one a thing a designer would send back:
- overlap: marks, text or shapes covering each other when they should not
- clipping: anything cut off by the stage edge or by its own box
- text touching: text touching or crossing a line, border or neighbouring shape
- contrast: text or marks that are hard to read against what is behind them
- composition: the drawing is empty, tiny, lopsided, or crowded into one part of the stage when it could use the space; a panel or row where the marks sit in one corner and more than a third of its width is blank, items unevenly spaced from the label next to them, and a title or caption that is not aligned to anything are all defects
- reading: placeholder, garbled or wrong looking labels
A frame can be captured in the middle of an op, and the player crossfades text that changes, so two strings overlapping while one fades out is not a defect unless the final settled state also has the overlap.
Do not report the shapes of the theme's typeface glyphs (such as a 1 resembling an I), theme colors the Lab cannot choose, taste, motion, or anything you cannot point to in a specific frame.
Reply with JSON only: a list of at most %d objects {"frame": <number of the frame, starting at 1>, "defect": "<what is wrong and where, in one sentence>", "fix": "<what to change in the drawing code>"}.
Reply with [] when the frames have no such defect.""" % MAX_DEFECTS_PER_THEME


@dataclass(frozen=True)
class Defect:
    theme: str
    frame: str
    defect: str
    fix: str

    def __str__(self) -> str:
        return f"[{self.theme}, {self.frame}] {self.defect} Fix: {self.fix}"


@dataclass(frozen=True)
class Verdict:
    defects: list[Defect]
    calls: list[CallStats]


async def judge(gateway: Gateway, frames_dir: Path, lab_id: str) -> Verdict:
    results = await asyncio.gather(*(_judge_theme(gateway, frames_dir, lab_id, theme) for theme in THEMES))
    return Verdict([defect for defects, _ in results for defect in defects], [stats for _, stats in results if stats])


async def _judge_theme(gateway: Gateway, frames_dir: Path, lab_id: str, theme: str) -> tuple[list[Defect], CallStats | None]:
    files = sorted(frames_dir.glob(f"lesson-{theme}-*.png"), key=_time_of)
    if not files:
        return [], None
    options: RequestOptions = {"system": SYSTEM, "images": tuple(Image.from_file(file) for file in files), "timeout": JUDGE_TIMEOUT_SECONDS}
    names = ", ".join(f"frame {index} is at {_time_of(file):.2f} s" for index, file in enumerate(files, 1))
    completion = await gateway.complete(Job.VISION, f"These {len(files)} frames come from the example Lesson of a Lab called '{lab_id}', in the '{theme}' theme: {names}.", **options)
    labels = {str(index): f"t={_time_of(file):.2f}" for index, file in enumerate(files, 1)}
    return _defects(theme, completion.text, labels), completion.stats


def _time_of(file: Path) -> float:
    return float(file.stem.rsplit("-", 1)[1])


def _defects(theme: str, text: str, labels: dict[str, str]) -> list[Defect]:
    match = re.search(r"\[.*\]", text, re.DOTALL)
    if match is None:
        return []
    try:
        items = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    return [
        Defect(theme, labels.get(str(item.get("frame")), f"frame {item.get('frame')}"), str(item.get("defect", "")), str(item.get("fix", "")))
        for item in items[:MAX_DEFECTS_PER_THEME]
        if isinstance(item, dict) and item.get("defect")
    ]
