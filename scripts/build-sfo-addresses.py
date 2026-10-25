#!/usr/bin/env python3
"""Адресные индексы всех субъектов и городов Сибирского федерального округа.

Источник: OSM PBF. Дом попадает в файл субъекта по границе и в файл города,
если это город/посёлок городского типа или достаточно большой населённый пункт.
"""
from __future__ import annotations

import json
import math
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path

REGIONS = [
    ("altaiskii-krai", "Алтайский край", "Алтайский край"),
    ("respublika-altai", "Республика Алтай", "Алтай"),
    ("irkutskaya-oblast", "Иркутская область", "Иркутская область"),
    ("kemerovskaya-oblast", "Кемеровская область", "Кемеровская область"),
    ("krasnoyarskii-krai", "Красноярский край", "Красноярский край"),
    ("novosibirskaya-oblast", "Новосибирская область", "Новосибирская область"),
    ("omskaya-oblast", "Омская область", "Омская область"),
    ("tomskaya-oblast", "Томская область", "Томская область"),
    ("respublika-tyva", "Республика Тыва", "Тыва"),
    ("respublika-khakasiya", "Республика Хакасия", "Республика Хакасия"),
]
GEOJSON_NAME = {item[2]: (item[0], item[1]) for item in REGIONS}

STREET_STOP = {
    "улица", "ул", "проспект", "пр", "переулок", "пер", "шоссе", "проезд",
    "бульвар", "набережная", "наб", "площадь", "пл", "дом", "город",
    "микрорайон", "мкр", "тракт", "тупик", "аллея",
}
TR = str.maketrans(
    {
        "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
        "ж": "zh", "з": "z", "и": "i", "й": "i", "к": "k", "л": "l", "м": "m",
        "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
        "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch",
        "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    }
)
PLACE_PREFIX = re.compile(
    r"^(город|г|село|деревня|д|посёлок|поселок|пгт|рп|п|рабочий посёлок|рабочий поселок)\.?\s+",
    re.IGNORECASE,
)


def norm_key(value: str) -> str:
    text = value.lower().replace("ё", "е").replace("—", "-").replace("–", "-")
    text = text.replace(".", " ").replace(",", " ")
    return " ".join(text.split())


def clean_place(value: str) -> str:
    text = " ".join((value or "").replace("ё", "е").split())
    text = PLACE_PREFIX.sub("", text).strip(" ,.")
    return text[:120]


def street_key(street: str) -> str:
    parts = []
    for raw in street.lower().replace("ё", "е").replace(",", " ").replace(".", " ").split():
        token = raw.strip("«»\"'")
        if len(token) < 2 or token in STREET_STOP:
            continue
        parts.append(token)
    return " ".join(parts)


def norm_house(house: str) -> str:
    return house.lower().replace(" ", "").replace("ё", "е")[:32]


def slug(value: str) -> str:
    text = norm_key(value).translate(TR)
    text = unicodedata.normalize("NFKD", text)
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return (text or "place")[:80]


def point_in_ring(lon: float, lat: float, ring: list) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > lat) != (yj > lat)) and (
            lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi
        ):
            inside = not inside
        j = i
    return inside


def point_in_geometry(lon: float, lat: float, geometry: dict) -> bool:
    gtype = geometry["type"]
    coords = geometry["coordinates"]
    if gtype == "Polygon":
        return point_in_ring(lon, lat, coords[0]) and not any(
            point_in_ring(lon, lat, hole) for hole in coords[1:]
        )
    if gtype == "MultiPolygon":
        for polygon in coords:
            if point_in_ring(lon, lat, polygon[0]) and not any(
                point_in_ring(lon, lat, hole) for hole in polygon[1:]
            ):
                return True
    return False


def geometry_bbox(geometry: dict) -> tuple[float, float, float, float]:
    lons: list[float] = []
    lats: list[float] = []

    def walk(node):
        if isinstance(node, (list, tuple)) and node and isinstance(node[0], (int, float)):
            lons.append(node[0])
            lats.append(node[1])
            return
        if isinstance(node, list):
            for item in node:
                walk(item)

    walk(geometry["coordinates"])
    return min(lats), min(lons), max(lats), max(lons)


def load_regions(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    regions = []
    for feature in data["features"]:
        name = (feature.get("properties") or {}).get("name")
        pair = GEOJSON_NAME.get(name)
        if not pair:
            continue
        south, west, north, east = geometry_bbox(feature["geometry"])
        regions.append(
            {
                "id": pair[0],
                "title": pair[1],
                "geometry": feature["geometry"],
                "bbox": (south, west, north, east),
            }
        )
    if len(regions) != 10:
        raise SystemExit(f"ожидались 10 субъектов, в файле {len(regions)}")
    return regions


def locate_region(lat: float, lon: float, regions: list[dict]) -> tuple[str, str] | None:
    for region in regions:
        south, west, north, east = region["bbox"]
        if lat < south or lat > north or lon < west or lon > east:
            continue
        if point_in_geometry(lon, lat, region["geometry"]):
            return region["id"], region["title"]
    return None


def km_radius(min_lat: float, min_lon: float, max_lat: float, max_lon: float) -> tuple[float, float, float]:
    lat = (min_lat + max_lat) / 2
    lon = (min_lon + max_lon) / 2
    d_lat = (max_lat - min_lat) * 111.32 / 2
    cos = max(math.cos(lat * math.pi / 180), 0.2)
    d_lon = (max_lon - min_lon) * 111.32 * cos / 2
    return lat, lon, max(20.0, math.hypot(d_lat, d_lon) * 1.15)


def init_db(path: Path) -> sqlite3.Connection:
    if path.exists():
        path.unlink()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
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
    return conn


def write_pack(path: Path, rows: list[tuple], title: str, meta: list[tuple[str, str]]) -> None:
    conn = init_db(path)
    conn.executemany(
        "INSERT INTO addresses(city, street, street_key, house, lat, lon) VALUES (?,?,?,?,?,?)",
        rows,
    )
    conn.execute("CREATE INDEX idx_addr_house ON addresses(house)")
    conn.execute("CREATE INDEX idx_addr_street ON addresses(street_key)")
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    conn.executemany(
        "INSERT INTO meta(key, value) VALUES (?, ?)",
        meta + [("city", title), ("count", str(len(rows)))],
    )
    conn.commit()
    conn.close()


def nearest_place(lat: float, lon: float, grid: dict, kinds: set[str], max_km: float):
    cos = max(math.cos(lat * math.pi / 180), 0.2)
    cy, cx = int(lat / 0.25), int(lon / 0.25)
    span = max(1, int(max_km / 20) + 1)
    best = None
    best_d = max_km * max_km
    for dy in range(-span, span + 1):
        for dx in range(-span, span + 1):
            for name, kind, plat, plon in grid.get((cy + dy, cx + dx), ()):
                if kind not in kinds:
                    continue
                dlat = (lat - plat) * 111.32
                dlon = (lon - plon) * 111.32 * cos
                dist = dlat * dlat + dlon * dlon
                if dist < best_d:
                    best_d = dist
                    best = name
    return best


def extract(pbf: Path, out_dir: Path, borders: Path) -> None:
    import osmium

    regions = load_regions(borders)
    staging = out_dir / "_staging.sqlite"
    if staging.exists():
        staging.unlink()
    out_dir.mkdir(parents=True, exist_ok=True)
    stage = sqlite3.connect(staging)
    stage.execute("PRAGMA journal_mode=OFF")
    stage.execute("PRAGMA synchronous=OFF")
    stage.execute(
        """
        CREATE TABLE a (
          city_tag TEXT NOT NULL,
          street TEXT NOT NULL,
          street_key TEXT NOT NULL,
          house TEXT NOT NULL,
          lat REAL NOT NULL,
          lon REAL NOT NULL,
          region_id TEXT NOT NULL DEFAULT '',
          region_name TEXT NOT NULL DEFAULT '',
          city TEXT NOT NULL DEFAULT ''
        )
        """
    )
    stage.execute(
        "CREATE TABLE osm_places (name TEXT NOT NULL, kind TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL)"
    )

    class Handler(osmium.SimpleHandler):
        def __init__(self) -> None:
            super().__init__()
            self.batch: list[tuple] = []
            self.places: list[tuple] = []
            self.seen = 0
            self.kept = 0

        def flush(self) -> None:
            if self.batch:
                stage.executemany(
                    "INSERT INTO a(city_tag, street, street_key, house, lat, lon) VALUES (?,?,?,?,?,?)",
                    self.batch,
                )
                self.batch.clear()
            if self.places:
                stage.executemany(
                    "INSERT INTO osm_places(name, kind, lat, lon) VALUES (?,?,?,?)",
                    self.places,
                )
                self.places.clear()

        def _address(self, tags, lat: float, lon: float) -> None:
            house = norm_house(tags.get("addr:housenumber") or "")
            street = (tags.get("addr:street") or "").strip()
            key = street_key(street)
            if not house or not key:
                return
            city = clean_place(tags.get("addr:city") or tags.get("addr:place") or "")
            self.batch.append((city, street, key, house, lat, lon))
            self.kept += 1
            if len(self.batch) >= 5000:
                self.flush()
            if self.kept % 200000 == 0:
                self.flush()
                stage.commit()
                print(f"  addresses {self.kept}", flush=True)

        def node(self, n):
            if not n.location.valid():
                return
            self.seen += 1
            tags = n.tags
            if "addr:housenumber" in tags:
                self._address(tags, n.location.lat, n.location.lon)
            kind = tags.get("place") or ""
            if kind in ("city", "town", "village") and tags.get("name"):
                name = clean_place(tags.get("name") or "")
                if name:
                    self.places.append((name, kind, n.location.lat, n.location.lon))

        def way(self, w):
            if "addr:housenumber" not in w.tags:
                return
            lats = []
            lons = []
            try:
                for nd in w.nodes:
                    if nd.location.valid():
                        lats.append(nd.location.lat)
                        lons.append(nd.location.lon)
            except Exception:
                return
            if not lats:
                return
            self._address(w.tags, sum(lats) / len(lats), sum(lons) / len(lons))

    print("reading", pbf, flush=True)
    handler = Handler()
    handler.apply_file(str(pbf), locations=True, idx="sparse_file_array")
    handler.flush()
    stage.commit()
    print(f"kept {handler.kept} places {stage.execute('select count(*) from osm_places').fetchone()[0]}", flush=True)

    grid: dict[tuple[int, int], list] = {}
    for name, kind, lat, lon in stage.execute("SELECT name, kind, lat, lon FROM osm_places"):
        grid.setdefault((int(lat / 0.25), int(lon / 0.25)), []).append((name, kind, lat, lon))
    towns = {norm_key(name) for (name,) in stage.execute("SELECT name FROM osm_places WHERE kind IN ('city','town')")}

    print("assign regions and cities", flush=True)
    rows = stage.execute("SELECT rowid, city_tag, lat, lon FROM a").fetchall()
    updates = []
    outside = 0
    for rowid, city_tag, lat, lon in rows:
        region = locate_region(lat, lon, regions)
        if not region:
            outside += 1
            continue
        city = city_tag or nearest_place(lat, lon, grid, {"city", "town"}, 18) or nearest_place(
            lat, lon, grid, {"village"}, 6
        ) or region[1]
        updates.append((region[0], region[1], city, rowid))
        if len(updates) >= 4000:
            stage.executemany(
                "UPDATE a SET region_id=?, region_name=?, city=? WHERE rowid=?",
                updates,
            )
            updates.clear()
    if updates:
        stage.executemany(
            "UPDATE a SET region_id=?, region_name=?, city=? WHERE rowid=?",
            updates,
        )
    stage.commit()
    print(f"outside SFO {outside}", flush=True)
    stage.execute("DELETE FROM a WHERE region_id=''")
    stage.execute("CREATE INDEX idx_a_region_city ON a(region_id, city)")
    stage.commit()

    catalog = []
    for region in regions:
        rid, rname = region["id"], region["title"]
        stats = stage.execute(
            "SELECT COUNT(*), MIN(lat), MAX(lat), MIN(lon), MAX(lon) FROM a WHERE region_id=?",
            (rid,),
        ).fetchone()
        count = int(stats[0] or 0)
        print(f"region {rname} {count}", flush=True)
        if count == 0:
            continue
        lat, lon, radius = km_radius(stats[1], stats[3], stats[2], stats[4])
        rel = f"regions/{rid}.sqlite"
        pack_rows = stage.execute(
            "SELECT city, street, street_key, house, lat, lon FROM a WHERE region_id=?",
            (rid,),
        ).fetchall()
        write_pack(out_dir / rel, pack_rows, rname, [("pack_id", rid), ("kind", "region"), ("source", "osm-pbf-sfo")])
        catalog.append(
            {
                "id": f"region-{rid}",
                "kind": "region",
                "name": rname,
                "region": rname,
                "file": rel,
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "radius_km": round(min(max(radius, 80.0), 1600.0), 1),
                "count": count,
            }
        )
        for city, ccount, min_lat, max_lat, min_lon, max_lon in stage.execute(
            "SELECT city, COUNT(*), MIN(lat), MAX(lat), MIN(lon), MAX(lon) FROM a WHERE region_id=? GROUP BY city",
            (rid,),
        ):
            ccount = int(ccount)
            is_town = norm_key(city) in towns
            if ccount < 3 or (not is_town and ccount < 40):
                continue
            if city == rname:
                continue
            clat, clon, cradius = km_radius(min_lat, min_lon, max_lat, max_lon)
            cradius = min(80.0, max(12.0, cradius))
            city_slug = slug(city)
            rel_city = f"cities/{rid}/{city_slug}.sqlite"
            dest = out_dir / rel_city
            place_id = f"city-{rid}-{city_slug}"
            if dest.exists():
                rel_city = f"cities/{rid}/{city_slug}-{ccount}.sqlite"
                dest = out_dir / rel_city
                place_id = f"{place_id}-{ccount}"
            city_rows = stage.execute(
                "SELECT city, street, street_key, house, lat, lon FROM a WHERE region_id=? AND city=?",
                (rid, city),
            ).fetchall()
            write_pack(
                dest,
                city_rows,
                city,
                [("pack_id", place_id), ("kind", "city"), ("region", rname), ("source", "osm-pbf-sfo")],
            )
            catalog.append(
                {
                    "id": place_id,
                    "kind": "city",
                    "name": city,
                    "region": rname,
                    "file": rel_city,
                    "lat": round(clat, 5),
                    "lon": round(clon, 5),
                    "radius_km": round(cradius, 1),
                    "count": ccount,
                }
            )

    catalog.sort(key=lambda item: (0 if item["kind"] == "region" else 1, -item["count"], item["name"]))
    (out_dir / "catalog.json").write_text(json.dumps({"places": catalog}, ensure_ascii=False), encoding="utf-8")
    stage.close()
    staging.unlink(missing_ok=True)
    print(f"catalog {len(catalog)}", flush=True)


def main() -> None:
    if len(sys.argv) < 3:
        print("usage: build-sfo-addresses.py <file.osm.pbf> <out-dir> [borders.geojson]")
        sys.exit(2)
    borders = Path(sys.argv[3]) if len(sys.argv) > 3 else Path(__file__).with_name("sfo-regions.geojson")
    extract(Path(sys.argv[1]), Path(sys.argv[2]), borders)


if __name__ == "__main__":
    main()
