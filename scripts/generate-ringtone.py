#!/usr/bin/env python3
"""Generate Hannafon's original ringtone and the silent keep-alive loop (V1.06).

Fully synthesised here (no samples, no third-party ringtone): a warm, soft
"ding-dong-ding" phrase played twice, mellow bell/marimba-like partials,
then a short rest. Loops seamlessly. Mastered at a comfortable level
(iOS ignores <audio>.volume, so the file itself has to be gentle).

Needs numpy and ffmpeg (AAC encoder). Writes:
  sounds/ringtone.m4a   (AAC, ~4.2 s loop)
  sounds/keepalive.m4a  (AAC, 2 s of near-silence for the iOS audio session)
"""
import os
import subprocess
import tempfile
import wave

import numpy as np

SR = 44100
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "sounds")


def note(freq, dur, amp=1.0):
    t = np.arange(int(SR * dur)) / SR
    # Mellow bell: fundamental, soft octave, a touch of the 3rd partial, each
    # decaying at its own rate; very short attack so it is not clicky.
    partials = [(1.0, 1.0, 2.6), (2.0, 0.28, 4.5), (3.0, 0.08, 7.0), (4.01, 0.03, 9.0)]
    sig = np.zeros_like(t)
    for mul, a, dec in partials:
        sig += a * np.sin(2 * np.pi * freq * mul * t) * np.exp(-dec * t)
    attack = np.clip(t / 0.012, 0, 1)
    release = np.clip((dur - t) / 0.08, 0, 1)
    # Gentle tremolo gives the "telephone" warble without being harsh.
    trem = 1 - 0.12 * (0.5 - 0.5 * np.cos(2 * np.pi * 9 * t))
    return amp * sig * attack * release * trem


def phrase():
    # G5 - E5 - C6 (major, friendly), overlapping tails.
    seq = [(783.99, 0.0, 0.55, 0.9), (659.25, 0.20, 0.6, 0.85), (1046.5, 0.40, 0.9, 0.7)]
    total = 1.35
    buf = np.zeros(int(SR * total))
    for f, start, dur, amp in seq:
        n = note(f, dur, amp)
        i = int(start * SR)
        buf[i:i + len(n)] += n[: len(buf) - i]
    return buf


def ringtone():
    p = phrase()
    gap = np.zeros(int(SR * 0.15))
    rest = np.zeros(int(SR * 1.35))
    sig = np.concatenate([p, gap, p, rest])
    # Soft low-pass (simple one-pole) to take the edge off the highs.
    out = np.empty_like(sig)
    acc = 0.0
    k = 0.35
    for i, v in enumerate(sig):
        acc += k * (v - acc)
        out[i] = acc
    peak = np.max(np.abs(out)) or 1.0
    return out / peak * 10 ** (-7 / 20)  # peak -7 dBFS: clearly audible, not harsh


def keepalive():
    # Not digital zero (some stacks drop all-zero streams); ~-90 dBFS noise.
    rng = np.random.default_rng(6)
    return rng.standard_normal(SR * 2) * 10 ** (-90 / 20)


def write_m4a(sig, path, bitrate):
    with tempfile.TemporaryDirectory() as d:
        wav = os.path.join(d, "x.wav")
        pcm = (np.clip(sig, -1, 1) * 32767).astype("<i2")
        with wave.open(wav, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm.tobytes())
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-c:a", "aac", "-b:a", bitrate,
             "-movflags", "+faststart", path],
            check=True,
        )


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    write_m4a(ringtone(), os.path.join(OUT, "ringtone.m4a"), "96k")
    write_m4a(keepalive(), os.path.join(OUT, "keepalive.m4a"), "32k")
    print("ok")
