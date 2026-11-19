"""Ingest GeoDanmark forest (SKOV) polygons into a `forest_points` table.

    python -m pipeline.ingest.geodanmark

Reads DATAFORDELER_CLIENT_ID / DATAFORDELER_CLIENT_SECRET (an OAuth Shared
Secret from an IT-system in Datafordeler Administration -- see .env.example)
and exchanges them for a 60-minute bearer token. GeoDanmark Vektor's WFS is
currently down (503 on every path tried), so this queries its WMS instead: a
GetFeatureInfo point-probe over a grid of coordinates across Denmark, since a
raster GetMap + pixel-clustering approach would need an image library this
project deliberately doesn't depend on. Each hit is deduped by the polygon's
`gmlid` to one representative point (its bounding-box centre) -- callers don't
need the true polygon shape, only "roughly here, and it's forest".

This does not belong in the weekly `pipeline.build` run: GeoDanmark's aerial-
photo-based topography changes on a ~yearly cadence, not weekly, and a full run
is one HTTP request per grid point (~15-20k at the default spacing). Run it by
hand when the forest layer needs refreshing; `pipeline.publish.site` picks up
whatever is already in `forest_points` and no-ops if the table is missing.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import duckdb

from pipeline.config import DENMARK_BBOX, DUCKDB_PATH
from pipeline.datafordeler import USER_AGENT, get_token
from pipeline.duckload import copy_rows

WMS_URL = "https://wms.datafordeler.dk/GeoDanmarkVektor/GeoDanmark_60_NOHIST/1.0.0/WMS"
GML_NS = "{http://www.opengis.net/gml}"
EARTH_RADIUS_M = 6378137.0  # spherical Web Mercator, matches the basemap's EPSG:3857

DEFAULT_SPACING_KM = 1.5  # grid pitch; a compromise between coverage and request count
DEFAULT_WORKERS = 10  # polite concurrency for a government API of unknown rate limits
PROBE_HALF_M = 1.0  # tiny bbox around each grid point -- just enough for a 3x3px query

_CREATE = """
CREATE TABLE IF NOT EXISTS forest_points (
    gml_id  TEXT NOT NULL,
    lon     DOUBLE NOT NULL,
    lat     DOUBLE NOT NULL
)
"""


def _to_web_mercator(lon: float, lat: float) -> tuple[float, float]:
    x = math.radians(lon) * EARTH_RADIUS_M
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * EARTH_RADIUS_M
    return x, y


def _from_web_mercator(x: float, y: float) -> tuple[float, float]:
    lon = math.degrees(x / EARTH_RADIUS_M)
    lat = math.degrees(2 * math.atan(math.exp(y / EARTH_RADIUS_M)) - math.pi / 2)
    return lon, lat


def _grid_points(
    bbox: tuple[float, float, float, float], spacing_km: float
) -> list[tuple[float, float]]:
    min_lon, min_lat, max_lon, max_lat = bbox
    lat_step = spacing_km / 111.0
    points: list[tuple[float, float]] = []
    lat = min_lat
    while lat <= max_lat:
        lon_step = spacing_km / (111.320 * math.cos(math.radians(lat)))
        lon = min_lon
        while lon <= max_lon:
            points.append((lon, lat))
            lon += lon_step
        lat += lat_step
    return points


def _feature_info_url(lon: float, lat: float) -> str:
    x, y = _to_web_mercator(lon, lat)
    bbox = f"{x - PROBE_HALF_M},{y - PROBE_HALF_M},{x + PROBE_HALF_M},{y + PROBE_HALF_M}"
    params = {
        "service": "WMS",
        "version": "1.3.0",
        "request": "GetFeatureInfo",
        "layers": "SKOV",
        "styles": "",
        "query_layers": "SKOV",
        "crs": "EPSG:3857",
        "bbox": bbox,
        "width": "3",
        "height": "3",
        "i": "1",
        "j": "1",
        "info_format": "application/vnd.ogc.gml",
        "feature_count": "1",
    }
    return f"{WMS_URL}?{urllib.parse.urlencode(params)}"


def _parse_feature_info(xml_text: str) -> dict | None:
    root = ET.fromstring(xml_text)  # noqa: S314 -- our own server's response, not user input
    feature = root.find(".//SKOV_feature")
    if feature is None:
        return None
    gml_id = feature.findtext("gmlid") or feature.findtext("objectid")
    coords = feature.findtext(f".//{GML_NS}coordinates")
    if not gml_id or not coords:
        return None
    (x1, y1), (x2, y2) = (tuple(float(v) for v in pair.split(",")) for pair in coords.split(" "))
    lon, lat = _from_web_mercator((x1 + x2) / 2, (y1 + y2) / 2)
    return {"id": gml_id, "lon": lon, "lat": lat}


def _query_point(token: str, lon: float, lat: float, *, retries: int = 2) -> dict | None:
    url = _feature_info_url(lon, lat)
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                url, headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}
            )
            with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
                text = resp.read().decode("utf-8")
            return _parse_feature_info(text)
        except Exception as err:  # noqa: BLE001
            last_err = err
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"GetFeatureInfo failed for ({lon}, {lat}): {last_err}")


def run(
    db_path: str | Path = DUCKDB_PATH,
    *,
    bbox: tuple[float, float, float, float] = DENMARK_BBOX,
    spacing_km: float = DEFAULT_SPACING_KM,
    workers: int = DEFAULT_WORKERS,
    client_id: str | None = None,
    client_secret: str | None = None,
) -> dict:
    client_id = client_id or os.environ.get("DATAFORDELER_CLIENT_ID")
    client_secret = client_secret or os.environ.get("DATAFORDELER_CLIENT_SECRET")
    if not client_id or not client_secret:
        return {"step": "geodanmark", "skipped": "no Datafordeler credentials"}

    token = get_token(client_id, client_secret)
    grid = _grid_points(bbox, spacing_km)

    found: dict[str, tuple[float, float]] = {}
    errors = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(_query_point, token, lon, lat) for lon, lat in grid]
        for fut in as_completed(futures):
            try:
                result = fut.result()
            except Exception:  # noqa: BLE001
                errors += 1
                continue
            if result is not None and result["id"] not in found:
                found[result["id"]] = (result["lon"], result["lat"])

    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db_path))
    try:
        con.execute("DROP TABLE IF EXISTS forest_points")
        con.execute(_CREATE)
        rows = [(gml_id, lon, lat) for gml_id, (lon, lat) in found.items()]
        copy_rows(con, "forest_points", ["gml_id", "lon", "lat"], rows)
    finally:
        con.close()

    return {
        "step": "geodanmark",
        "grid_points": len(grid),
        "forest_points": len(found),
        "errors": errors,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch GeoDanmark SKOV (forest) polygons via point-grid GetFeatureInfo."
    )
    parser.add_argument("--db", type=Path, default=DUCKDB_PATH)
    parser.add_argument("--spacing-km", type=float, default=DEFAULT_SPACING_KM)
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    args = parser.parse_args()
    result = run(args.db, spacing_km=args.spacing_km, workers=args.workers)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
