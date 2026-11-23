from __future__ import annotations

from .check import FilmReport, check_film, format_report
from .document import FilmError
from .factcheck import factcheck
from .plan import plan, revise
from .render import RenderResult, render_film
from .research import pattern, research
from .script import script
from .workspace import Workspace

STAGES = {"research": research, "pattern": pattern, "script": script, "factcheck": factcheck, "plan": plan, "revise": revise}

__all__ = ["STAGES", "FilmError", "FilmReport", "RenderResult", "Workspace", "check_film", "format_report", "render_film"]
