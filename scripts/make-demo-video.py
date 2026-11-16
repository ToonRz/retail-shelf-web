#!/usr/bin/env python3
"""Make public/samples/demo-shelf.mp4: a 2-minute synthetic shelf for testing the watch page (#watch).

Two shelf rows, 6 slots of 2 facings each, built from the 4 product photos in public/samples/ (CC BY 4.0,
Sell Products). Products are taken one facing at a time, a person walks past, one slot is restocked and one
slot is only half emptied. The timeline is in EVENTS below and in public/samples/README.md.

    python3 scripts/make-demo-video.py            # needs Pillow and ffmpeg
"""
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "public" / "samples"
OUT = SAMPLES / "demo-shelf.mp4"
W, H, FPS, SECONDS = 1280, 720, 30, 120

# Product cut out of each 640x640 sample photo (left, top, right, bottom).
CROPS = {
    "copp": (0, 70, 610, 500),
    "hanami": (10, 60, 640, 600),
    "lays": (0, 0, 580, 580),
    "pocky": (220, 190, 450, 470),
}
# Rows of facings; neighbours with the same product form one slot on the page (auto slots).
ROWS = [["copp", "copp", "hanami", "hanami", "lays", "lays"],
        ["pocky", "pocky", "lays", "lays", "copp", "copp"]]
# (second, row, facing index, present?) - a facing is taken (False) or put back (True) at that second.
EVENTS = [
    (15, 0, 4, False), (20, 0, 5, False),   # row 1 lays: empty from 0:20
    (40, 1, 0, False), (45, 1, 1, False),   # row 2 pocky: empty from 0:45
    (75, 0, 4, True), (75, 0, 5, True),     # row 1 lays: restocked at 1:15
    (85, 1, 4, False), (90, 1, 5, False),   # row 2 copp: empty from 1:30
    (100, 0, 2, False),                     # row 1 hanami: one facing taken only, never empty
]
PERSON = (62.0, 67.0)  # a person walks past in front of the shelf (seconds)

FACING_W, FACING_H, GAP = 184, 236, 12
ROW_TOP = [86, 400]
SHELF_X0 = (W - (6 * FACING_W + 5 * GAP)) // 2


def font(size):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"):
        if Path(f).exists():
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def facing_box(row, i):
    x = SHELF_X0 + i * (FACING_W + GAP)
    return x, ROW_TOP[row], x + FACING_W, ROW_TOP[row] + FACING_H


def background():
    img = Image.new("RGB", (W, H), (58, 52, 48))
    d = ImageDraw.Draw(img)
    for row in range(2):
        x0, y0 = SHELF_X0 - 24, ROW_TOP[row] - 16
        x1, y1 = W - SHELF_X0 + 24, ROW_TOP[row] + FACING_H
        d.rectangle([x0, y0, x1, y1], fill=(232, 226, 214))            # back panel
        d.rectangle([x0, y1, x1, y1 + 26], fill=(150, 104, 62))         # shelf board
        d.rectangle([x0, y1 + 26, x1, y1 + 34], fill=(104, 70, 40))     # board edge
    d.rectangle([0, H - 40, W, H], fill=(40, 36, 33))
    return img


def products():
    out = {}
    for name, box in CROPS.items():
        im = Image.open(SAMPLES / f"{name}.jpg").convert("RGB").crop(box)
        im.thumbnail((FACING_W, FACING_H), Image.LANCZOS)
        out[name] = im
    return out


def shelf(state, base, prods):
    img = base.copy()
    for row, names in enumerate(ROWS):
        for i, name in enumerate(names):
            if not state[row][i]:
                continue
            x0, y0, x1, y1 = facing_box(row, i)
            p = prods[name]
            px, py = x0 + (FACING_W - p.width) // 2, y1 - p.height  # stand on the board
            shadow = Image.new("L", (p.width + 16, p.height + 16), 0)
            ImageDraw.Draw(shadow).rectangle([8, 8, p.width + 8, p.height + 8], fill=90)
            img.paste((0, 0, 0), (px - 2, py + 2), shadow.filter(ImageFilter.GaussianBlur(6)))
            img.paste(p, (px, py))
    return img


def person(img, t):
    a, b = PERSON
    if not a <= t <= b:
        return
    k = (t - a) / (b - a)
    cx = int(-200 + k * (W + 400))
    d = ImageDraw.Draw(img)
    d.ellipse([cx - 55, 40, cx + 55, 160], fill=(30, 30, 34))           # head
    d.rounded_rectangle([cx - 140, 150, cx + 140, H], 60, fill=(36, 44, 70))  # body


def main():
    prods, base = products(), background()
    clock_font, note_font = font(22), font(18)
    state = [[True] * 6 for _ in ROWS]
    pending = sorted(EVENTS)
    cache = {}
    ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                           "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                           "-pix_fmt", "yuv420p", "-g", str(FPS * 2), "-movflags", "+faststart", str(OUT)],
                          stdin=subprocess.PIPE)
    for n in range(SECONDS * FPS):
        t = n / FPS
        while pending and pending[0][0] <= t:
            _, row, i, present = pending.pop(0)
            state[row][i] = present
        key = tuple(tuple(r) for r in state)
        if key not in cache:
            cache[key] = shelf(state, base, prods)
        frame = cache[key].copy()
        person(frame, t)
        d = ImageDraw.Draw(frame)
        d.text((24, H - 32), f"{int(t) // 60}:{int(t) % 60:02d}", fill=(220, 220, 220), font=clock_font)
        d.text((110, H - 30), "synthetic shelf · products: Sell Products (CC BY 4.0)", fill=(150, 150, 150), font=note_font)
        ff.stdin.write(frame.tobytes())
    ff.stdin.close()
    if ff.wait():
        sys.exit("ffmpeg failed")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
