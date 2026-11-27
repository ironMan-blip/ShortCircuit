"""Word-by-word highlighted ASS subtitles (docs/PLAN.md §5, step 4).

Plan text is model output: it only ever lands in this file, with every ASS override
tag character ({, }, \\) removed, never in a shell command or an ffmpeg filter string.
"""
import re
from pathlib import Path

GROUP = 3          # words on screen at once
GAP_S = 0.6        # a pause this long starts a new group
HIGHLIGHT = r"{\c&H0000FFFF&}"   # yellow (ASS colours are &HAABBGGRR)
NORMAL = r"{\c&H00FFFFFF&}"


def clean(text: str) -> str:
    return " ".join(re.sub(r"[{}\\]", "", re.sub(r"\{[^}]*\}", "", text)).split())


def ts(t: float) -> str:
    cs = max(0, round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02}:{cs // 100 % 60:02}.{cs % 100:02}"


def _groups(words):
    group = []
    for w in words:
        if group and (len(group) == GROUP or w["start"] - group[-1]["end"] > GAP_S):
            yield group
            group = []
        group.append(w)
    if group:
        yield group


def write(path: Path, words: list[dict], overlays: list[tuple[float, float, str]], font: str) -> None:
    """words: [{word, start, end}] on the video timeline; overlays: (start, end, on-screen text)."""
    lines = [
        "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 0", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Caption,{font},84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,2,80,80,560,1",
        f"Style: Top,{font},64,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,18,0,8,80,80,220,1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for start, end, text in overlays:
        if clean(text):
            lines.append(f"Dialogue: 0,{ts(start)},{ts(end)},Top,,0,0,0,,{clean(text)}")
    for group in _groups(words):
        texts = [clean(w["word"]) for w in group]
        for i, w in enumerate(group):
            end = group[i + 1]["start"] if i + 1 < len(group) else w["end"]
            shown = " ".join(f"{HIGHLIGHT}{t}{NORMAL}" if j == i else t for j, t in enumerate(texts))
            lines.append(f"Dialogue: 1,{ts(w['start'])},{ts(max(end, w['start'] + 0.05))},Caption,,0,0,0,,{shown}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
