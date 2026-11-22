from __future__ import annotations

import re
from collections.abc import Callable

LETTER_TOKEN = re.compile(r"(?<![\w'’])([A-Z])(?![\w'’])")
SENTENCE_START = re.compile(r"(?:^|[.!?]\s+|\n)$")

NAMES = {
    "A": "ay", "B": "bee", "C": "see", "D": "dee", "E": "ee", "F": "eff", "G": "gee", "H": "aitch", "J": "jay", "K": "kay",
    "L": "ell", "M": "em", "N": "en", "O": "oh", "P": "pee", "Q": "queue", "R": "are", "S": "ess", "T": "tee", "U": "you",
    "V": "vee", "W": "double you", "X": "ex", "Y": "why", "Z": "zee",
}
KOKORO_PHONEMES = {
    "A": "ˈA", "B": "bˈi", "C": "sˈi", "D": "dˈi", "E": "ˈi", "F": "ˈɛf", "G": "ʤˈi", "H": "ˈAʧ", "J": "ʤˈA", "K": "kˈA",
    "L": "ˈɛl", "M": "ˈɛm", "N": "ˈɛn", "O": "ˈO", "P": "pˈi", "Q": "kjˈu", "R": "ˈɑɹ", "S": "ˈɛs", "T": "tˈi", "U": "jˈu",
    "V": "vˈi", "W": "dˈʌbᵊlju", "X": "ˈɛks", "Y": "wˈI", "Z": "zˈi",
}


def spelled_letters(text: str) -> list[re.Match]:
    return [match for match in LETTER_TOKEN.finditer(text) if match.group(1) in NAMES and not _is_article(text, match)]


def _is_article(text: str, match: re.Match) -> bool:
    return match.group(1) == "A" and bool(SENTENCE_START.search(text[: match.start()]))


def rewrite_letters(text: str, spell: Callable[[str], str]) -> str:
    pieces, cursor = [], 0
    for match in spelled_letters(text):
        pieces += [text[cursor : match.start()], spell(match.group(1))]
        cursor = match.end()
    return "".join(pieces) + text[cursor:]


def respelled(text: str) -> str:
    return rewrite_letters(text, lambda letter: NAMES[letter])


def phonemized(text: str) -> str:
    return rewrite_letters(text, lambda letter: f"[{letter}](/{KOKORO_PHONEMES[letter]}/)")
