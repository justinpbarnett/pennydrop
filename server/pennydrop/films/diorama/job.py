"""One job: read it, do what its mode asks, and always leave a report beside the pictures."""

import json
import time as clock
from pathlib import Path

from . import catalog
from .checks import watch
from .format import Anything, custom_kinds, read_design, read_shot
from .maths import clamp
from .render import FINAL_SAMPLES, PREVIEW_SAMPLES, PREVIEW_SIZE, fresh_scene, picture
from .spec import Choice, Many, Number, Reading, Record, Text, Vector, Whole
from .staging import stage_shot

MOST_STILLS = 6
PEAK_AFTER = 0.5
SHEET_SET = "sheet_backdrop"
SHEET_BACKDROP = {"bounds": [-8, -8, 8, 8], "ground": {"cover": "sand", "rough": 0.0}}
JOB = Record(
    mode=Choice(["catalog", "sheet", "preview", "final"], "mode"), out=Text(1000), design=(Anything(), None), shot=(Anything(), None),
    words=(Many(Record(word=Text(80), start=Number(-600, 6000), end=Number(-600, 6000))), []), duration=(Number(0.1, 600), None),
    stills=(Many(Number(0, 600), most=MOST_STILLS), []), render=(Record(offset=(Number(-1, 600), 0.0), count=Whole(1, 100000)), None),
    fps=(Whole(1, 120), 24), size=(Vector(2, 16, 8192), (1920, 1080)),
)  # fmt: skip


class Work:
    """A job under way: its report, and the clocks that fill the report's measures."""

    def __init__(self, job, reading):
        self.job, self.reading, self.out = job, reading, Path(job["out"])
        self.problems, self.stills, self.events, self.catalog = [], [], [], {}
        self.build_seconds, self.render_seconds, self.frames = 0.0, 0.0, 0

    def stage(self, raw_design, raw_shot, duration, size, samples):
        """A fresh scene with the shot built in it, or None when the design or the shot has errors."""
        started = clock.monotonic()
        design = read_design(raw_design, self.reading)
        shot = read_shot(raw_shot, raw_design, self.reading)
        staged = None
        if design is not None and shot is not None and not self.reading.errors:
            fresh_scene(size, samples, self.job["fps"])
            staged = stage_shot(design, shot, self.job["words"], duration, self.job["fps"], self.reading)
        self.build_seconds += clock.monotonic() - started
        return staged

    def picture(self, stage, time, name):
        started = clock.monotonic()
        picture(stage, time, self.out / name)
        self.render_seconds += clock.monotonic() - started
        self.frames += 1

    def still(self, stage, time, name, caption):
        self.picture(stage, time, name)
        self.stills.append({"time": round(time, 3), "path": str(self.out / name), "caption": caption})

    def report(self):
        return {
            "errors": self.reading.errors, "problems": self.problems, "stills": self.stills, "events": self.events,
            "measures": {"build_seconds": round(self.build_seconds, 2), "render_seconds": round(self.render_seconds, 2), "frames": self.frames},
            "catalog": self.catalog,
        }  # fmt: skip


def _catalog(work):
    fresh_scene(PREVIEW_SIZE, PREVIEW_SAMPLES, work.job["fps"])
    work.catalog = catalog.describe()


def _reference_shots(raw_design):
    """A shot for each thing a design declares: (file name, caption, set to add, shot)."""
    design = raw_design if isinstance(raw_design, dict) else {}
    characters = design.get("characters") if isinstance(design.get("characters"), dict) else {}
    for look_id in design.get("looks") or {}:
        wearer = next((character_id for character_id, character in characters.items() if isinstance(character, dict) and character.get("look") == look_id), None)
        model = {"character": wearer} if wearer else {"id": "model"}
        shot = {"set": SHEET_SET, "subject": [wearer or "model"], "size": "full", "people": [{**model, "look": look_id, "position": [0, 0]}]}
        yield f"look_{look_id}.png", f"look '{look_id}'" + (f", worn by '{wearer}'" if wearer else ""), shot
    for prop_id in custom_kinds(design):
        shot = {"set": SHEET_SET, "subject": ["shown"], "size": "full", "props": [{"id": "shown", "kind": prop_id, "position": [0, 0]}]}
        yield f"prop_{prop_id}.png", f"custom prop '{prop_id}'", shot
    for set_id, chosen in (design.get("sets") or {}).items():
        bounds = chosen.get("bounds") if isinstance(chosen, dict) else None
        if not (isinstance(bounds, list) and len(bounds) == 4 and all(isinstance(edge, (int, float)) for edge in bounds)):
            continue
        middle = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]
        across = max(bounds[2] - bounds[0], bounds[3] - bounds[1], 4)
        marker = {"id": "sheet_marker", "kind": "crates", "position": middle}
        camera = {"keys": [{"targets": [middle], "bearing": 25, "height": clamp(0.3 * across, 1.6, 120), "distance": clamp(0.85 * across, 3, 800)}]}
        yield f"set_{set_id}.png", f"set '{set_id}'", {"set": set_id, "subject": ["sheet_marker"], "size": "wide", "props": [marker], "camera": camera}


def _sheet(work):
    raw_design = work.job["design"]
    if read_design(raw_design, work.reading) is None:
        return
    with_backdrop = {**raw_design, "sets": {**raw_design.get("sets", {}), SHEET_SET: SHEET_BACKDROP}}
    for name, caption, shot in _reference_shots(raw_design):
        staged = work.stage(with_backdrop, shot, 1.0, PREVIEW_SIZE, PREVIEW_SAMPLES)
        if staged is not None:
            work.still(staged.stage, 0.0, name, caption)


def _peaks(stage):
    """Moments worth a still: shortly after each thing that happens, spread over the shot."""
    spread = stage.duration / (MOST_STILLS + 1)
    wanted = [clamp(event["time"] + PEAK_AFTER, 0.0, stage.duration) for event in stage.sounds]
    chosen = []
    for time in [*wanted, *(stage.duration * share for share in (0.5, 0.1, 0.9, 0.3, 0.7))]:
        if len(chosen) < MOST_STILLS and all(abs(time - other) >= spread for other in chosen):
            chosen.append(time)
    return sorted(chosen)


def _caption(stage, time):
    recent = [f"{event['kind']} ({event['source']})" for event in stage.sounds if time - 1.5 <= event["time"] <= time]
    return f"{time:.1f} s" + (": " + ", ".join(recent[-4:]) if recent else "")


def _whole_shot(work, size, samples):
    job = work.job
    if job["duration"] is None:
        work.reading.fail("job", "the required key 'duration' is missing: the shot's length in seconds")
        return None
    staged = work.stage(job["design"], job["shot"], job["duration"], size, samples)
    if staged is not None:
        work.events = sorted(staged.stage.sounds, key=lambda event: event["time"])
    return staged


def _preview(work):
    staged = _whole_shot(work, PREVIEW_SIZE, PREVIEW_SAMPLES)
    if staged is None:
        return
    work.problems = watch(staged)
    for time in work.job["stills"] or _peaks(staged.stage):
        time = clamp(time, 0.0, staged.stage.duration)
        work.still(staged.stage, time, f"still_{round(time * 100):05d}.png", _caption(staged.stage, time))


def _final(work):
    job = work.job
    if job["render"] is None:
        work.reading.fail("job", "the required key 'render' is missing: {\"offset\": seconds into the shot, \"count\": frames}")
        return
    staged = _whole_shot(work, job["size"], FINAL_SAMPLES)
    if staged is None:
        return
    for frame in range(job["render"]["count"]):
        name = f"{frame:04d}.png"
        if not (work.out / name).exists():
            work.picture(staged.stage, clamp(job["render"]["offset"] + frame / job["fps"], 0.0, staged.stage.duration), name)


MODES = {"catalog": _catalog, "sheet": _sheet, "preview": _preview, "final": _final}


def run(job_path):
    reading = Reading()
    raw_job = json.loads(Path(job_path).read_text())
    job = JOB.read(raw_job, "job", reading)
    out = Path(raw_job["out"])
    out.mkdir(parents=True, exist_ok=True)
    work = Work(job or {"out": raw_job["out"]}, reading)
    if job is not None:
        MODES[job["mode"]](work)
    (out / "report.json").write_text(json.dumps(work.report(), indent=1))
