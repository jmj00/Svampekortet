"""Ingest a Denmark-wide biotope grid (forest type + soil type) into a
`biotope_grid` table -- the site-characteristic covariates behind
`pipeline.model.biotope` (see docs/adr/0016).

    python -m pipeline.ingest.biotope

Two independent, no-auth sources, both confirmed working from this sandbox:

- **Forest type** (broadleaf / coniferous / mixed): CORINE Land Cover 2018,
  EU/Copernicus, via EEA's public ArcGIS REST service. Coarse (25 ha minimum
  mapping unit) but free and needs no credentials.
- **Soil type**: GEUS Jordartskort 1:200,000 (surface geology), also a public
  ArcGIS REST service, also no auth -- a different GEUS-hosted service from
  Datafordeler entirely, unrelated to the DATAFORDELER_* credentials used
  elsewhere in this pipeline.

Both are bulk-pulled once (a few thousand polygons each, nationally) with real
polygon geometry, loaded into an in-process DuckDB with the `spatial`
extension, and spatial-joined against a uniform ~2 km grid
(`GRID_DEG`, the same "round to a grid, dict-key it" idiom as
`pipeline.model.habitat`'s `DENSITY_GRID_DEG`) covering `DENMARK_BBOX`. Only
grid cells that actually landed inside a classified polygon are kept -- most
of a bounding-box-shaped grid is sea or otherwise unclassified, and there is
nothing useful to say about those cells anyway (the model treats "no
classification" as neutral, not as evidence of anything).

This does not belong in the weekly `pipeline.build` run, for the same reason
`pipeline.ingest.geodanmark`/`stednavne` don't: land cover and surface geology
change on a geological, not weekly, timescale. Run it by hand when needed.
"""

from __future__ import annotations

import argparse
import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

import duckdb

from pipeline.config import DENMARK_BBOX, DUCKDB_PATH
from pipeline.model.biotope import GRID_DEG

CORINE_URL = (
    "https://image.discomap.eea.europa.eu/arcgis/rest/services/Corine/CLC2018_WM/MapServer/0/query"
)
GEUS_URL = "https://data.geus.dk/arcgis/rest/services/Denmark/Jordartskort_200000/MapServer/1/query"
USER_AGENT = "svampekortet/0.1 (+https://github.com/jmj00/Svampekortet)"

CORINE_FOREST_CODES = {"311": "broadleaf", "312": "coniferous", "313": "mixed"}


def _to_web_mercator(lon: float, lat: float) -> tuple[float, float]:
    """Denmark bbox in EPSG:3857 (CORINE's native SR), from DENMARK_BBOX
    (WGS84) via the standard spherical Web Mercator formula."""
    r = 6378137.0
    x = math.radians(lon) * r
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * r
    return x, y


_CREATE = """
CREATE TABLE IF NOT EXISTS biotope_grid (
    lon         DOUBLE NOT NULL,
    lat         DOUBLE NOT NULL,
    forest_type TEXT,
    soil_tsym   TEXT
)
"""


def _fetch_arcgis_geojson(
    url: str, extra_params: dict, *, page_size: int, min_page_size: int = 50
) -> list[dict]:
    """Paginate an ArcGIS REST `query` endpoint as GeoJSON, halving the page
    on a server error (observed on CORINE for one oversized geometry) instead
    of failing the whole pull."""

    def fetch_page(offset: int, count: int) -> list[dict]:
        params = {
            **extra_params,
            "returnGeometry": "true",
            "f": "geojson",
            "resultOffset": str(offset),
            "resultRecordCount": str(count),
        }
        req = urllib.request.Request(
            f"{url}?{urllib.parse.urlencode(params)}", headers={"User-Agent": USER_AGENT}
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:  # noqa: S310
                return json.loads(resp.read().decode("utf-8")).get("features", [])
        except Exception:  # noqa: BLE001
            if count <= min_page_size:
                raise
            half = count // 2
            return fetch_page(offset, half) + fetch_page(offset + half, half)

    features: list[dict] = []
    offset = 0
    while True:
        page = fetch_page(offset, page_size)
        features.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return features


def _load_polygons(con: duckdb.DuckDBPyConnection, table: str, features: list[dict]) -> None:
    con.execute(f"CREATE TABLE {table} (label TEXT, geom GEOMETRY)")
    for f in features:
        label = f["_label"]
        geom = f["geometry"]
        rings = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
        for coords in rings:
            con.execute(
                f"INSERT INTO {table} VALUES (?, ST_GeomFromGeoJSON(?))",
                [label, json.dumps({"type": "Polygon", "coordinates": coords})],
            )
    # A plain nested-loop ST_Contains join against ~10-25k polygons times a
    # national grid never finishes in practice -- confirmed on a real run.
    # An R-tree index turns it into a bounding-box-filtered join instead.
    con.execute(f"CREATE INDEX {table}_idx ON {table} USING RTREE (geom)")


def _grid_points(bbox: tuple[float, float, float, float]) -> list[tuple[float, float]]:
    min_lon, min_lat, max_lon, max_lat = bbox
    points = []
    lat = min_lat
    while lat <= max_lat:
        lon = min_lon
        while lon <= max_lon:
            points.append((lon, lat))
            lon += GRID_DEG
        lat += GRID_DEG
    return points


def run(db_path: str | Path = DUCKDB_PATH) -> dict:
    minx, miny = _to_web_mercator(DENMARK_BBOX[0], DENMARK_BBOX[1])
    maxx, maxy = _to_web_mercator(DENMARK_BBOX[2], DENMARK_BBOX[3])
    corine_features = _fetch_arcgis_geojson(
        CORINE_URL,
        {
            "geometry": f"{minx},{miny},{maxx},{maxy}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": "102100",
            "spatialRel": "esriSpatialRelIntersects",
            "where": "Code_18 IN ('311','312','313')",
            "outFields": "Code_18",
        },
        page_size=1000,
    )
    for f in corine_features:
        f["_label"] = CORINE_FOREST_CODES[f["properties"]["Code_18"]]

    geus_features = _fetch_arcgis_geojson(
        GEUS_URL, {"where": "1=1", "outFields": "tsym", "outSR": "4326"}, page_size=2000
    )
    for f in geus_features:
        f["_label"] = f["properties"].get("tsym") or f["properties"].get("TSYM")

    print(f"fetched {len(corine_features)} forest + {len(geus_features)} soil polygons")
    con = duckdb.connect(":memory:")
    con.execute("INSTALL spatial")
    con.execute("LOAD spatial")
    _load_polygons(con, "forest_polygons", corine_features)
    _load_polygons(con, "soil_polygons", geus_features)

    grid = _grid_points(DENMARK_BBOX)
    con.execute("CREATE TABLE grid_candidates (lon DOUBLE, lat DOUBLE)")
    con.executemany("INSERT INTO grid_candidates VALUES (?, ?)", grid)
    print(f"spatial-joining {len(grid)} grid candidates...")

    classified = con.execute(
        """
        SELECT g.lon, g.lat, f.label AS forest_type, s.label AS soil_tsym
        FROM grid_candidates g
        LEFT JOIN forest_polygons f ON ST_Contains(f.geom, ST_Point(g.lon, g.lat))
        LEFT JOIN soil_polygons s ON ST_Contains(s.geom, ST_Point(g.lon, g.lat))
        WHERE f.label IS NOT NULL OR s.label IS NOT NULL
        """
    ).fetchall()

    out_path = Path(db_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_con = duckdb.connect(str(out_path))
    try:
        out_con.execute("DROP TABLE IF EXISTS biotope_grid")
        out_con.execute(_CREATE)
        out_con.executemany("INSERT INTO biotope_grid VALUES (?, ?, ?, ?)", classified)
    finally:
        out_con.close()

    return {
        "step": "biotope",
        "grid_candidates": len(grid),
        "forest_polygons": len(corine_features),
        "soil_polygons": len(geus_features),
        "classified_cells": len(classified),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch and classify the Denmark-wide biotope grid (forest + soil type)."
    )
    parser.add_argument("--db", type=Path, default=DUCKDB_PATH)
    args = parser.parse_args()
    print(json.dumps(run(args.db), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
