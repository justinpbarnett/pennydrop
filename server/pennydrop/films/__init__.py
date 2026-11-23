from __future__ import annotations

from .check import FilmReport, check_film, format_report
from .design import design
from .document import FilmError
from .factcheck import factcheck
from .narration import narrate
from .render import render
from .research import pattern, research
from .script import script
from .shoot import shoot
from .storyboard import storyboard
from .workspace import Workspace

STAGES = {
    "research": research,
    "pattern": pattern,
    "script": script,
    "factcheck": factcheck,
    "narrate": narrate,
    "storyboard": storyboard,
    "design": design,
    "shoot": shoot,
    "render": render,
}

__all__ = ["STAGES", "FilmError", "FilmReport", "Workspace", "check_film", "format_report"]
