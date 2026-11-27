"""Scene visuals: Pexels stock, Pillow cards, Playwright screenshots (docs/PLAN.md §5, step 3).

Each scene becomes one silent 1080x1920 clip exactly as long as its narration.
"""
import hashlib
import os
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont

import mix
import proxy

PEXELS_API_KEY = os.environ.get("PEXELS_API_KEY", "")
FALLBACK_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
# shortcut: plain colours until assets/brand/ has card.png and font.ttf; drop them in, no code change.
BACKGROUND, TEXT_COLOUR = (12, 16, 28), (255, 255, 255)


def font_path(brand: Path) -> str:
    return str(brand / "font.ttf") if (brand / "font.ttf").is_file() else FALLBACK_FONT


def make(scene, d: float, out: Path, work: Path, cache: Path, brand: Path, warnings: list[str]) -> None:
    v = scene.visual
    card_text = v.text or scene.on_screen_text or scene.narration
    if v.type == "stock":
        src = stock(v.query or scene.on_screen_text, cache)
        if src:
            return mix.encode_clip(["-stream_loop", "-1", "-i", src],
                                   f"scale={mix.W}:{mix.H}:force_original_aspect_ratio=increase,"
                                   f"crop={mix.W}:{mix.H},setsar=1", d, out)
        warnings.append(f"scene {scene.id}: no Pexels result for the query, used a card")
    elif v.type == "screenshot":
        png = work / f"shot_{scene.id}.png"
        reason = proxy.check_url(v.url)
        if reason is None:
            reason = screenshot(v.url, png)
        if reason is None:
            # A slow scroll from the top of the page down to the end of the capture.
            return mix.encode_clip(["-loop", "1", "-framerate", mix.FPS, "-i", png],
                                   f"crop={mix.W}:{mix.H}:0:'(ih-{mix.H})*t/{d:.3f}',setsar=1", d, out)
        warnings.append(f"scene {scene.id}: screenshot refused ({reason}), used a card")
    png = work / f"card_{scene.id}.png"
    card(card_text, png, brand)
    mix.encode_clip(["-loop", "1", "-framerate", mix.FPS, "-i", png], "setsar=1", d, out)


def card(text: str, out: Path, brand: Path) -> None:
    template = brand / "card.png"
    img = (Image.open(template).convert("RGB").resize((mix.W, mix.H)) if template.is_file()
           else Image.new("RGB", (mix.W, mix.H), BACKGROUND))
    draw = ImageDraw.Draw(img)
    for size in (110, 96, 84, 72, 60, 48):
        font = ImageFont.truetype(font_path(brand), size)
        lines = _wrap(" ".join(text.split()), font, mix.W - 160)
        if len(lines) * size * 1.25 <= mix.H * 0.6:
            break
    y = (mix.H - len(lines) * size * 1.25) / 2
    for line in lines:
        draw.text((mix.W / 2, y), line, font=font, fill=TEXT_COLOUR, anchor="ma")
        y += size * 1.25
    img.save(out)


def _wrap(text: str, font, width: int) -> list[str]:
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if line and font.getlength(trial) > width:
            lines.append(line)
            line = word
        else:
            line = trial
    return lines + [line] if line else lines


def stock(query: str, cache: Path) -> Path | None:
    """A portrait Pexels clip (>= 1080 px wide) for query, cached by query."""
    if not query.strip():
        return None
    path = cache / "stock" / (hashlib.sha256(query.lower().strip().encode()).hexdigest()[:20] + ".mp4")
    if path.is_file():
        os.utime(path)  # keeps used clips past the weekly prune
        return path
    if not PEXELS_API_KEY:
        raise mix.RenderError("PEXELS_API_KEY is not set")
    r = httpx.get("https://api.pexels.com/videos/search", headers={"Authorization": PEXELS_API_KEY}, timeout=30,
                  params={"query": query, "orientation": "portrait", "size": "large", "per_page": 15})
    if r.status_code in (401, 403):
        raise mix.RenderError(f"Pexels refused the API key ({r.status_code})")
    r.raise_for_status()
    files = [f for v in r.json().get("videos", []) for f in v.get("video_files", [])
             if f.get("width") and f.get("height") and f["height"] > f["width"] >= mix.W and f.get("link")]
    if not files:
        return None
    best = min(files, key=lambda f: f["width"])  # smallest file that is still big enough
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    size = 0
    with httpx.stream("GET", best["link"], follow_redirects=True, timeout=120) as resp:
        resp.raise_for_status()
        with tmp.open("wb") as f:
            for chunk in resp.iter_bytes(1 << 20):
                size += len(chunk)
                if size > 200e6:
                    raise mix.RenderError("Pexels clip over 200 MB")
                f.write(chunk)
    tmp.replace(path)
    return path


def launch(playwright, proxy_port: int = proxy.PORT):
    """Chromium with every request (loopback included) sent through the checking proxy."""
    return playwright.chromium.launch(chromium_sandbox=True, args=[
        f"--proxy-server=http://127.0.0.1:{proxy_port}",
        "--proxy-bypass-list=<-loopback>",  # Chromium skips the proxy for loopback unless told not to
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ])


def screenshot(url: str, out: Path) -> str | None:
    """Capture the page (mobile layout, 1080 px wide, up to 3 screens tall); None or the reason it failed."""
    from playwright.sync_api import Error, sync_playwright
    try:
        with sync_playwright() as p:
            browser = launch(p)
            try:
                page = browser.new_page(viewport={"width": 360, "height": 640}, device_scale_factor=3,
                                        is_mobile=True, has_touch=True)
                page.goto(url, wait_until="domcontentloaded", timeout=30_000)
                page.wait_for_timeout(2000)  # let late images and fonts arrive
                height = min(max(page.evaluate("document.documentElement.scrollHeight"), 640), 640 * 3)
                page.screenshot(path=str(out), full_page=True, clip={"x": 0, "y": 0, "width": 360, "height": height})
            finally:
                browser.close()
    except Error as e:
        return f"page did not load: {str(e).splitlines()[0][:200]}"
    return None
