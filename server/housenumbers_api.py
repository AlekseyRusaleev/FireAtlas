#!/usr/bin/env python3
"""House numbers for FireAtlas map labels — reads from local Nominatim DB."""

from __future__ import annotations

import json
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = 8089
CONTAINER = "fireatlas-nominatim-sfo"
MAX_LIMIT = 1200
FLOAT_RE = re.compile(r"^-?\d+(?:\.\d+)?$")


def parse_float(value: str | None, name: str) -> float:
    if value is None or not FLOAT_RE.match(value):
        raise ValueError(f"invalid {name}")
    return float(value)


def fetch_labels(south: float, west: float, north: float, east: float, limit: int) -> list[dict]:
    if south >= north or west >= east:
        raise ValueError("invalid bbox")
    # Keep bbox sane (city-scale viewport)
    if (north - south) > 0.5 or (east - west) > 0.5:
        raise ValueError("bbox too large")

    sql = (
        "SELECT housenumber, ST_Y(centroid), ST_X(centroid) "
        "FROM placex "
        "WHERE housenumber IS NOT NULL AND btrim(housenumber) <> '' "
        f"AND centroid && ST_MakeEnvelope({west}, {south}, {east}, {north}, 4326) "
        f"LIMIT {limit};"
    )
    result = subprocess.run(
        [
            "docker",
            "exec",
            CONTAINER,
            "sudo",
            "-u",
            "nominatim",
            "psql",
            "-d",
            "nominatim",
            "-t",
            "-A",
            "-F",
            "\t",
            "-c",
            sql,
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "psql failed")

    out: list[dict] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        number, lat_s, lon_s = parts
        try:
            lat = float(lat_s)
            lon = float(lon_s)
        except ValueError:
            continue
        out.append({"number": number.strip(), "lat": lat, "lon": lon})
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # quieter
        pass

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") != "/housenumbers":
            self.send_response(404)
            self._cors()
            self.end_headers()
            return

        qs = parse_qs(parsed.query)
        try:
            south = parse_float((qs.get("south") or [None])[0], "south")
            west = parse_float((qs.get("west") or [None])[0], "west")
            north = parse_float((qs.get("north") or [None])[0], "north")
            east = parse_float((qs.get("east") or [None])[0], "east")
            limit_raw = (qs.get("limit") or ["700"])[0]
            if not limit_raw.isdigit():
                raise ValueError("invalid limit")
            limit = max(1, min(MAX_LIMIT, int(limit_raw)))
            labels = fetch_labels(south, west, north, east, limit)
            body = json.dumps({"labels": labels}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except ValueError as exc:
            body = json.dumps({"error": str(exc)}).encode("utf-8")
            self.send_response(400)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:  # noqa: BLE001
            body = json.dumps({"error": str(exc)}).encode("utf-8")
            self.send_response(500)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"housenumbers api on http://{HOST}:{PORT}/housenumbers", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
