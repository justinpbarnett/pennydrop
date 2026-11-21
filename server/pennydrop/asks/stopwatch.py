from __future__ import annotations

import time


class Stopwatch:
    def __init__(self, started: float | None = None):
        self._started = time.monotonic() if started is None else started
        self.marks: dict[str, float] = {}

    def elapsed(self) -> float:
        return time.monotonic() - self._started

    def mark(self, name: str) -> float:
        if name not in self.marks:
            self.marks[name] = self.elapsed()
        return self.marks[name]
