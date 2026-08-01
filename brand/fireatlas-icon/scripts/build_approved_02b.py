# -*- coding: utf-8 -*-
"""Build master + exports from approved gallery-02b shield icon."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(r"C:\Users\Admin\Desktop\FireAtlas\brand\fireatlas-icon")
ASSETS = Path(r"C:\Users\Admin\.cursor\projects\c-Users-Admin-Desktop-FireAtlas\assets")

# Exact file the user approved
APPROVED = ASSETS / (
    "c__Users_Admin_AppData_Roaming_Cursor_User_workspaceStorage_empty-window_images_"
    "gallery-02b-shield-route-555f818f-9c2d-41a2-9e8b-6589e066bf27.png"
)
# Prefer gallery copy if attachment path missing
if not APPROVED.exists():
    APPROVED = ROOT / "concepts" / "gallery" / "gallery-02b-shield-route.png"
FAVICON_SRC = ASSETS / "favicon-simple-shield.png"

AMBER = (245, 158, 11)
NAVY = (15, 35, 70)


def round_mask(size: int, radius: int) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


def to_app_icon(src: Image.Image, size: int = 1024) -> Image.Image:
    img = src.convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mask = round_mask(size, int(size * 0.22))
    out.paste(img, (0, 0), mask=mask)
    return out


def circle(img: Image.Image) -> Image.Image:
    s = img.size[0]
    o = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    m = Image.new("L", (s, s), 0)
    ImageDraw.Draw(m).ellipse((0, 0, s - 1, s - 1), fill=255)
    o.paste(img, (0, 0), m)
    return o


def main() -> None:
    master_dir = ROOT / "master"
    exports = ROOT / "exports"
    for p in [
        master_dir,
        exports / "rustore",
        exports / "web",
        exports / "vk",
        exports / "tauri",
    ]:
        p.mkdir(parents=True, exist_ok=True)

    raw = Image.open(APPROVED).convert("RGBA")
    master = to_app_icon(raw, 1024)
    master.save(master_dir / "fireatlas-app-1024x1024.png", "PNG")
    raw.resize((1024, 1024), Image.Resampling.LANCZOS).save(
        master_dir / "fireatlas-app-1024x1024-source.png", "PNG"
    )
    rgb = Image.new("RGB", (1024, 1024), AMBER)
    rgb.paste(master, mask=master.split()[-1])
    rgb.save(master_dir / "fireatlas-app-1024x1024-opaque.png", "PNG")

    # Approved note
    (master_dir / "APPROVED.txt").write_text(
        "Approved: gallery-02b shield + route + fire truck\n"
        "Use for: PC, Android/RuStore, web, VK\n"
        "Favicon small sizes use favicon-simple twin.\n",
        encoding="utf-8",
    )

    fav = to_app_icon(Image.open(FAVICON_SRC).convert("RGBA"), 1024)
    fav.save(master_dir / "fireatlas-favicon-simple-1024x1024.png", "PNG")

    for n in (512, 1024):
        master.resize((n, n), Image.Resampling.LANCZOS).save(
            exports / "rustore" / f"icon-{n}.png", "PNG"
        )

    # Web: full for large, simple for tiny favicons
    for n, name, src in [
        (16, "favicon-16.png", fav),
        (32, "favicon-32.png", fav),
        (48, "favicon-48.png", fav),
        (180, "apple-touch-180.png", master),
        (192, "icon-192.png", master),
        (512, "icon-512.png", master),
    ]:
        src.resize((n, n), Image.Resampling.LANCZOS).save(exports / "web" / name, "PNG")

    for n in (400, 700):
        circle(master.resize((n, n), Image.Resampling.LANCZOS)).save(
            exports / "vk" / f"avatar-{n}.png", "PNG"
        )

    # VK cover
    w, h = 1590, 400
    cover = Image.new("RGB", (w, h), AMBER)
    d = ImageDraw.Draw(cover)
    d.rectangle((0, h - 8, w, h), fill=NAVY)
    icon_size = int(h * 0.72)
    icon = master.resize((icon_size, icon_size), Image.Resampling.LANCZOS)
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

    master.save(exports / "tauri" / "app-icon-1024.png", "PNG")
    print("Master from:", APPROVED.name)
    print("OK")


if __name__ == "__main__":
    main()
