"""ShortCircuit renderer: one endpoint turns an edit plan into a finished Short (docs/PLAN.md §5).

Trust boundary: the plan is model output. It is validated here (422 on anything off) and its
text only ever goes into files (ASS, Pillow images) or argument lists.
"""
import logging
import os
import random
import re
import shutil
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

import httpx
from fastapi import FastAPI, HTTPException
from PIL import ImageFont
from pydantic import AfterValidator, BaseModel, Field, field_validator

import captions
import mix
import proxy
import visuals
import voice

logging.basicConfig(level=logging.INFO)
DATA = Path(os.environ.get("DATA_DIR", "/data"))
ASSETS = Path(os.environ.get("ASSETS_DIR", "/assets"))
CACHE_DAYS = 7
MUSIC_EXT = {".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"}
RENDER_LOCK = threading.Lock()


def job_id_ok(job_id: str) -> str:
    # [0-9], not \d: \d also matches non-ASCII digits. The id becomes a folder name.
    if not re.fullmatch(r"SC-[0-9]{4,}", job_id):
        raise ValueError("job_id must look like SC-0042")
    return job_id


JobId = Annotated[str, AfterValidator(job_id_ok)]


class Visual(BaseModel):
    type: Literal["stock", "card", "screenshot"]
    query: str = Field("", max_length=200)
    text: str = Field("", max_length=300)
    url: str = Field("", max_length=2000)


class Scene(BaseModel):
    id: int = Field(ge=0, le=999)
    narration: str = Field(min_length=1, max_length=1500)
    visual: Visual
    on_screen_text: str = Field("", max_length=120)


class Plan(BaseModel):
    voice: str = Field(max_length=64)
    speed: float = Field(ge=0.8, le=1.3)
    music_mood: str
    scenes: list[Scene] = Field(min_length=1, max_length=20)

    @field_validator("music_mood")
    @classmethod
    def mood_is_a_folder(cls, mood: str) -> str:
        # Compared with the folder listing, never joined into a path first.
        moods = {p.name for p in (ASSETS / "music").iterdir() if p.is_dir()} if (ASSETS / "music").is_dir() else set()
        if mood not in moods:
            raise ValueError(f"music_mood must be one of {sorted(moods)}")
        return mood


class RenderRequest(BaseModel):
    job_id: JobId
    plan: Plan


@asynccontextmanager
async def lifespan(_app):
    server = await proxy.serve()
    yield
    server.close()


app = FastAPI(title="ShortCircuit renderer", lifespan=lifespan)


@app.get("/health")
def health():
    return {"ok": True, "rendering": RENDER_LOCK.locked()}


@app.post("/render")
def render(req: RenderRequest):
    try:
        known = voice.voices()
    except httpx.HTTPError as e:
        raise HTTPException(503, f"Kokoro unavailable: {e}")
    if req.plan.voice not in known:
        raise HTTPException(422, f"unknown voice {req.plan.voice!r}")
    if not RENDER_LOCK.acquire(blocking=False):
        raise HTTPException(409, "a render is already running")
    try:
        return render_job(req.job_id, req.plan)
    except (mix.RenderError, httpx.HTTPError) as e:
        raise HTTPException(500, str(e))
    finally:
        RENDER_LOCK.release()


def render_job(job_id: str, plan: Plan) -> dict:
    job_dir = DATA / "jobs" / job_id
    shutil.rmtree(job_dir, ignore_errors=True)  # a re-render starts clean
    work = job_dir / "work"
    work.mkdir(parents=True)
    brand = ASSETS / "brand"
    warnings: list[str] = []
    words, overlays, wavs, clips = [], [], [], []
    t = 0.0
    for i, scene in enumerate(plan.scenes):
        wav = work / f"voice_{i}.wav"
        voice.synthesize(scene.narration, plan.voice, plan.speed, wav)
        d = mix.duration(wav)
        scene_words = voice.transcribe(wav, scene.narration)
        if not scene_words:
            warnings.append(f"scene {scene.id}: no words heard, no captions")
        words += [{**w, "start": round(w["start"] + t, 3), "end": round(w["end"] + t, 3)} for w in scene_words]
        overlays.append((t, t + d, scene.on_screen_text))
        clip = work / f"scene_{i}.mp4"
        visuals.make(scene, d, clip, work, DATA / "cache", brand, warnings)
        wavs.append(wav)
        clips.append(clip)
        t += d

    tracks = sorted(p for p in (ASSETS / "music" / plan.music_mood).iterdir() if p.suffix.lower() in MUSIC_EXT)
    if not tracks:
        warnings.append(f"no tracks in assets/music/{plan.music_mood}, rendered without music")
    total = mix.mix_audio(wavs, random.choice(tracks) if tracks else None, work / "audio.wav")
    font = ImageFont.truetype(visuals.font_path(brand)).getname()[0]
    captions.write(work / "captions.ass", words, overlays, font)
    mix.concat_video(clips, work / "visuals.mp4")
    fontsdir = brand if (brand / "font.ttf").is_file() else None
    out = work / f"{job_id}.mp4"
    mix.final(work / "visuals.mp4", work / "audio.wav", work / "captions.ass", fontsdir, total, out)
    report = mix.check(out)
    video = out.replace(job_dir / out.name)
    sheet = job_dir / "contact_sheet.jpg"
    mix.contact_sheet(video, total, sheet)
    shutil.rmtree(work)
    return {"path": str(video), "duration_s": report["duration_s"], "size_mb": report["size_mb"],
            "warnings": warnings, "transcript": words, "contact_sheet": str(sheet)}


@app.delete("/jobs/{job_id}")
def delete_job(job_id: str):
    try:
        job_id_ok(job_id)
    except ValueError as e:
        raise HTTPException(422, str(e))
    job_dir = DATA / "jobs" / job_id
    existed = job_dir.exists()
    shutil.rmtree(job_dir, ignore_errors=True)
    return {"deleted": existed}


@app.post("/cache/prune")
def prune_cache():
    cutoff = time.time() - CACHE_DAYS * 86400
    removed = 0
    for f in (DATA / "cache").rglob("*"):
        if f.is_file() and f.stat().st_mtime < cutoff:
            f.unlink()
            removed += 1
    return {"removed": removed}
