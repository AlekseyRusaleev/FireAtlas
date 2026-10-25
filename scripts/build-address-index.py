#!/usr/bin/env python3
"""Собрать локальный адресный индекс (SQLite) без Nominatim.

Пробный пакет: Новосибирск, точки addr:street + addr:housenumber из OSM (Overpass).
Файл кладётся в dist-app/addresses/novosibirsk.sqlite — его читает поиск на карте.
"""
from __future__ import annotations

import json
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "dist-app" / "addresses"
CACHE = OUT_DIR / "cache" / "novosibirsk"

# Центр и радиус как у офлайн-пакета карты Новосибирска (~18 км).
CENTER_LAT, CENTER_LON = 55.0084, 82.9357
RADIUS_KM = 18.0
CITY = "Новосибирск"
PACK_ID = "novosibirsk"

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
]
UA = "FireAtlas/address-index (offline trial; novosibirsk)"

STREET_STOP = {
    "улица",
    "ул",
    "проспект",
    "пр",
    "переулок",
    "пер",
    "шоссе",
    "проезд",
    "бульвар",
    "набережная",
    "наб",
    "площадь",
    "пл",
    "дом",
    "город",
    "микрорайон",
    "мкр",
}


def bbox(lat: float, lon: float, radius_km: float) -> tuple[float, float, float, float]:
    d_lat = radius_km / 111.32
    cos = max(__import__("math").cos(lat * __import__("math").pi / 180), 0.2)
    d_lon = radius_km / (111.32 * cos)
    return lat - d_lat, lon - d_lon, lat + d_lat, lon + d_lon


def tiles(south: float, west: float, north: float, east: float, step_lat=0.09, step_lon=0.14):
    lat = south
    while lat < north - 1e-9:
        lon = west
        lat2 = min(north, lat + step_lat)
        while lon < east - 1e-9:
            lon2 = min(east, lon + step_lon)
            yield lat, lon, lat2, lon2
            lon = lon2
        lat = lat2


def street_key(street: str) -> str:
    text = street.lower().replace("ё", "е")
    parts = []
    for raw in text.replace(",", " ").replace(".", " ").split():
        token = raw.strip("«»\"'")
        if len(token) < 2 or token in STREET_STOP:
            continue
        parts.append(token)
    return " ".join(parts)


def norm_house(house: str) -> str:
    return house.lower().replace(" ", "").replace("ё", "е")


def fetch_tile(south: float, west: float, north: float, east: float, depth: int = 0) -> list[dict]:
    query = f"""
[out:json][timeout:180];
(
  node["addr:housenumber"]["addr:street"]({south},{west},{north},{east});
  way["addr:housenumber"]["addr:street"]({south},{west},{north},{east});
);
out center;
"""
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    last_err = "нет ответа"
    for endpoint in ENDPOINTS:
        req = urllib.request.Request(
            endpoint,
            data=data,
            headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            with urllib.request.urlopen(req, timeout=100) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            return payload.get("elements") or []
        except Exception as exc:
            last_err = f"{type(exc).__name__}: {exc}"
            print(f"  retry {endpoint} {last_err}", flush=True)
            time.sleep(2)
    if depth >= 3:
        raise RuntimeError(last_err)
    mid_lat = (south + north) / 2
    mid_lon = (west + east) / 2
    print(f"  split depth {depth + 1}", flush=True)
    parts: list[dict] = []
    for cell in (
        (south, west, mid_lat, mid_lon),
        (south, mid_lon, mid_lat, east),
        (mid_lat, west, north, mid_lon),
        (mid_lat, mid_lon, north, east),
    ):
        parts.extend(fetch_tile(*cell, depth + 1))
        time.sleep(1)
    return parts


def element_point(el: dict) -> tuple[float, float] | None:
    if "lat" in el and "lon" in el:
        return float(el["lat"]), float(el["lon"])
    center = el.get("center") or {}
    if "lat" in center and "lon" in center:
        return float(center["lat"]), float(center["lon"])
    return None


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    south, west, north, east = bbox(CENTER_LAT, CENTER_LON, RADIUS_KM)
    cells = list(tiles(south, west, north, east))
    print(f"bbox {south:.4f},{west:.4f},{north:.4f},{east:.4f} tiles {len(cells)}")

    rows: dict[tuple, tuple] = {}
    for i, cell in enumerate(cells, 1):
        cache_file = CACHE / f"tile-{i:02d}.json"
        if cache_file.is_file() and cache_file.stat().st_size > 20:
            elements = json.loads(cache_file.read_text(encoding="utf-8"))
            print(f"tile {i}/{len(cells)} cache {len(elements)}")
        else:
            print(f"tile {i}/{len(cells)} download {cell[0]:.3f},{cell[1]:.3f}…", flush=True)
            elements = fetch_tile(*cell)
            cache_file.write_text(json.dumps(elements, ensure_ascii=False), encoding="utf-8")
            print(f"  elements {len(elements)}")
            time.sleep(1.2)
        for el in elements:
            tags = el.get("tags") or {}
            street = (tags.get("addr:street") or "").strip()
            house = norm_house(tags.get("addr:housenumber") or "")
            key = street_key(street)
            point = element_point(el)
            if not street or not house or not key or not point:
                continue
            lat, lon = point
            dedupe = (key, house, round(lat, 5), round(lon, 5))
            rows[dedupe] = (CITY, street, key, house, lat, lon)

    db_path = OUT_DIR / f"{PACK_ID}.sqlite"
    if db_path.exists():
        db_path.unlink()
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE addresses (
          id INTEGER PRIMARY KEY,
          city TEXT NOT NULL,
          street TEXT NOT NULL,
          street_key TEXT NOT NULL,
          house TEXT NOT NULL,
          lat REAL NOT NULL,
          lon REAL NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX idx_addr_house ON addresses(house)")
    conn.execute("CREATE INDEX idx_addr_street ON addresses(street_key)")
    conn.executemany(
        "INSERT INTO addresses(city, street, street_key, house, lat, lon) VALUES (?,?,?,?,?,?)",
        rows.values(),
    )
    conn.execute(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    conn.executemany(
        "INSERT INTO meta(key, value) VALUES (?, ?)",
        [
            ("pack_id", PACK_ID),
            ("city", CITY),
            ("count", str(len(rows))),
            ("source", "osm-overpass-addr"),
        ],
    )
    conn.commit()
    conn.close()
    print(f"wrote {db_path} rows {len(rows)} bytes {db_path.stat().st_size}")

    conn = sqlite3.connect(db_path)
    for title, sql, args in [
        (
            "Красный проспект 1",
            "SELECT street, house, lat, lon FROM addresses WHERE house=? AND street_key LIKE ? LIMIT 3",
            ("1", "%красный%"),
        ),
        (
            "Ленина 10",
            "SELECT street, house, lat, lon FROM addresses WHERE house=? AND street_key LIKE ? LIMIT 3",
            ("10", "%ленина%"),
        ),
    ]:
        found = conn.execute(sql, args).fetchall()
        print(title, found[:3], "n", len(found))
    conn.close()


if __name__ == "__main__":
    main()
