"""Narration: Kokoro TTS and faster-whisper word timings (docs/PLAN.md §5, steps 1-2)."""
import os
import re
from functools import cache
from pathlib import Path

import httpx

KOKORO_URL = os.environ.get("KOKORO_URL", "http://kokoro:8880")
WHISPER_DIR = os.environ.get("WHISPER_DIR", "/opt/whisper")


@cache
def voices() -> frozenset[str]:
    r = httpx.get(f"{KOKORO_URL}/v1/audio/voices", timeout=30)
    r.raise_for_status()
    return frozenset(v["id"] if isinstance(v, dict) else v for v in r.json()["voices"])  # objects since v0.10


def synthesize(text: str, voice: str, speed: float, out: Path) -> None:
    r = httpx.post(f"{KOKORO_URL}/v1/audio/speech", timeout=180, json={
        "model": "kokoro", "input": text, "voice": voice, "speed": speed, "response_format": "wav"})
    r.raise_for_status()
    out.write_bytes(r.content)


@cache
def _whisper():
    from faster_whisper import WhisperModel  # heavy import, only when a render runs
    return WhisperModel("small", device="cpu", compute_type="int8", download_root=WHISPER_DIR)


def transcribe(wav: Path, narration: str) -> list[dict]:
    """Word list [{word, start, end}] in seconds from the start of this wav."""
    segments, _ = _whisper().transcribe(str(wav), language="en", word_timestamps=True,
                                        initial_prompt=narration)
    words = [{"word": w.word.strip(), "start": w.start, "end": w.end}
             for seg in segments for w in seg.words if w.word.strip()]
    # Same word count: keep whisper's timings but the script's spelling (names, numbers).
    script = re.findall(r"\S+", narration)
    if len(script) == len(words):
        for w, s in zip(words, script):
            w["word"] = s
    return words
