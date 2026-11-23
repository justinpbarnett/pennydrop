from __future__ import annotations

import asyncio
import io
import queue
import threading
import warnings

import soundfile

from ..words import WordTiming, normalize_word
from .letters import phonemized
from .pronunciations import kokoro_names
from .provider import Provider, Synthesis, TtsError

SAMPLE_RATE = 24000
ESPEAK_INIT = threading.Lock()


class KokoroProvider(Provider):
    name = "kokoro"
    paces = True

    def __init__(self, settings, section):
        super().__init__(settings, section)
        self._pipelines: queue.Queue = queue.Queue()
        for _ in range(section["workers"]):
            self._pipelines.put(None)

    def warm(self) -> None:
        pipelines = [self._borrow() for _ in range(self.section["workers"])]
        try:
            for pipeline in pipelines:
                self._speak_with(pipeline, "Ready.", self.default_voice, 1.0)
        finally:
            for pipeline in pipelines:
                self._pipelines.put(pipeline)

    def speakable(self, text: str) -> str:
        return kokoro_names(phonemized(text))

    async def synthesize(self, text: str, voice: str, pace: float) -> Synthesis:
        return await asyncio.to_thread(self._synthesize_blocking, text, voice, pace)

    def _borrow(self):
        pipeline = self._pipelines.get()
        if pipeline is not None:
            return pipeline
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                from kokoro import KPipeline

                with ESPEAK_INIT:
                    return KPipeline(lang_code=self.section["language"], repo_id="hexgrad/Kokoro-82M")
        except BaseException:
            self._pipelines.put(None)
            raise

    def _speak_with(self, pipeline, text: str, voice: str, pace: float) -> tuple[list, list[WordTiming], float]:
        chunks = []
        words: list[WordTiming] = []
        offset_seconds = 0.0
        for result in pipeline(text, voice=voice, speed=self.section["speed"] * pace):
            chunks.append(result.audio.numpy())
            words += _words_from(result.tokens, offset_seconds)
            offset_seconds += len(result.audio) / SAMPLE_RATE
        return chunks, words, offset_seconds

    def _synthesize_blocking(self, text: str, voice: str, pace: float) -> Synthesis:
        import numpy

        pipeline = self._borrow()
        try:
            chunks, words, offset_seconds = self._speak_with(pipeline, text, voice, pace)
        finally:
            self._pipelines.put(pipeline)
        if not chunks:
            raise TtsError("kokoro produced no audio for the text")
        buffer = io.BytesIO()
        soundfile.write(buffer, numpy.concatenate(chunks), SAMPLE_RATE, format="WAV", subtype="PCM_16")
        return Synthesis(buffer.getvalue(), "wav", offset_seconds, words)


def _words_from(tokens, offset_seconds: float) -> list[WordTiming]:
    words = []
    pieces: list[str] = []
    spans: list[tuple[float, float]] = []
    previous_end = 0.0
    for token in tokens:
        pieces.append(token.text)
        if normalize_word(token.text):
            start = token.start_ts if token.start_ts is not None else previous_end
            end = token.end_ts if token.end_ts is not None else start
            spans.append((start, end))
            previous_end = end
        if token.whitespace or token is tokens[-1]:
            word = normalize_word("".join(pieces))
            if word and spans:
                words.append(WordTiming(word, offset_seconds + spans[0][0], offset_seconds + spans[-1][1]))
            pieces, spans = [], []
    return words
