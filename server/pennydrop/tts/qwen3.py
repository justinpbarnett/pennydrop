from __future__ import annotations

import asyncio
import hashlib
import io
import re
import threading

import mlx.core
import numpy
import soundfile

from .provider import Provider, Synthesis, TtsError

SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
SHORTEST_CHUNK = 24


class Qwen3Provider(Provider):
    name = "qwen3"

    def __init__(self, settings, section):
        super().__init__(settings, section)
        self._model = None
        self._busy = threading.Lock()

    def warm(self) -> None:
        with self._busy:
            self._loaded()

    async def synthesize(self, text: str, voice: str) -> Synthesis:
        return await asyncio.to_thread(self._synthesize_blocking, text, voice)

    def _loaded(self):
        if self._model is None:
            from mlx_audio.tts.utils import load_model

            self._model = load_model(self.section["model"])
        return self._model

    def _synthesize_blocking(self, text: str, voice: str) -> Synthesis:
        pieces = _sentences(text)
        if not pieces:
            raise TtsError("qwen3 was given no text to speak")
        with self._busy:
            model = self._loaded()
            sample_rate = model.sample_rate
            pause = numpy.zeros(int(sample_rate * self.section["pause_seconds"]), dtype="float32")
            parts = []
            for piece in pieces:
                mlx.core.random.seed(_seed(piece, voice, self.section["instruct"]))
                results = model.generate(piece, voice=voice, lang_code=self.section["language"], instruct=self.section["instruct"] or None)
                spoken = [numpy.asarray(result.audio, dtype="float32").reshape(-1) for result in results]
                if not spoken:
                    raise TtsError(f"qwen3 produced no audio for: {piece}")
                parts += [*spoken, pause]
        audio = numpy.concatenate(parts[:-1])
        buffer = io.BytesIO()
        soundfile.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
        return Synthesis(buffer.getvalue(), "wav", len(audio) / sample_rate, None)


def _seed(piece: str, voice: str, instruct: str) -> int:
    return int.from_bytes(hashlib.sha256(f"{voice}\n{instruct}\n{piece}".encode()).digest()[:4], "big")


def _sentences(text: str) -> list[str]:
    chunks: list[str] = []
    carried = ""
    for sentence in SENTENCE_END.split(" ".join(text.split())):
        carried = f"{carried} {sentence}".strip()
        if len(carried) >= SHORTEST_CHUNK:
            chunks.append(carried)
            carried = ""
    if carried:
        if chunks:
            chunks[-1] = f"{chunks[-1]} {carried}"
        else:
            chunks.append(carried)
    return chunks
