from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


class JsonIndex:
    def __init__(self, path: Path):
        self._path = path

    def get(self, key: str) -> Any | None:
        return self._read().get(key)

    def put(self, key: str, value: Any) -> None:
        entries = self._read()
        entries[key] = value
        self._path.parent.mkdir(parents=True, exist_ok=True)
        pending = self._path.with_suffix(f".{os.getpid()}.tmp")
        pending.write_text(json.dumps(entries, indent=1, sort_keys=True))
        pending.replace(self._path)

    def _read(self) -> dict[str, Any]:
        try:
            return json.loads(self._path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}
