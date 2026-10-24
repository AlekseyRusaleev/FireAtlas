#!/usr/bin/env python3
"""Download OpenFreeMap z14 vector tiles (housenumber layer) for NSO packs."""

from __future__ import annotations

import json
import math
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(r"C:\Users\Admin\Desktop\FireAtlas\src-tauri\resources\maps")
Z = 14
WORKERS = 16
UA = "FireAtlas/0.1.48 (offline housenumber tiles)"
TILEJSON = "https://tiles.openfreemap.org/planet"


def lon_to_x(lon: float, z: int) -> int:
    n = 2**z
    return int(min(n - 1, max(0, math.floor((lon + 180.0) / 360.0 * n))))


def lat_to_y(lat: float, z: int) -> int:
    n = 2**z
    lat_rad = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n
    return int(min(n - 1, max(0, math.floor(y))))


def collect(south, west, north, east):
    x0, x1 = lon_to_x(west, Z), lon_to_x(east, Z)
    y0, y1 = lat_to_y(north, Z), lat_to_y(south, Z)
    if x0 > x1:
        x0, x1 = x1, x0
    if y0 > y1:
        y0, y1 = y1, y0
    return [(Z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


def fetch_template() -> str:
    req = urllib.request.Request(TILEJSON, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    tiles = data.get("tiles") or []
    if not tiles:
        raise SystemExit("no tiles in tilejson")
    print("template", tiles[0], flush=True)
    return tiles[0]


def download_one(url: str, dest: Path) -> str:
    if dest.is_file() and dest.stat().st_size > 50:
        return "skip"
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=40) as resp:
        data = resp.read()
    if len(data) < 20:
        return "empty"
    dest.write_bytes(data)
    return "ok"


def pack_city(meta_path: Path, template: str) -> None:
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    tiles = collect(meta["south"], meta["west"], meta["north"], meta["east"])
    out_root = meta_path.parent / "omtiles"
    print(f"{meta['id']}: {len(tiles)} z{Z} tiles -> {out_root}", flush=True)
    ok = skip = fail = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futs = {}
        for z, x, y in tiles:
            url = template.format(z=z, x=x, y=y)
            dest = out_root / str(z) / str(x) / f"{y}.pbf"
            futs[pool.submit(download_one, url, dest)] = (z, x, y)
        done = 0
        for fut in as_completed(futs):
            done += 1
            try:
                status = fut.result()
            except Exception as exc:
                fail += 1
                if fail <= 5:
                    print("  err", exc, flush=True)
                continue
            if status == "ok":
                ok += 1
            elif status == "skip":
                skip += 1
            else:
                fail += 1
            if done % 40 == 0 or done == len(tiles):
                print(f"  {done}/{len(tiles)} ok={ok} skip={skip} fail={fail}", flush=True)
    print(f"  done {meta['id']} ok={ok} skip={skip} fail={fail}", flush=True)


def main() -> None:
    template = fetch_template()
    for meta in sorted(ROOT.glob("*/meta.json")):
        pack_city(meta, template)


if __name__ == "__main__":
    main()
