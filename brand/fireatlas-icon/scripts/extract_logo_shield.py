# -*- coding: utf-8 -*-
"""Extract shield logo from app icon: remove outer amber tile → transparent / light bg."""
from pathlib import Path

from PIL import Image

ROOT = Path(r"C:\Users\Admin\Desktop\FireAtlas\brand\fireatlas-icon\master")
SRC = ROOT / "fireatlas-app-1024x1024-source.png"
if not SRC.exists():
    SRC = ROOT / "fireatlas-app-1024x1024.png"

# Auth screen light gray (approx from screenshot)
AUTH_BG = (242, 242, 242, 255)


def is_outer_orange(r: int, g: int, b: int, a: int) -> bool:
    if a < 20:
        return True
    # Amber/orange tile (not red truck)
    if r > 200 and 80 < g < 200 and b < 100:
        return True
    if r > 220 and g > 140 and b < 80:
        return True
    return False


def flood_remove_orange(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    visited = [[False] * w for _ in range(h)]
    stack = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w // 2, 0), (0, h // 2)]
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= w or y >= h or visited[y][x]:
            continue
        r, g, b, a = px[x, y]
        if not is_outer_orange(r, g, b, a):
            continue
        visited[y][x] = True
        px[x, y] = (0, 0, 0, 0)
        stack.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return img


def trim_transparent(img: Image.Image, pad: int = 48) -> Image.Image:
    bbox = img.getbbox()
    if not bbox:
        return img
    cropped = img.crop(bbox)
    # Pad and center on square canvas
    cw, ch = cropped.size
    side = max(cw, ch) + pad * 2
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    out.paste(cropped, ((side - cw) // 2, (side - ch) // 2), cropped)
    return out


def main() -> None:
    src = Image.open(SRC)
    logo = flood_remove_orange(src)
    logo = trim_transparent(logo, pad=64)

    # Standard sizes for login UI
    sizes = [128, 192, 256, 512, 1024]
    for n in sizes:
        resized = logo.resize((n, n), Image.Resampling.LANCZOS)
        resized.save(ROOT / f"fireatlas-logo-shield-{n}x{n}.png", "PNG")
        # On light auth background
        bg = Image.new("RGBA", (n, n), AUTH_BG)
        bg.alpha_composite(resized)
        bg.convert("RGB").save(ROOT / f"fireatlas-logo-shield-on-light-{n}x{n}.png", "PNG")

    print("Wrote logo variants:")
    for p in sorted(ROOT.glob("fireatlas-logo-shield*.png")):
        print(" ", p.name)


if __name__ == "__main__":
    main()
