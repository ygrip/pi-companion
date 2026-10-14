#!/usr/bin/env python3
"""Synthesize the promo soundtrack and UI sound effects into ../media/.

Everything is generated from oscillators and noise here, so the audio is original and
royalty-free (same license as this repository). Requires numpy and ffmpeg.

    python3 tools/promo-video/audio/generate.py
"""
import subprocess
import wave
from pathlib import Path

import numpy as np

SR = 44100
OUT = Path(__file__).resolve().parent.parent / "media"
RNG = np.random.default_rng(7)

BPM = 100
BEAT = 60 / BPM
BAR = 4 * BEAT
LENGTH = 116.0  # seconds; the video is ~110 s and fades out in fframes


def write(name: str, x: np.ndarray, peak: float = 0.89) -> None:
    x = x / (np.max(np.abs(x)) + 1e-9) * peak
    data = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(OUT / name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


def hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def t_axis(seconds: float) -> np.ndarray:
    return np.arange(int(seconds * SR)) / SR


def one_pole_lowpass(x: np.ndarray, cutoff) -> np.ndarray:
    """Lowpass with a fixed or per-sample cutoff in Hz."""
    cutoff = np.broadcast_to(np.asarray(cutoff, dtype=float), x.shape)
    a = 1 - np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


def reverb(x: np.ndarray, seconds: float = 1.9, wet: float = 0.28) -> np.ndarray:
    ir_t = t_axis(seconds)
    ir = RNG.standard_normal(len(ir_t)) * np.exp(-ir_t * 3.2)
    ir[: int(0.012 * SR)] = 0  # pre-delay
    ir /= np.sqrt(np.sum(ir**2))
    n = 1 << int(np.ceil(np.log2(len(x) + len(ir))))
    tail = np.fft.irfft(np.fft.rfft(x, n) * np.fft.rfft(ir, n), n)[: len(x)]
    return x * (1 - wet) + tail * wet


def add(buf: np.ndarray, at: float, sound: np.ndarray) -> None:
    i = int(at * SR)
    if i >= len(buf):
        return
    end = min(len(buf), i + len(sound))
    buf[i:end] += sound[: end - i]


# ------------------------------------------------------------------------------------
# Music: warm lo-fi loop, Fmaj7 - Am7 - Cmaj7 - G6, pads + plucked arpeggio + soft drums.

CHORDS = [[53, 57, 60, 64], [57, 60, 64, 67], [55, 59, 60, 64], [55, 59, 62, 64]]
BASS = [41, 45, 36, 43]


def pad_note(midi: int, seconds: float) -> np.ndarray:
    t = t_axis(seconds)
    out = np.zeros_like(t)
    for detune in (-0.06, 0.06):
        f = hz(midi + detune)
        for h in range(1, 7):
            out += np.sin(2 * np.pi * f * h * t + h) / h**1.6
    env = np.minimum(1, t / 0.6) * np.minimum(1, (seconds - t) / 0.8)
    return out * env


def pluck(midi: int, seconds: float = 1.1) -> np.ndarray:
    t = t_axis(seconds)
    f = hz(midi)
    out = sum(np.sin(2 * np.pi * f * h * t) * np.exp(-t * (5 + 5 * h)) / h for h in range(1, 6))
    return out * np.minimum(1, t / 0.004)


def kick() -> np.ndarray:
    t = t_axis(0.45)
    freq = 45 + 85 * np.exp(-t * 28)
    phase = 2 * np.pi * np.cumsum(freq) / SR
    return np.sin(phase) * np.exp(-t * 9)


def hat() -> np.ndarray:
    t = t_axis(0.06)
    n = np.diff(RNG.standard_normal(len(t) + 1))
    return n * np.exp(-t * 70)


def snap() -> np.ndarray:
    t = t_axis(0.25)
    n = RNG.standard_normal(len(t))
    body = n - one_pole_lowpass(n, 900)
    return body * np.exp(-t * 22)


def music() -> np.ndarray:
    n = int(LENGTH * SR)
    pads, arp, low, drums = (np.zeros(n) for _ in range(4))
    bars = int(np.ceil(LENGTH / BAR))
    pattern = [0, 1, 2, 3, 2, 1, 3, 2]
    for b in range(bars):
        start = b * BAR
        chord = CHORDS[b % 4]
        for note in chord:
            add(pads, start, pad_note(note, BAR + 0.9))
        add(low, start, pad_note(BASS[b % 4], BAR + 0.4) * 1.6)
        last_bars = b >= bars - 2
        if b >= 2 and not last_bars:
            for i, step in enumerate(pattern):
                vel = 0.9 if i % 2 == 0 else 0.6
                add(arp, start + i * BEAT / 2, pluck(chord[step] + 12) * vel)
        if 2 <= b < bars - 3:
            for beat in range(4):
                bt = start + beat * BEAT
                if beat in (0, 2):
                    add(drums, bt, kick() * 0.9)
                if beat in (1, 3):
                    add(drums, bt, snap() * 0.22)
                add(drums, bt + BEAT / 2, hat() * 0.12)
    low = one_pole_lowpass(low, 380)
    mix = reverb(pads * 0.10 + arp * 0.32, 2.2, 0.35) + low * 0.12 + drums * 0.55
    t = t_axis(LENGTH)[:n]
    mix *= np.minimum(1, t / 2.0)
    return mix


# ------------------------------------------------------------------------------------
# UI sound effects.


def tap() -> np.ndarray:
    t = t_axis(0.09)
    tone = np.sin(2 * np.pi * 1650 * t) * np.exp(-t * 70)
    click = np.diff(RNG.standard_normal(len(t) + 1)) * np.exp(-t * 400) * 0.35
    body = np.sin(2 * np.pi * 420 * t) * np.exp(-t * 55) * 0.6
    return tone * 0.5 + click + body


def key(pitch: float) -> np.ndarray:
    t = t_axis(0.045)
    n = np.diff(RNG.standard_normal(len(t) + 1))
    click = n * np.exp(-t * 260)
    thock = np.sin(2 * np.pi * pitch * t) * np.exp(-t * 120) * 0.8
    return click * 0.5 + thock


def whoosh() -> np.ndarray:
    seconds = 0.7
    t = t_axis(seconds)
    n = RNG.standard_normal(len(t))
    sweep = 400 + 3600 * np.sin(np.pi * t / seconds) ** 2
    band = one_pole_lowpass(n, sweep) - one_pole_lowpass(n, sweep * 0.25)
    env = np.sin(np.pi * np.minimum(1, t / seconds)) ** 2
    return band * env


def bell(notes, gap: float, seconds: float = 1.3) -> np.ndarray:
    out = np.zeros(int((seconds + gap * len(notes)) * SR))
    for i, m in enumerate(notes):
        t = t_axis(seconds)
        f = hz(m)
        tone = (
            np.sin(2 * np.pi * f * t) * np.exp(-t * 4)
            + 0.35 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 9)
            + 0.15 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t * 16)
        )
        add(out, i * gap, tone * np.minimum(1, t / 0.003))
    return reverb(out, 1.2, 0.25)


def pop() -> np.ndarray:
    t = t_axis(0.16)
    freq = 380 + 900 * np.exp(-t * 40)
    return np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t * 26)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    write("music.wav", music())
    # Keep the repository small: the soundtrack is embedded as a 160 kbps MP3.
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", OUT / "music.wav", "-b:a", "160k", OUT / "music.mp3"],
        check=True,
    )
    (OUT / "music.wav").unlink()
    write("tap.wav", tap())
    for i, pitch in enumerate((210, 245, 280)):
        write(f"key{i}.wav", key(pitch))
    write("whoosh.wav", whoosh())
    write("chime.wav", bell([76, 83], 0.11))  # success: E5 -> B5
    write("ping.wav", bell([84, 79], 0.14, 1.0))  # notification: C6 -> G5
    write("pop.wav", pop())
    write("shimmer.wav", bell([69, 76, 81, 88], 0.09, 1.8))  # logo reveal
    print("wrote", sorted(p.name for p in OUT.glob("*.wav")))


if __name__ == "__main__":
    main()
