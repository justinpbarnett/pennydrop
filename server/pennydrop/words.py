from __future__ import annotations

import re
from dataclasses import dataclass

EDGE_PUNCTUATION = re.compile(r"^[^\w]+|[^\w]+$")


@dataclass(frozen=True)
class WordTiming:
    word: str
    start: float
    end: float


def normalize_word(raw: str) -> str:
    return EDGE_PUNCTUATION.sub("", raw)


def spoken_words(text: str) -> list[str]:
    return [word for word in map(normalize_word, text.split()) if word]
