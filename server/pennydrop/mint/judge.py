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

SYSTEM = f"""You are a strict visual reviewer for an educational animation app.
You are shown frames from one Lesson, taken at different times, all drawn in one visual theme on a 1600 by 900 stage.
List only concrete, visible defects, each one a thing a designer would send back:
- overlap: marks, text or shapes covering each other when they should not
- clipping: anything cut off by the stage edge or by its own box
- text touching: text touching or crossing a line, border or neighbouring shape
- contrast: text or marks that are hard to read against what is behind them
- composition: the drawing is empty, tiny, lopsided, or crowded into one part of the stage when it could use the space; a panel or row where the marks sit in one corner and more than a third of its width is blank, items unevenly spaced from the label next to them, and a title or caption that is not aligned to anything are all defects
Exact distances, margins and empty bands are measured by a separate geometry check, so do not estimate pixel distances or report a gap, margin or spacing unless it is plainly visible without measuring.
- reading: placeholder, garbled or wrong looking labels
- fill: a land, region or area fill that is not one continuous colour, that shows seams, rectangles or gaps, that does not follow its own outline, or that spills outside the box it belongs to; check this in every frame, including frames taken in the middle of a transition
- shifting layout: a panel, axis or row that sits at a different position in one frame than in the frames before it only because content arrived, when the Step did not change that position; compare each frame with the previous one
A frame can be captured in the middle of an op, and the player crossfades text that changes, so two strings overlapping while one fades out is not a defect unless the final settled state also has the overlap.
The layout places the whole Lab drawing in the middle of the stage, so blank stage around the outside of the drawing is never a defect.
A connector arrow that crosses a panel border to reach a part in another panel is correct, and an arrowhead that ends on its target part is correct; report an arrow only when it runs along or on top of a border line, its head covers text, or it points at nothing.
Do not report the shapes of the theme's typeface glyphs (such as a 1 resembling an I), theme colors the Lab cannot choose, taste, motion, or anything you cannot point to in a specific frame.
Report each defect once, at the first frame where it shows, even when it is visible in several frames.
Reply with JSON only: a list of at most {MAX_DEFECTS_PER_THEME} objects {{"frame": <number of the frame, starting at 1>, "defect": "<what is wrong and where, in one sentence>", "fix": "<what to change in the drawing code>"}}.
Reply with [] when the frames have no such defect."""


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


PREVIOUS_REVIEW = """
The previous review of an earlier version of this Lab found these problems, written as [theme, time] problem and fix:
{problems}

First check each one against these frames.
Report one again, in the same words, only when it is still plainly visible in these frames; leave it out when it is fixed.
Then add a new defect only when these frames show it clearly and it is not a matter of taste.
Never reverse an earlier verdict: if the previous review asked for a mark to be brighter, do not now ask for it to be dimmer, unless these frames plainly show the opposite defect.
Do not report something as new that was visible in the earlier frames and was not reported then, unless it is a clear overlap, clipping or contrast defect.
"""


async def judge(gateway: Gateway, frames_dir: Path, lab_id: str, previous: list[str] | None = None) -> Verdict:
    results = await asyncio.gather(*(_judge_theme(gateway, frames_dir, lab_id, theme, previous or []) for theme in THEMES))
    return Verdict([defect for defects, _ in results for defect in defects], [stats for _, stats in results if stats])


async def _judge_theme(gateway: Gateway, frames_dir: Path, lab_id: str, theme: str, previous: list[str]) -> tuple[list[Defect], CallStats | None]:
    files = sorted(frames_dir.glob(f"lesson-{theme}-*.png"), key=_time_of)
    if not files:
        return [], None
    options: RequestOptions = {"system": SYSTEM, "images": tuple(Image.from_file(file) for file in files), "timeout": JUDGE_TIMEOUT_SECONDS}
    names = ", ".join(f"frame {index} is at {_time_of(file):.2f} s" for index, file in enumerate(files, 1))
    prompt = f"These {len(files)} frames come from the example Lesson of a Lab called '{lab_id}', in the '{theme}' theme: {names}."
    if previous:
        prompt += PREVIOUS_REVIEW.format(problems="\n".join(f"- {line}" for line in previous))
    completion = await gateway.complete(Job.VISION, prompt, **options)
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


CONFIRM_SYSTEM = """You are a skeptical visual reviewer for an educational animation app.
You are shown frames from one Lesson, drawn in one visual theme on a 1600 by 900 stage, and one claimed defect from another reviewer.
Decide whether that defect is plainly visible in the frames, without measuring.
Answer false when the claim is about taste, when it describes a normal crossfade or a mark caught mid-motion, when the frames show it fixed, or when you cannot point to it in a specific frame.
Reply with JSON only: {"visible": true or false, "frame": <number of the frame that shows it, or 0>}"""


@dataclass(frozen=True)
class Confirmation:
    confirmed: list[Defect]
    raised: int
    calls: list[CallStats]


async def confirm(gateway: Gateway, frames_dir: Path, defects: list[Defect]) -> Confirmation:
    answers = await asyncio.gather(*(_confirm_one(gateway, frames_dir, defect) for defect in defects))
    confirmed = [defect for defect, (visible, _) in zip(defects, answers) if visible]
    return Confirmation(confirmed, len(defects), [stats for _, stats in answers if stats])


async def _confirm_one(gateway: Gateway, frames_dir: Path, defect: Defect) -> tuple[bool, CallStats | None]:
    files = sorted(frames_dir.glob(f"lesson-{defect.theme}-*.png"), key=_time_of)
    if not files:
        return True, None
    options: RequestOptions = {"system": CONFIRM_SYSTEM, "images": tuple(Image.from_file(file) for file in files), "timeout": JUDGE_TIMEOUT_SECONDS}
    names = ", ".join(f"frame {index} is at {_time_of(file):.2f} s" for index, file in enumerate(files, 1))
    claim = f"These {len(files)} frames are in the '{defect.theme}' theme: {names}.\nClaimed defect, reported at {defect.frame}: {defect.defect}"
    completion = await gateway.complete(Job.VISION, claim, **options)
    match = re.search(r"\{.*\}", completion.text, re.DOTALL)
    try:
        visible = bool(json.loads(match.group(0)).get("visible")) if match else True
    except (json.JSONDecodeError, AttributeError):
        visible = True
    return visible, completion.stats
