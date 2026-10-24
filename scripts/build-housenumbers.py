#!/usr/bin/env python3
"""Download OSM addr:housenumber points for bundled NSO map packs."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(r"C:\Users\Admin\Desktop\FireAtlas\src-tauri\resources\maps")
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
UA = "FireAtlas/0.1.48 (offline house numbers)"


def overpass(s: float, w: float, n: float, e: float, timeout: int = 180) -> list[tuple[float, float, str]]:
    query = (
        f"[out:json][timeout:{timeout}];"
        f'(node["addr:housenumber"]({s},{w},{n},{e});'
        f'way["addr:housenumber"]({s},{w},{n},{e}););'
        f"out center tags;"
    )
    data = query.encode("utf-8")
    last_err = "no endpoint"
    for url in ENDPOINTS:
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={
                "Content-Type": "text/plain; charset=UTF-8",
                "User-Agent": UA,
            },
        )
        try:
            print(f"    POST {url}", flush=True)
            with urllib.request.urlopen(req, timeout=timeout + 30) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            items: list[tuple[float, float, str]] = []
            for el in payload.get("elements") or []:
                tags = el.get("tags") or {}
                num = str(tags.get("addr:housenumber") or "").strip()
                if not num:
                    continue
                if el.get("type") == "node":
                    lat, lon = el.get("lat"), el.get("lon")
                else:
                    c = el.get("center") or {}
                    lat, lon = c.get("lat"), c.get("lon")
                if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
                    continue
                items.append((round(float(lon), 6), round(float(lat), 6), num[:24]))
            return items
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError) as exc:
            last_err = str(exc)
            print(f"    fail {url}: {exc}", flush=True)
            time.sleep(2)
            continue
    raise RuntimeError(last_err)


def pack_city(meta_path: Path) -> None:
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    dest = meta_path.with_name("housenumbers.json")
    south, west, north, east = meta["south"], meta["west"], meta["north"], meta["east"]
    print(f"{meta['id']}: bbox {south:.3f},{west:.3f},{north:.3f},{east:.3f}", flush=True)
    chunk = None
    for attempt in range(3):
        try:
            chunk = overpass(south, west, north, east)
            break
        except Exception as exc:
            print(f"  retry {attempt + 1}: {exc}", flush=True)
            time.sleep(5 + attempt * 5)
    if chunk is None:
        raise RuntimeError(f"failed {meta['id']}")
    seen: set[tuple[float, float, str]] = set()
    items: list[list[object]] = []
    for lon, lat, num in chunk:
        key = (lon, lat, num)
        if key in seen:
            continue
        seen.add(key)
        items.append([lon, lat, num])
    dest.write_text(
        json.dumps({"v": 1, "items": items}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"  wrote {len(items)} numbers, {dest.stat().st_size} bytes", flush=True)


def main() -> None:
    metas = sorted(ROOT.glob("*/meta.json"))
    if not metas:
        raise SystemExit(f"no packs in {ROOT}")
    for meta in metas:
        pack_city(meta)


if __name__ == "__main__":
    main()
