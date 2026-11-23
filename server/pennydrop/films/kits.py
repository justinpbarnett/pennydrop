from __future__ import annotations

import hashlib
from dataclasses import dataclass

import numpy

from .document import FilmError

SAMPLE_RATE = 48000


@dataclass(frozen=True)
class SoundKit:
    name: str
    root_hz: float
    chord: tuple[float, ...]
    reverb_seconds: float

    def seed(self, purpose: str) -> int:
        return int.from_bytes(hashlib.sha256(f"{self.name}:{purpose}".encode()).digest()[:8], "big")

    def bed(self, seconds: float) -> numpy.ndarray:
        count = int(seconds * SAMPLE_RATE)
        time = numpy.arange(count) / SAMPLE_RATE
        channels = []
        for side in ("left", "right"):
            rng = numpy.random.default_rng(self.seed(f"bed-{side}"))
            signal = numpy.zeros(count)
            for ratio in self.chord:
                for partial, weight in ((1, 1.0), (2, 0.35), (3, 0.14)):
                    detune = 1 + rng.uniform(-0.0035, 0.0035)
                    phase = rng.uniform(0, 2 * numpy.pi)
                    swell = 0.6 + 0.4 * numpy.sin(2 * numpy.pi * rng.uniform(0.03, 0.09) * time + rng.uniform(0, 2 * numpy.pi))
                    signal += weight * swell * numpy.sin(2 * numpy.pi * self.root_hz * ratio * partial * detune * time + phase)
            room = _lowpass(rng.standard_normal(count), 220.0) * 6.0
            signal = signal / len(self.chord) + 0.25 * room
            channels.append(signal)
        bed = numpy.stack(channels, axis=1)
        fade = numpy.minimum(1.0, numpy.minimum(time / 3.0, (seconds - time) / 4.0))[:, None]
        return bed * fade

    def accent(self, tone: str) -> numpy.ndarray:
        if tone not in ACCENTS:
            raise FilmError(f"sound kit '{self.name}' has no tone '{tone}', known tones: {', '.join(ACCENTS)}")
        rng = numpy.random.default_rng(self.seed(f"accent-{tone}"))
        mono = ACCENTS[tone](self, rng)
        mono = _reverb(mono, self, rng)
        left = numpy.roll(mono, int(0.0004 * SAMPLE_RATE))
        return numpy.stack([mono, left], axis=1)


def _lowpass(signal: numpy.ndarray, cutoff_hz: float) -> numpy.ndarray:
    spectrum = numpy.fft.rfft(signal)
    frequencies = numpy.fft.rfftfreq(len(signal), 1 / SAMPLE_RATE)
    spectrum *= 1 / (1 + (frequencies / cutoff_hz) ** 4)
    return numpy.fft.irfft(spectrum, len(signal))


def _reverb(signal: numpy.ndarray, kit: SoundKit, rng: numpy.random.Generator) -> numpy.ndarray:
    length = int(kit.reverb_seconds * SAMPLE_RATE)
    impulse = rng.standard_normal(length) * numpy.exp(-numpy.arange(length) / (kit.reverb_seconds * SAMPLE_RATE / 5.5))
    impulse = _lowpass(impulse, 3500.0)
    impulse /= numpy.sqrt(numpy.sum(impulse**2))
    size = len(signal) + length
    wet = numpy.fft.irfft(numpy.fft.rfft(signal, size) * numpy.fft.rfft(impulse, size), size)
    padded = numpy.pad(signal, (0, length))
    return 0.7 * padded + 0.55 * wet


def _envelope(seconds: float, attack: float, decay: float) -> numpy.ndarray:
    time = numpy.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    return numpy.minimum(1.0, time / attack) * numpy.exp(-time / decay)


def _hit(kit: SoundKit, rng: numpy.random.Generator) -> numpy.ndarray:
    envelope = _envelope(2.4, 0.004, 0.55)
    time = numpy.arange(len(envelope)) / SAMPLE_RATE
    sweep = kit.root_hz * (1 + 1.2 * numpy.exp(-time / 0.06))
    body = numpy.sin(2 * numpy.pi * numpy.cumsum(sweep) / SAMPLE_RATE)
    thud = _lowpass(rng.standard_normal(len(envelope)), 400.0) * numpy.exp(-time / 0.08) * 8
    return (body + thud) * envelope


def _chime(kit: SoundKit, rng: numpy.random.Generator) -> numpy.ndarray:
    base = kit.root_hz * 8
    envelope = _envelope(3.0, 0.015, 0.7)
    time = numpy.arange(len(envelope)) / SAMPLE_RATE
    out = numpy.zeros(len(envelope))
    for ratio, weight, decay in ((1.0, 1.0, 1.0), (2.0, 0.3, 0.6), (2.76, 0.12, 0.35)):
        out += weight * numpy.sin(2 * numpy.pi * base * ratio * time + rng.uniform(0, 6.28)) * numpy.exp(-time / (0.7 * decay))
    return out * envelope


def _tick(kit: SoundKit, rng: numpy.random.Generator) -> numpy.ndarray:
    time = numpy.arange(int(0.35 * SAMPLE_RATE)) / SAMPLE_RATE
    click = rng.standard_normal(len(time)) * numpy.exp(-time / 0.006)
    ring = numpy.sin(2 * numpy.pi * kit.root_hz * 24 * time) * numpy.exp(-time / 0.05)
    return click * 0.5 + ring


def _rise(kit: SoundKit, rng: numpy.random.Generator) -> numpy.ndarray:
    seconds = 2.2
    time = numpy.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    noise = _lowpass(rng.standard_normal(len(time)), 1800.0)
    sweep = kit.root_hz * 4 * (1 + 2.0 * time / seconds)
    tone = numpy.sin(2 * numpy.pi * numpy.cumsum(sweep) / SAMPLE_RATE)
    envelope = (time / seconds) ** 2.2 * numpy.minimum(1.0, (seconds - time) / 0.25)
    return (0.5 * noise * 4 + tone) * envelope


def _swell(kit: SoundKit, rng: numpy.random.Generator) -> numpy.ndarray:
    seconds = 3.0
    time = numpy.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    out = numpy.zeros(len(time))
    for ratio in kit.chord:
        out += numpy.sin(2 * numpy.pi * kit.root_hz * 2 * ratio * time + rng.uniform(0, 6.28))
    return out * numpy.sin(numpy.pi * time / seconds) ** 2


ACCENTS = {"hit": _hit, "chime": _chime, "tick": _tick, "rise": _rise, "swell": _swell}

KITS = {
    "warm-hall": SoundKit("warm-hall", root_hz=55.0, chord=(1.0, 1.5, 2.0, 2.52), reverb_seconds=2.6),
}


def kit_named(name: str) -> SoundKit:
    if name not in KITS:
        raise FilmError(f"unknown sound kit '{name}', known kits: {', '.join(KITS)}")
    return KITS[name]
