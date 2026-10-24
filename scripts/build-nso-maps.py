#!/usr/bin/env python3
"""Скачать офлайн-пакеты карт для пунктов ФПС НСО в src-tauri/resources/maps/.

Carto Voyager без ключа отдаёт PNG «API KEY REQUIRED» (~2049 байт) — его не используем.
"""
from __future__ import annotations

import json
import math
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src-tauri" / "resources" / "maps"

CITIES = [
    ("novosibirsk", "Новосибирск", 55.0084, 82.9357, 11, 18.0),
    ("berdsk", "Бердск", 54.7586, 83.0967, 13, 12.0),
    ("iskitim", "Искитим", 54.6397, 83.3061, 13, 12.0),
    ("kuybyshev", "Куйбышев", 55.4475, 78.3219, 13, 14.0),
    ("krasnoobsk", "Краснообск", 54.9203, 82.9906, 14, 10.0),
    ("karasuk", "Карасук", 53.7178, 78.0400, 13, 14.0),
    ("moshkovo", "Мошково", 55.3050, 83.6086, 14, 10.0),
]

ZMIN, ZMAX = 12, 15
MAX_TILES = 8000
WORKERS = 20
PLACEHOLDER_MAX = 2200  # Carto «API KEY REQUIRED» ≈ 2049 байт

# (url, order of z,x,y in path)
HOSTS = [
    ("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", True),
    ("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", True),
    ("https://tile.openstreetmap.org/{z}/{x}/{y}.png", False),
]


def bbox(lat: float, lon: float, radius_km: float):
    dlat = radius_km / 111.0
    dlon = radius_km / (111.0 * max(0.2, math.cos(math.radians(lat))))
    return lat - dlat, lon - dlon, lat + dlat, lon + dlon


def lon_to_x(lon: float, z: int) -> int:
    n = 2**z
    return int(min(n - 1, max(0, math.floor((lon + 180.0) / 360.0 * n))))


def lat_to_y(lat: float, z: int) -> int:
    n = 2**z
    lat_rad = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n
    return int(min(n - 1, max(0, math.floor(y))))


def collect_tiles(south, west, north, east):
    out = []
    for z in range(ZMIN, ZMAX + 1):
        x0 = min(lon_to_x(west, z), lon_to_x(east, z))
        x1 = max(lon_to_x(west, z), lon_to_x(east, z))
        y0 = min(lat_to_y(north, z), lat_to_y(south, z))
        y1 = max(lat_to_y(north, z), lat_to_y(south, z))
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                out.append((z, x, y))
    return out


def is_placeholder(data: bytes) -> bool:
    if len(data) < 80:
        return True
    # Заглушка Carto Voyager без ключа — всегда ~2049 байт.
    if 1900 <= len(data) <= PLACEHOLDER_MAX:
        return True
    return False


def download_one(path: Path, z: int, x: int, y: int) -> bool:
    if path.exists() and path.stat().st_size > PLACEHOLDER_MAX:
        return True
    path.parent.mkdir(parents=True, exist_ok=True)
    headers = {"User-Agent": "FireAtlas/0.1.47 (offline map pack; nso fps)"}
    for tmpl, _esri in HOSTS:
        url = tmpl.format(z=z, x=x, y=y)
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
            if is_placeholder(data):
                continue
            path.write_bytes(data)
            return True
        except Exception:
            time.sleep(0.08)
            continue
    return False


def build_city(city) -> None:
    cid, name, lat, lon, zoom, radius = city
    dest = OUT / cid
    dest.mkdir(parents=True, exist_ok=True)
    south, west, north, east = bbox(lat, lon, radius)
    tiles = collect_tiles(south, west, north, east)
    if len(tiles) > MAX_TILES:
        raise SystemExit(f"{name}: too many tiles {len(tiles)} — reduce radius")
    print(f"== {name}: {len(tiles)} tiles → {dest}", flush=True)
    ok = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futs = {
            pool.submit(download_one, dest / str(z) / str(x) / f"{y}.png", z, x, y): (z, x, y)
            for z, x, y in tiles
        }
        done = 0
        for fut in as_completed(futs):
            done += 1
            if fut.result():
                ok += 1
            if done % 200 == 0 or done == len(tiles):
                print(f"  {name}: {done}/{len(tiles)} ({ok} ok)", flush=True)
    meta = {
        "id": cid,
        "name": name,
        "lat": lat,
        "lon": lon,
        "zoom": zoom,
        "min_zoom": ZMIN,
        "max_zoom": ZMAX,
        "south": south,
        "west": west,
        "north": north,
        "east": east,
        "tile_count": ok,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": "Esri World Street Map / OpenStreetMap raster tiles",
        "radius_km": radius,
        "pack_revision": 2,
    }
    (dest / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"  DONE {name}: {ok}/{len(tiles)}", flush=True)


def main():
    only = set(sys.argv[1:]) if len(sys.argv) > 1 else None
    OUT.mkdir(parents=True, exist_ok=True)
    for city in CITIES:
        if only and city[0] not in only and city[1] not in only:
            continue
        build_city(city)
    print("All done.", flush=True)


if __name__ == "__main__":
    main()
