# -*- coding: utf-8 -*-
"""Refresh exports from AI master source."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

brand = Path(r"C:\Users\Admin\Desktop\FireAtlas\brand\fireatlas-icon")
ai = Path(
    r"C:\Users\Admin\.cursor\projects\c-Users-Admin-Desktop-FireAtlas\assets\master-flame-pin-ai.png"
)
src = Image.open(ai).convert("RGBA").resize((1024, 1024), Image.Resampling.LANCZOS)
(brand / "master").mkdir(parents=True, exist_ok=True)
src.save(brand / "master" / "icon-1024-ai-source.png", "PNG")


def round_mask(size: int, radius: int) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


out = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
mask = round_mask(1024, int(1024 * 0.22))
out.paste(src, (0, 0), mask=mask)
out.save(brand / "master" / "icon-1024.png", "PNG")
rgb = Image.new("RGB", (1024, 1024), (245, 158, 11))
rgb.paste(out, mask=out.split()[-1])
rgb.save(brand / "master" / "icon-1024-opaque.png", "PNG")

exports = brand / "exports"
for p in ("rustore", "web", "vk", "tauri"):
    (exports / p).mkdir(parents=True, exist_ok=True)


def save_resized(img: Image.Image, path: Path, n: int) -> None:
    img.resize((n, n), Image.Resampling.LANCZOS).save(path, "PNG")


for n in (512, 1024):
    save_resized(out, exports / "rustore" / f"icon-{n}.png", n)

for n, name in [
    (16, "favicon-16.png"),
    (32, "favicon-32.png"),
    (48, "favicon-48.png"),
    (180, "apple-touch-180.png"),
    (192, "icon-192.png"),
    (512, "icon-512.png"),
]:
    save_resized(out, exports / "web" / name, n)


def circle(img: Image.Image) -> Image.Image:
    s = img.size[0]
    o = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    m = Image.new("L", (s, s), 0)
    ImageDraw.Draw(m).ellipse((0, 0, s - 1, s - 1), fill=255)
    o.paste(img, (0, 0), m)
    return o


for n in (400, 700):
    circle(out.resize((n, n), Image.Resampling.LANCZOS)).save(
        exports / "vk" / f"avatar-{n}.png", "PNG"
    )

AMBER = (245, 158, 11)
NAVY = (15, 35, 70)
w, h = 1590, 400
cover = Image.new("RGB", (w, h), AMBER)
d = ImageDraw.Draw(cover)
d.rectangle((0, h - 8, w, h), fill=NAVY)
icon_size = int(h * 0.72)
icon = out.resize((icon_size, icon_size), Image.Resampling.LANCZOS)
ix = int(w * 0.08)
iy = (h - icon_size) // 2
cover.paste(icon, (ix, iy), icon)
try:
    font = ImageFont.truetype(r"C:\Windows\Fonts\arialbd.ttf", size=int(h * 0.28))
except OSError:
    font = ImageFont.load_default()
text = "Пожарный Атлас"
tx = ix + icon_size + int(w * 0.04)
ty = h // 2 - int(h * 0.16)
d.text((tx + 3, ty + 3), text, font=font, fill=(120, 60, 0))
d.text((tx, ty), text, font=font, fill=NAVY)
cover.save(exports / "vk" / "cover-1590x400.png", "PNG")

out.save(exports / "tauri" / "app-icon-1024.png", "PNG")
print("OK refreshed from AI master")
