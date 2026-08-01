# -*- coding: utf-8 -*-
"""FireAtlas master icon: flame-map-pin on amber rounded square."""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / "master"
EXPORTS = ROOT / "exports"

# Brand colors (continuity with ДППД orange + navy)
AMBER = (245, 158, 11)  # warm amber fill
AMBER_DEEP = (234, 120, 8)
NAVY = (15, 35, 70)
NAVY_EDGE = (8, 22, 48)
FLAME_CORE = (255, 236, 179)
FLAME_MID = (255, 140, 30)
FLAME_OUTER = (220, 48, 28)
WHITE = (255, 255, 255)


def rounded_rect_mask(size: int, radius: float) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


def pin_path(cx: float, cy: float, w: float, h: float) -> list[tuple[float, float]]:
    """Teardrop / map-pin outline, point down. Flame-like top lobes."""
    # Normalized in [-1,1] x [ -1.15 .. 1.0 ], then scaled
    pts: list[tuple[float, float]] = []
    # Left lobe up around top, right lobe, then down to tip
    # Parametric-ish polygon approximating flame-pin silhouette
    raw = [
        (0.0, -1.05),
        (0.28, -0.98),
        (0.55, -0.78),
        (0.72, -0.45),
        (0.78, -0.08),
        (0.70, 0.25),
        (0.48, 0.55),
        (0.22, 0.82),
        (0.0, 1.12),
        (-0.22, 0.82),
        (-0.48, 0.55),
        (-0.70, 0.25),
        (-0.78, -0.08),
        (-0.72, -0.45),
        (-0.55, -0.78),
        (-0.28, -0.98),
    ]
    # Add slight flame notch on top-right for character
    raw = [
        (0.0, -1.12),
        (0.18, -1.02),
        (0.35, -1.08),  # flame tip
        (0.52, -0.88),
        (0.68, -0.58),
        (0.76, -0.22),
        (0.72, 0.12),
        (0.58, 0.42),
        (0.36, 0.70),
        (0.16, 0.92),
        (0.0, 1.15),
        (-0.16, 0.92),
        (-0.36, 0.70),
        (-0.58, 0.42),
        (-0.72, 0.12),
        (-0.76, -0.22),
        (-0.68, -0.58),
        (-0.48, -0.85),
        (-0.28, -1.00),
        (-0.12, -1.06),
    ]
    scale_x = w / 2
    scale_y = h / 2.27
    return [(cx + x * scale_x, cy + y * scale_y) for x, y in raw]


def inner_flame(cx: float, cy: float, w: float, h: float) -> list[tuple[float, float]]:
    raw = [
        (0.0, -0.72),
        (0.12, -0.62),
        (0.22, -0.70),
        (0.36, -0.48),
        (0.42, -0.18),
        (0.36, 0.12),
        (0.20, 0.38),
        (0.0, 0.55),
        (-0.20, 0.38),
        (-0.36, 0.12),
        (-0.42, -0.18),
        (-0.36, -0.48),
        (-0.20, -0.66),
        (-0.08, -0.62),
    ]
    scale_x = w / 2 * 0.62
    scale_y = h / 2.27 * 0.62
    # Shift up slightly inside pin
    return [(cx + x * scale_x, cy - h * 0.08 + y * scale_y) for x, y in raw]


def core_flame(cx: float, cy: float, w: float, h: float) -> list[tuple[float, float]]:
    raw = [
        (0.0, -0.35),
        (0.10, -0.28),
        (0.16, -0.10),
        (0.12, 0.10),
        (0.0, 0.22),
        (-0.12, 0.10),
        (-0.16, -0.10),
        (-0.10, -0.28),
    ]
    scale_x = w / 2 * 0.32
    scale_y = h / 2.27 * 0.32
    return [(cx + x * scale_x, cy - h * 0.12 + y * scale_y) for x, y in raw]


def render_icon(size: int = 1024) -> Image.Image:
    # Draw at 2x then downscale for smoother edges
    s = size * 2
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = int(s * 0.02)
    radius = s * 0.22
    # Background gradient-ish: solid amber with slight radial via overlay
    draw.rounded_rectangle(
        (pad, pad, s - 1 - pad, s - 1 - pad),
        radius=radius,
        fill=AMBER,
    )
    # Soft vignette
    vignette = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    vd = ImageDraw.Draw(vignette)
    for i in range(40):
        t = i / 40
        a = int(18 * t)
        inset = int(s * 0.02 + i * s * 0.004)
        vd.rounded_rectangle(
            (inset, inset, s - 1 - inset, s - 1 - inset),
            radius=max(4, radius - inset * 0.3),
            outline=(*AMBER_DEEP, a),
            width=max(2, s // 200),
        )
    img = Image.alpha_composite(img, vignette)
    draw = ImageDraw.Draw(img)

    cx, cy = s / 2, s / 2 - s * 0.02
    pin_w, pin_h = s * 0.46, s * 0.58

    # Drop shadow
    shadow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    shadow_pts = [(x + s * 0.018, y + s * 0.028) for x, y in pin_path(cx, cy, pin_w, pin_h)]
    sd.polygon(shadow_pts, fill=(0, 0, 0, 70))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=s * 0.02))
    img = Image.alpha_composite(img, shadow)
    draw = ImageDraw.Draw(img)

    outer = pin_path(cx, cy, pin_w, pin_h)
    # Navy body
    draw.polygon(outer, fill=NAVY)
    # Slight edge darken
    draw.line(outer + [outer[0]], fill=NAVY_EDGE, width=max(2, s // 180))

    # Outer flame fill (red-orange) — same pin but inset conceptually via second poly
    mid = pin_path(cx, cy, pin_w * 0.78, pin_h * 0.78)
    # Shift mid up a bit
    mid = [(x, y - pin_h * 0.02) for x, y in mid]
    draw.polygon(mid, fill=FLAME_OUTER)

    # Mid flame
    flame = inner_flame(cx, cy, pin_w, pin_h)
    draw.polygon(flame, fill=FLAME_MID)

    # Core
    core = core_flame(cx, cy, pin_w, pin_h)
    draw.polygon(core, fill=FLAME_CORE)

    # Soft highlight
    hx, hy = cx - pin_w * 0.12, cy - pin_h * 0.22
    hr = pin_w * 0.08
    highlight = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    hd = ImageDraw.Draw(highlight)
    hd.ellipse((hx - hr, hy - hr, hx + hr, hy + hr), fill=(255, 255, 255, 90))
    highlight = highlight.filter(ImageFilter.GaussianBlur(radius=hr * 0.6))
    img = Image.alpha_composite(img, highlight)

    # Apply rounded mask for clean corners
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    mask = rounded_rect_mask(s, radius)
    out.paste(img, (0, 0), mask=mask)

    out = out.resize((size, size), Image.Resampling.LANCZOS)
    return out


def circle_crop(img: Image.Image) -> Image.Image:
    s = img.size[0]
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, s - 1, s - 1), fill=255)
    out.paste(img, (0, 0), mask=mask)
    return out


def cover_banner(master: Image.Image, width: int = 1590, height: int = 400) -> Image.Image:
    """Simple VK cover: amber field + icon + title."""
    img = Image.new("RGB", (width, height), AMBER)
    draw = ImageDraw.Draw(img)
    # Navy bottom bar
    draw.rectangle((0, height - 8, width, height), fill=NAVY)
    # Icon
    icon_size = int(height * 0.72)
    icon = master.resize((icon_size, icon_size), Image.Resampling.LANCZOS)
    ix = int(width * 0.08)
    iy = (height - icon_size) // 2
    img.paste(icon, (ix, iy), icon)
    # Title via simple block letters approximation — use default font large
    try:
        from PIL import ImageFont

        font_paths = [
            r"C:\Windows\Fonts\arialbd.ttf",
            r"C:\Windows\Fonts\segoeuib.ttf",
            r"C:\Windows\Fonts\arial.ttf",
        ]
        font = None
        for fp in font_paths:
            if Path(fp).exists():
                font = ImageFont.truetype(fp, size=int(height * 0.28))
                break
        if font is None:
            font = ImageFont.load_default()
    except Exception:
        from PIL import ImageFont

        font = ImageFont.load_default()

    text = "Пожарный Атлас"
    tx = ix + icon_size + int(width * 0.04)
    ty = height // 2 - int(height * 0.16)
    # Shadow
    draw.text((tx + 3, ty + 3), text, font=font, fill=(120, 60, 0))
    draw.text((tx, ty), text, font=font, fill=NAVY)
    return img


def save_svg(path: Path) -> None:
    """Vector master matching the raster composition (viewBox 0 0 1024 1024)."""
    svg = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="Пожарный Атлас">
  <defs>
    <linearGradient id="flame" x1="50%" y1="15%" x2="50%" y2="85%">
      <stop offset="0%" stop-color="#FFECB3"/>
      <stop offset="45%" stop-color="#FF8C1E"/>
      <stop offset="100%" stop-color="#DC301C"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-10%" width="140%" height="140%">
      <feDropShadow dx="12" dy="18" stdDeviation="16" flood-color="#000" flood-opacity="0.28"/>
    </filter>
  </defs>
  <!-- App tile -->
  <rect x="16" y="16" width="992" height="992" rx="220" ry="220" fill="#F59E0B"/>
  <!-- Pin / flame silhouette -->
  <g filter="url(#shadow)" transform="translate(512 500)">
    <path fill="#0F2346" d="M0-320 C70-300 120-250 145-180 C170-100 160-20 120 70 C80 150 40 220 0 290 C-40 220 -80 150 -120 70 C-160-20 -170-100 -145-180 C-120-250 -70-300 0-320 Z"/>
    <path fill="url(#flame)" d="M0-250 C45-235 85-195 100-130 C115-65 105 0 75 70 C45 130 20 180 0 230 C-20 180 -45 130 -75 70 C-105 0 -115-65 -100-130 C-85-195 -45-235 0-250 Z"/>
    <path fill="#FFECB3" opacity="0.95" d="M0-120 C22-110 35-80 32-45 C28-10 14 15 0 35 C-14 15 -28-10 -32-45 C-35-80 -22-110 0-120 Z"/>
  </g>
</svg>
"""
    path.write_text(svg, encoding="utf-8")


def main() -> None:
    MASTER.mkdir(parents=True, exist_ok=True)
    for p in [
        EXPORTS / "tauri",
        EXPORTS / "rustore",
        EXPORTS / "web",
        EXPORTS / "vk",
    ]:
        p.mkdir(parents=True, exist_ok=True)

    master = render_icon(1024)
    master_path = MASTER / "icon-1024.png"
    master.save(master_path, "PNG")
    save_svg(MASTER / "icon.svg")
    # Also opaque RGB for stores that dislike alpha
    rgb = Image.new("RGB", master.size, AMBER)
    rgb.paste(master, mask=master.split()[-1])
    rgb.save(MASTER / "icon-1024-opaque.png", "PNG")

    # RuStore
    for n in (512, 1024):
        master.resize((n, n), Image.Resampling.LANCZOS).save(
            EXPORTS / "rustore" / f"icon-{n}.png", "PNG"
        )

    # Web
    for n, name in [
        (16, "favicon-16.png"),
        (32, "favicon-32.png"),
        (48, "favicon-48.png"),
        (180, "apple-touch-180.png"),
        (192, "icon-192.png"),
        (512, "icon-512.png"),
    ]:
        master.resize((n, n), Image.Resampling.LANCZOS).save(EXPORTS / "web" / name, "PNG")

    # VK
    for n in (400, 700):
        circle_crop(master.resize((n, n), Image.Resampling.LANCZOS)).save(
            EXPORTS / "vk" / f"avatar-{n}.png", "PNG"
        )
    cover_banner(master).save(EXPORTS / "vk" / "cover-1590x400.png", "PNG")

    # Tauri source (1024) — tauri icon CLI will generate the rest
    master.save(EXPORTS / "tauri" / "app-icon-1024.png", "PNG")

    print("Wrote", master_path)
    print("SVG", MASTER / "icon.svg")


if __name__ == "__main__":
    main()
