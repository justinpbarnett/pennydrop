from __future__ import annotations

import re
from dataclasses import dataclass

from num2words import num2words

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


def comparable_words(text: str) -> list[str]:
    words: list[str] = []
    for token in text.replace("-", " ").split():
        word = normalize_word(token).lower()
        if word.isdigit():
            words += num2words(int(word)).replace("-", " ").replace(",", " ").split()
        elif word:
            words.append(word)
    return words
