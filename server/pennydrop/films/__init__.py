from __future__ import annotations

from .check import FilmReport, check_film, format_report
from .document import FilmError
from .factcheck import factcheck
from .plan import plan
from .render import RenderResult, render_film
from .research import pattern, research
from .script import script
from .workspace import Workspace

STAGES = {"research": research, "pattern": pattern, "script": script, "factcheck": factcheck, "plan": plan}

__all__ = ["FilmError", "FilmReport", "RenderResult", "STAGES", "Workspace", "check_film", "format_report", "render_film"]
