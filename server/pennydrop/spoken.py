from __future__ import annotations

import difflib
import re


def word_error_rate(expected: list[str], actual: list[str]) -> float:
    previous = list(range(len(actual) + 1))
    for row, word in enumerate(expected, start=1):
        current = [row]
        for column, other in enumerate(actual, start=1):
            current.append(min(previous[column] + 1, current[-1] + 1, previous[column - 1] + (word != other)))
        previous = current
    return previous[-1] / len(expected) if expected else 0.0


def misheard(expected: list[str], actual: list[str]) -> list[dict]:
    matcher = difflib.SequenceMatcher(a=expected, b=actual, autojunk=False)
    return [
        {"expected": " ".join(expected[a1:a2]), "heard": " ".join(actual[b1:b2])}
        for tag, a1, a2, b1, b2 in matcher.get_opcodes() if tag != "equal"
    ]


UNITS = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9}
TEENS = {"ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19}
TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
SCALES = {"hundred": 100, "thousand": 1000, "million": 1_000_000}
SMALL = {**UNITS, **TEENS, **TENS}
NUMBER_WORDS = {**SMALL, **SCALES}
ORDINALS = {
    "first": "one", "second": "two", "third": "three", "fourth": "four", "fifth": "five", "sixth": "six", "seventh": "seven", "eighth": "eight", "ninth": "nine",
    "tenth": "ten", "eleventh": "eleven", "twelfth": "twelve", "thirteenth": "thirteen", "fourteenth": "fourteen", "fifteenth": "fifteen", "sixteenth": "sixteen",
    "seventeenth": "seventeen", "eighteenth": "eighteen", "nineteenth": "nineteen", "twentieth": "twenty", "thirtieth": "thirty", "fortieth": "forty",
    "fiftieth": "fifty", "sixtieth": "sixty", "seventieth": "seventy", "eightieth": "eighty", "ninetieth": "ninety",
}
ORDINAL_SUFFIXES = {"st", "nd", "rd", "th"}
ALPHANUMERIC_RUN = re.compile(r"\d+|[^\W\d_]+")


def comparable_script(text: str) -> list[str]:
    tokens = _as_cardinals([run for raw in text.lower().replace("-", " ").split() for run in ALPHANUMERIC_RUN.findall(raw)])
    words: list[str] = []
    run: list[str] = []
    for index, token in enumerate(tokens + [""]):
        joins_scale = token == "and" and run and run[-1] in SCALES and tokens[index + 1 : index + 2] and _is_number(tokens[index + 1])
        if _is_number(token) or joins_scale:
            run.append(token)
            continue
        if run:
            words.append(_numeral(run))
            run = []
        if token:
            words.append(token)
    return words


def _as_cardinals(tokens: list[str]) -> list[str]:
    cardinals: list[str] = []
    for index, token in enumerate(tokens):
        after_number = bool(cardinals) and _is_number(cardinals[-1])
        before_number = index + 1 < len(tokens) and (_is_number(tokens[index + 1]) or tokens[index + 1] in ORDINALS)
        if token in ORDINAL_SUFFIXES and cardinals and cardinals[-1].isdigit():
            continue
        if token == "oh" and after_number and before_number:
            cardinals.append("0")
        else:
            cardinals.append(ORDINALS.get(token, token))
    return cardinals


def _is_number(token: str) -> bool:
    return token.isdigit() or token in NUMBER_WORDS


def _numeral(run: list[str]) -> str:
    if all(token.isdigit() or token in UNITS for token in run):
        return "".join(token if token.isdigit() else str(UNITS[token]) for token in run)
    if not any(token in SCALES for token in run):
        return "".join(str(group) for group in _groups(run))
    total, current = 0, 0
    for token in run:
        if token.isdigit():
            current += int(token)
        elif token == "and":
            continue
        elif token in SMALL:
            current += SMALL[token]
        elif SCALES[token] == 100:
            current = max(current, 1) * 100
        else:
            total += max(current, 1) * SCALES[token]
            current = 0
    return str(total + current)


def _groups(run: list[str]) -> list[int | str]:
    groups: list[int | str] = []
    for token in run:
        if token.isdigit():
            groups.append(token)
        elif groups and isinstance(groups[-1], int) and groups[-1] >= 20 and groups[-1] % 10 == 0 and token in UNITS and UNITS[token] > 0:
            groups[-1] += UNITS[token]
        else:
            groups.append(SMALL[token])
    return groups
