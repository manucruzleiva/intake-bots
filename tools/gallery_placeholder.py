"""Placeholder PNGs for a mod's store gallery (lib/gallery.mjs never uploads them).

    python tools/gallery_placeholder.py <mod-repo>/art/gallery/gallery.json

Every entry with "placeholder": true gets its `file` (re)written as a grey 16:9 PNG with its title on
it, so the manifest lists each image the gallery standard requires from day one. Manual: nothing runs
it in a build. Needs Pillow.
"""

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SIZE = (1280, 720)
BACKGROUND = (128, 128, 128)
INK = (235, 235, 235)


def wrap(draw, text, font, width):
    lines, line = [], ""
    for word in text.split():
        candidate = f"{line} {word}".strip()
        if draw.textlength(candidate, font=font) <= width or not line:
            line = candidate
        else:
            lines.append(line)
            line = word
    return lines + [line]


def render(title, path):
    image = Image.new("RGB", SIZE, BACKGROUND)
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=56)
    small = ImageFont.load_default(size=28)
    lines = wrap(draw, title, font, SIZE[0] - 160)
    line_height = 72
    y = (SIZE[1] - line_height * len(lines)) // 2 - 20
    for line in lines:
        draw.text((SIZE[0] // 2, y), line, font=font, fill=INK, anchor="mt")
        y += line_height
    draw.text((SIZE[0] // 2, y + 24), "placeholder", font=small, fill=INK, anchor="mt")
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, optimize=True)


def main(manifest):
    manifest = Path(manifest)
    entries = json.loads(manifest.read_text(encoding="utf-8"))
    for entry in entries:
        if entry.get("placeholder"):
            render(entry["title"], manifest.parent / entry["file"])
            print(f"placeholder: {entry['file']}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
