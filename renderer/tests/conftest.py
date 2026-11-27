import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app  # noqa: E402
import voice  # noqa: E402

VOICES = frozenset({"af_heart", "am_adam"})


def lavfi(out: Path, *args: str) -> Path:
    subprocess.run(["ffmpeg", "-hide_banner", "-y", "-loglevel", "error", "-f", "lavfi", *args, str(out)], check=True)
    return out


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    """Empty /data and /assets stand-ins with one music mood holding one track."""
    data, assets = tmp_path / "data", tmp_path / "assets"
    (assets / "brand").mkdir(parents=True)
    (assets / "music" / "upbeat").mkdir(parents=True)
    data.mkdir()
    lavfi(assets / "music" / "upbeat" / "track.wav", "-i", "sine=frequency=440:duration=8", "-ac", "2")
    monkeypatch.setattr(app, "DATA", data)
    monkeypatch.setattr(app, "ASSETS", assets)
    monkeypatch.setattr(voice, "voices", lambda: VOICES)
    return data, assets


@pytest.fixture
def plan():
    return {
        "voice": "af_heart", "speed": 1.05, "music_mood": "upbeat",
        "scenes": [
            {"id": 1, "narration": "Stock scene with {\\pos(0,0)} an injected tag.",
             "visual": {"type": "stock", "query": "server room", "text": "", "url": ""},
             "on_screen_text": "Big news"},
            {"id": 2, "narration": "A card scene about 42 million users.",
             "visual": {"type": "card", "query": "", "text": "42 million users", "url": ""},
             "on_screen_text": "42M"},
        ],
    }


@pytest.fixture
def ffmpeg_available():
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
