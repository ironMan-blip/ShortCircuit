"""Offline render of a 2-scene fixture plan: fixture clip + fixture WAV, no network (docs/PLAN.md §5)."""
import shutil

import pytest
from fastapi.testclient import TestClient

import app
import captions
import mix
import visuals
import voice
from conftest import lavfi


@pytest.fixture
def offline(dirs, tmp_path, monkeypatch, ffmpeg_available):
    clip = lavfi(tmp_path / "clip.mp4", "-i", "testsrc2=size=1280x720:rate=25:duration=3", "-pix_fmt", "yuv420p")
    # A voice stand-in: 11 s of speech-like noise at a quiet level, so loudnorm has work to do.
    wav = lavfi(tmp_path / "voice.wav", "-i", "anoisesrc=color=pink:amplitude=0.05:duration=11:sample_rate=24000")

    monkeypatch.setattr(voice, "synthesize", lambda text, v, s, out: shutil.copy(wav, out))
    monkeypatch.setattr(voice, "transcribe", lambda wav, narration: [
        {"word": w, "start": 0.4 * i, "end": 0.4 * i + 0.35} for i, w in enumerate(narration.split())])
    monkeypatch.setattr(visuals, "stock", lambda query, cache: clip)
    return dirs


def test_render_fixture_plan(offline, plan):
    data, _ = offline
    r = TestClient(app.app).post("/render", json={"job_id": "SC-0042", "plan": plan})
    assert r.status_code == 200, r.text
    body = r.json()

    video = data / "jobs" / "SC-0042" / "SC-0042.mp4"
    assert body["path"] == str(video) and video.is_file()
    assert 21 <= body["duration_s"] <= 23
    info = mix.probe(video)
    streams = {s["codec_type"]: s for s in info["streams"]}
    assert set(streams) == {"audio", "video"}
    assert (streams["video"]["width"], streams["video"]["height"]) == (1080, 1920)
    assert abs(mix.loudness(video) + 14) <= 1
    assert body["warnings"] == []
    assert body["transcript"][0]["word"] == "Stock" and body["transcript"][-1]["start"] > 11
    sheet = mix.probe(data / "jobs" / "SC-0042" / "contact_sheet.jpg")["streams"][0]
    assert (sheet["width"], sheet["height"]) == (1080, 1280)
    assert not (data / "jobs" / "SC-0042" / "work").exists()


def test_failed_check_is_an_error(offline, plan, monkeypatch):
    plan["scenes"] = plan["scenes"][:1]  # 11 s: below the 20 s minimum
    r = TestClient(app.app).post("/render", json={"job_id": "SC-0043", "plan": plan})
    assert r.status_code == 500 and "duration" in r.json()["detail"]


def test_refused_screenshot_becomes_a_card(offline, plan):
    plan["scenes"][1]["visual"] = {"type": "screenshot", "query": "", "text": "", "url": "https://127.0.0.1/"}
    r = TestClient(app.app).post("/render", json={"job_id": "SC-0044", "plan": plan})
    assert r.status_code == 200, r.text
    assert any("screenshot refused" in w for w in r.json()["warnings"])


def test_captions_strip_override_tags(tmp_path):
    ass = tmp_path / "c.ass"
    captions.write(ass, [{"word": "{\\pos(0,0)}hi", "start": 0, "end": 0.3},
                         {"word": "there\\N", "start": 0.3, "end": 0.6}],
                   [(0, 1, "Top {\\fs300}text")], "DejaVu Sans")
    events = [line for line in ass.read_text().splitlines() if line.startswith("Dialogue")]
    assert "Top text" in events[0] and "\\fs" not in events[0]
    body = "".join(e.split(",,", 1)[1] for e in events[1:])
    # Only the renderer's own colour tags remain; the planted \pos and \N are gone.
    assert "\\pos" not in body and "\\N" not in body
    assert body.count("\\") == body.count("\\c&H")
