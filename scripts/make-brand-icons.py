#!/usr/bin/env python3
"""Generate the Ling Gao LG monogram brand icons (development tool).

Design references (ui-ux-pro-max): high-contrast editorial monogram,
oversized type, one accent lockup, balanced negative space.

Outputs:
- icon.png                512x512 plugin/detail icon, LG + red/blue underline lockup
- assets/brand/sidebar-icon.png  512x512 compact LG badge (no underline, larger at 20px)

The tile uses the plugin's existing slate background and brand red/blue.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FONT_PATH = Path(r"C:\Windows\Fonts\ariblk.ttf")
BG = (15, 23, 42, 255)
WHITE = (255, 255, 255, 255)
RED = (229, 70, 70, 255)
BLUE = (24, 71, 133, 255)
SIZE = 512
SS = 4  # supersampling


def _font_at(text: str, width: int) -> ImageFont.FreeTypeFont:
    base = 1000
    probe = ImageFont.truetype(str(FONT_PATH), base)
    bbox = probe.getbbox(text)
    natural = bbox[2] - bbox[0]
    size = max(1, round(base * width / natural))
    return ImageFont.truetype(str(FONT_PATH), size)


def _draw_lockup(art: Image.Image, *, width: int, with_bar: bool, center_y: int) -> None:
    # Render the letters on their own layer so centering uses the *ink* bbox,
    # not the font's sidebearings: equal left/right margins at every export size.
    text = "LG"
    font = _font_at(text, width)
    layer = Image.new("RGBA", art.size, (0, 0, 0, 0))
    layer_draw = ImageDraw.Draw(layer)
    layer_draw.text((0, 0), text, font=font, fill=WHITE)
    ink = layer.getchannel("A").getbbox()
    if ink is None:
        return
    ink_left, ink_top, ink_right, ink_bottom = ink
    ink_w = ink_right - ink_left
    ink_h = ink_bottom - ink_top
    bar_h = 14 * SS
    gap = 18 * SS
    total_h = ink_h + (gap + bar_h if with_bar else 0)
    text_top = round(center_y - total_h / 2)
    text_left = round((SIZE * SS - ink_w) / 2)
    art.alpha_composite(layer, (text_left - ink_left, text_top - ink_top))

    if with_bar:
        bar_y = text_top + ink_h + gap
        split = text_left + ink_w / 2
        half_gap = 4 * SS
        draw = ImageDraw.Draw(art)
        draw.rectangle((text_left, bar_y, round(split - half_gap), bar_y + bar_h), fill=RED)
        draw.rectangle((round(split + half_gap), bar_y, text_left + ink_w, bar_y + bar_h), fill=BLUE)


def build(*, width_ratio: float, with_bar: bool, center_ratio: float) -> Image.Image:
    art = Image.new("RGBA", (SIZE * SS, SIZE * SS), BG)
    width = round(SIZE * SS * width_ratio)
    _draw_lockup(
        art,
        width=width,
        with_bar=with_bar,
        center_y=SIZE * SS * center_ratio,
    )
    return art.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def main() -> int:
    icon = build(width_ratio=0.665, with_bar=True, center_ratio=0.5)
    sidebar = build(width_ratio=0.70, with_bar=False, center_ratio=0.5)

    icon.save(ROOT / "icon.png", optimize=True)
    (ROOT / "assets/brand").mkdir(parents=True, exist_ok=True)
    sidebar.save(ROOT / "assets/brand/sidebar-icon.png", optimize=True)

    # Contact sheet for visual review at real display sizes (not shipped).
    preview = Image.new("RGBA", (1080, 420), (248, 250, 252, 255))
    draw = ImageDraw.Draw(preview)
    draw.text((24, 16), "LG monogram — plugin icon (top) / sidebar badge (bottom), 256/128/64/32/20 px", fill=(15, 23, 42, 255))
    for row, image in enumerate((icon, sidebar)):
        x = 24
        base_y = 60 + row * 180
        for size in (256, 128, 64, 32, 20):
            thumb = image.resize((size, size), Image.Resampling.LANCZOS)
            y = base_y + (128 - size) // 2
            preview.paste(thumb, (x, y), thumb)
            draw.text((x, base_y + 140), f"{size}px", fill=(71, 85, 105, 255))
            x += size + 40 if size >= 64 else size + 36
    preview.save(ROOT / ".superpowers/e2e/icon-contact-sheet.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
