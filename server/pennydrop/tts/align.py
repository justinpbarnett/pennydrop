from __future__ import annotations

from difflib import SequenceMatcher

from ..words import WordTiming, spoken_words


def align_to_text(text: str, heard: list[WordTiming]) -> list[WordTiming]:
    expected = spoken_words(text)
    matcher = SequenceMatcher(a=[w.lower() for w in expected], b=[h.word.lower() for h in heard], autojunk=False)
    timings: list[WordTiming | None] = [None] * len(expected)
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            timings[block.a + offset] = WordTiming(expected[block.a + offset], heard[block.b + offset].start, heard[block.b + offset].end)
    return _fill_gaps(expected, timings, heard[-1].end if heard else 0.0)


def _fill_gaps(expected: list[str], timings: list[WordTiming | None], total: float) -> list[WordTiming]:
    filled: list[WordTiming] = []
    index = 0
    while index < len(timings):
        if timings[index] is not None:
            filled.append(timings[index])
            index += 1
            continue
        gap_end = index
        while gap_end < len(timings) and timings[gap_end] is None:
            gap_end += 1
        start = filled[-1].end if filled else 0.0
        end = timings[gap_end].start if gap_end < len(timings) else max(total, start)
        step = (end - start) / (gap_end - index)
        for position in range(index, gap_end):
            filled.append(WordTiming(expected[position], start + step * (position - index), start + step * (position - index + 1)))
        index = gap_end
    return filled
