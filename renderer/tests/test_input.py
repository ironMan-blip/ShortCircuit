import copy

import pytest
from fastapi.testclient import TestClient

import app


@pytest.fixture
def client(dirs):
    return TestClient(app.app)  # no `with`: the proxy is not started


@pytest.mark.parametrize("change", [
    lambda b: b.update(job_id="../x"),
    lambda b: b.update(job_id="SC-12"),
    lambda b: b.update(job_id="SC-0042\n"),
    lambda b: b.update(job_id="SC-٠٠٤٢"),               # non-ASCII digits
    lambda b: b["plan"].update(music_mood="../../data"),
    lambda b: b["plan"].update(music_mood="sad"),         # no such folder
    lambda b: b["plan"].update(voice="xx_unknown"),
    lambda b: b["plan"].update(speed=2.0),
    lambda b: b["plan"].update(scenes=[]),
    lambda b: b["plan"]["scenes"][0]["visual"].update(type="iframe"),
])
def test_bad_input_is_422_and_renders_nothing(client, plan, change, dirs, monkeypatch):
    monkeypatch.setattr(app, "render_job", lambda *a: pytest.fail("rendered a bad plan"))
    body = {"job_id": "SC-0042", "plan": copy.deepcopy(plan)}
    change(body)
    assert client.post("/render", json=body).status_code == 422
    assert not (dirs[0] / "jobs").exists()


def test_delete_checks_the_id(client, dirs):
    (dirs[0] / "jobs" / "SC-0042").mkdir(parents=True)
    assert client.delete("/jobs/SC-0042").json() == {"deleted": True}
    assert not (dirs[0] / "jobs" / "SC-0042").exists()
    assert client.delete("/jobs/..%2F..%2Fdata").status_code in (404, 422)
    assert client.delete("/jobs/SC-0042x").status_code == 422


def test_prune_keeps_recent(client, dirs):
    import os, time
    cache = dirs[0] / "cache" / "stock"
    cache.mkdir(parents=True)
    old, new = cache / "old.mp4", cache / "new.mp4"
    old.write_bytes(b"x")
    new.write_bytes(b"x")
    os.utime(old, (time.time() - 8 * 86400,) * 2)
    assert client.post("/cache/prune").json() == {"removed": 1}
    assert new.exists() and not old.exists()
