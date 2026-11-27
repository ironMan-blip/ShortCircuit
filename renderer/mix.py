"""ffmpeg steps: audio mix, encode, checks, contact sheet (docs/PLAN.md §5, steps 5-7).

Every ffmpeg call is an argument list; the only paths in filter strings are file names the
renderer chose itself, given relative to cwd.
"""
import json
import re
import subprocess
from pathlib import Path

W, H, FPS = 1080, 1920, 30
TARGET_LUFS = -14.0


class RenderError(Exception):
    pass


def ffmpeg(*args, cwd: Path | None = None, timeout: int = 600) -> str:
    try:
        p = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-y", *map(str, args)], cwd=cwd,
                           capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RenderError(f"ffmpeg timed out after {timeout} s")
    if p.returncode:
        raise RenderError("ffmpeg failed: " + p.stderr[-1500:])
    return p.stderr


def probe(path: Path) -> dict:
    p = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
                        str(path)], capture_output=True, text=True, timeout=60)
    if p.returncode:
        raise RenderError(f"ffprobe failed on {path.name}: {p.stderr[-500:]}")
    return json.loads(p.stdout)


def duration(path: Path) -> float:
    return float(probe(path)["format"]["duration"])


def encode_clip(inputs: list, vf: str, d: float, out: Path) -> None:
    """One silent scene clip, d seconds, in the common 1080x1920/30 fps format so clips concat by copy."""
    ffmpeg(*inputs, "-t", f"{d:.3f}", "-vf", f"{vf},fps={FPS},format=yuv420p", "-an",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", out)


def concat_video(clips: list[Path], out: Path) -> None:
    listing = out.with_suffix(".txt")
    listing.write_text("".join(f"file '{c.name}'\n" for c in clips))
    ffmpeg("-f", "concat", "-safe", "0", "-i", listing.name, "-c", "copy", out.name, cwd=out.parent)


def mix_audio(wavs: list[Path], music: Path | None, out: Path) -> float:
    """Voice clips back to back, music ducked under the voice (sidechain); returns the length."""
    inputs = [a for w in wavs for a in ("-i", w)]
    chain = "".join(f"[{i}:a]" for i in range(len(wavs))) + f"concat=n={len(wavs)}:v=0:a=1," \
            "aresample=48000,aformat=channel_layouts=mono"
    if music is None:
        ffmpeg(*inputs, "-filter_complex", chain + "[a]", "-map", "[a]", out)
        return duration(out)
    voice = out.with_name("voice.wav")
    ffmpeg(*inputs, "-filter_complex", chain + "[a]", "-map", "[a]", voice)
    total = duration(voice)
    ffmpeg("-i", voice, "-stream_loop", "-1", "-i", music, "-filter_complex",
           "[0:a]asplit=2[v][key];"
           f"[1:a]aresample=48000,aformat=channel_layouts=mono,volume=0.35,"
           f"afade=t=out:st={max(total - 1.5, 0):.3f}:d=1.5[m];"
           "[m][key]sidechaincompress=threshold=0.03:ratio=10:attack=15:release=350[duck];"
           "[v][duck]amix=inputs=2:duration=first:normalize=0[a]",
           "-map", "[a]", "-t", f"{total:.3f}", out)
    return total


def loudnorm_filter(wav: Path) -> str:
    """Two-pass EBU R128: measure first, then normalise linearly to TARGET_LUFS."""
    log = ffmpeg("-i", wav, "-af", f"loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-")
    m = json.loads(log[log.rindex("{"):log.rindex("}") + 1])
    return (f"loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=11:linear=true:measured_I={m['input_i']}:"
            f"measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:"
            f"offset={m['target_offset']},aresample=48000")


def final(video: Path, audio: Path, ass: Path, fontsdir: Path | None, total: float, out: Path) -> None:
    """Burn captions, add normalised audio, encode the upload file (all inputs in out's folder)."""
    ass_filter = f"ass={ass.name}" + (f":fontsdir={fontsdir}" if fontsdir else "")
    ffmpeg("-i", video.name, "-i", audio.name, "-filter_complex",
           f"[0:v]{ass_filter},format=yuv420p[v];[1:a]{loudnorm_filter(audio)}[a]",
           "-map", "[v]", "-map", "[a]", "-t", f"{total:.3f}",
           "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-maxrate", "10M", "-bufsize", "20M",
           "-r", FPS, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", out.name,
           cwd=out.parent)


def loudness(path: Path) -> float:
    log = ffmpeg("-i", path, "-map", "0:a", "-af", "ebur128=framelog=quiet", "-f", "null", "-")
    return float(re.findall(r"I:\s+(-?[\d.]+) LUFS", log)[-1])


def check(path: Path) -> dict:
    """The checks a finished video must pass (§5 step 7). A failure is an error, not a warning."""
    info = probe(path)
    kinds = {s["codec_type"] for s in info["streams"]}
    video = next((s for s in info["streams"] if s["codec_type"] == "video"), {})
    d = float(info["format"]["duration"])
    size_mb = path.stat().st_size / 1e6
    problems = []
    if kinds < {"audio", "video"}:
        problems.append(f"streams {sorted(kinds)}")
    if (video.get("width"), video.get("height")) != (W, H):
        problems.append(f"size {video.get('width')}x{video.get('height')}")
    if not 20 <= d <= 60:
        problems.append(f"duration {d:.1f} s not in 20-60 s")
    if size_mb >= 200:
        problems.append(f"file {size_mb:.0f} MB")
    lufs = loudness(path) if "audio" in kinds else None
    if lufs is not None and abs(lufs - TARGET_LUFS) > 1:
        problems.append(f"loudness {lufs} LUFS")
    if problems:
        raise RenderError("video check failed: " + "; ".join(problems))
    return {"duration_s": round(d, 2), "size_mb": round(size_mb, 1), "lufs": lufs}


def contact_sheet(video: Path, total: float, out: Path) -> None:
    """2x3 JPEG of six evenly spaced frames, for the Master's video review."""
    ffmpeg("-i", video, "-vf", f"fps=6/{total:.3f},scale=360:640,tile=3x2", "-frames:v", "1", "-q:v", "3", out)
