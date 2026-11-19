"""Ingest named forest areas from Danske Stednavne into a `named_forests` table.

    python -m pipeline.ingest.stednavne

Reads DATAFORDELER_CLIENT_ID / DATAFORDELER_CLIENT_SECRET (see
pipeline.datafordeler / .env.example) and pulls every `sn:Naturareal` feature
with `naturarealtype = 'skovPlantage'` (forest/plantation -- the other values
seen in a Denmark-wide sample are moseSump, agerMark, parkAnlaeg, eng, hede;
none of those are forest) from Datafordeler's Stednavne WFS. Unlike GeoDanmark
Vektor's WFS (pipeline.ingest.geodanmark, down as of 2026-09), this one works,
and gives named polygons directly -- no point-grid workaround needed. Each
polygon's name (`navn_1.skrivemaade`) and area are kept alongside a point that
lies inside the forest (its centroid, or see
`pipeline.forest_outlines.point_on_surface` when the centroid falls outside a
crescent-shaped forest), in WGS84 (this service's `EPSG:4326` responses use
**lat, lon** axis order per the EPSG registry -- the opposite of GeoJSON/this
codebase's `[lon, lat]` convention, so every coordinate pair is swapped on the
way in).

The polygon itself is kept too, simplified, in `named_forest_outlines`
(docs/adr/0020-forest-outlines-for-the-pin.md): the web app uses it to tell
whether a pin is inside a forest and to draw the forest on the map. Every
`gml:Polygon` of a feature is read with its exterior and any interior rings;
the service's simple-feature profile has so far returned exactly one polygon
with one exterior ring per feature, but nothing here depends on that.

Like `pipeline.ingest.geodanmark`, this does not belong in the weekly
`pipeline.build` run: Danske Stednavne has not been updated since 2025-09 (a
standing data freeze, not specific to this run), so there is nothing new to
fetch on a weekly cadence. Run it by hand when needed. `--raw-dir` keeps the
WFS pages on disk and reuses them on the next run, so the parsing can be
changed and re-run without the network.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path

import duckdb

from pipeline.config import DUCKDB_PATH
from pipeline.datafordeler import USER_AGENT, get_token
from pipeline.duckload import copy_rows
from pipeline.forest_outlines import (
    Outline,
    Ring,
    clear_inside_point,
    close_ring,
    outline_bbox,
    point_in_outline,
    point_is_sound,
    point_on_surface,
    polygon_centroid,
    published_point,
    ring_area_m2,
    simplify_outline,
)

WFS_URL = "https://wfs.datafordeler.dk/Stednavn/STEDNAVNE_BEARBEJDET_GML3SFP/1/WFS"
FOREST_TYPE = "skovPlantage"
PAGE_SIZE = 1000

_CREATE = """
CREATE TABLE IF NOT EXISTS named_forests (
    sted_id  TEXT NOT NULL,
    name     TEXT NOT NULL,
    lon      DOUBLE NOT NULL,
    lat      DOUBLE NOT NULL,
    area_m2  DOUBLE
)
"""

# One row per forest that has a usable polygon; `outline` is JSON: a list of
# polygons, each a list of rings (outer first, then holes), each ring a closed
# list of [lon, lat] pairs, simplified and rounded for publishing.
_CREATE_OUTLINES = """
CREATE TABLE IF NOT EXISTS named_forest_outlines (
    sted_id  TEXT NOT NULL,
    outline  TEXT NOT NULL
)
"""

# The GML is namespaced and not huge per page; a couple of targeted regexes are
# far less code than pulling in an XML-aware GML parser for one feature shape.
_MEMBER_RE = re.compile(r"<sn:Naturareal\b.*?</sn:Naturareal>", re.DOTALL)
_ID_RE = re.compile(r"<sn:id\.lokalId>([^<]+)</sn:id\.lokalId>")
_NAME_RE = re.compile(r"<sn:navn_1\.skrivemaade>([^<]+)</sn:navn_1\.skrivemaade>")
_AREA_RE = re.compile(r'<sn:areal gml:uom="[^"]*">([^<]+)</sn:areal>')
_POSLIST_RE = re.compile(r"<gml:posList[^>]*>([^<]+)</gml:posList>")
_POLYGON_RE = re.compile(r"<gml:Polygon\b.*?</gml:Polygon>", re.DOTALL)
_EXTERIOR_RE = re.compile(r"<gml:exterior>.*?</gml:exterior>", re.DOTALL)
_INTERIOR_RE = re.compile(r"<gml:interior>.*?</gml:interior>", re.DOTALL)

ForestRow = tuple[str, str, float, float, float | None, Outline]


def _ring(pos_list: str) -> Ring | None:
    """A GML `posList` of **lat lon** pairs as a closed ring of (lon, lat), or
    None when it holds fewer than three corners."""
    values = [float(v) for v in pos_list.split()]
    if len(values) < 6:
        return None
    # swap (lat, lon) -> (lon, lat)
    return close_ring([(values[i + 1], values[i]) for i in range(0, len(values) - 1, 2)])


def _centroid(pos_list: str) -> tuple[float, float] | None:
    """Polygon centroid (area-weighted, shoelace formula) from a GML `posList`
    of **lat lon** pairs, returned as (lon, lat)."""
    ring = _ring(pos_list)
    return polygon_centroid(ring) if ring else None


def _polygons(member: str) -> Outline:
    """Every polygon of a feature as [outer ring, *holes], in (lon, lat)."""
    polygons: Outline = []
    for block in _POLYGON_RE.findall(member):
        exterior = _EXTERIOR_RE.search(block)
        outer_match = _POSLIST_RE.search(exterior.group(0)) if exterior else None
        outer = _ring(outer_match.group(1)) if outer_match else None
        if outer is None:
            continue
        rings = [outer]
        for interior in _INTERIOR_RE.findall(block):
            hole_match = _POSLIST_RE.search(interior)
            hole = _ring(hole_match.group(1)) if hole_match else None
            if hole is not None:
                rings.append(hole)
        polygons.append(rings)
    return polygons


def _parse_page(xml_text: str) -> tuple[int, list[ForestRow]]:
    """Returns (raw member count, parsed rows) -- kept separate because a member
    missing a name/geometry is dropped from `rows` but still consumed a slot in
    the page, and pagination must stop on the *raw* count or it can under-read
    a page that has any unparseable members and silently truncate the pull.

    A row is (sted_id, name, lon, lat, area_m2, outline): `lon`/`lat` a point
    inside the forest, `outline` its simplified polygons (empty when the
    geometry is degenerate; the point is then the plain centroid)."""
    members = _MEMBER_RE.findall(xml_text)
    rows: list[ForestRow] = []
    for member in members:
        id_match = _ID_RE.search(member)
        name_match = _NAME_RE.search(member)
        if not id_match or not name_match:
            continue
        polygons = _polygons(member)
        if not polygons:
            continue
        outline = simplify_outline(polygons)
        # The inside point is taken from what is published, so the pin the app
        # puts "on" a forest lies inside the outline the app tests it against.
        point = point_on_surface(outline) or polygon_centroid(polygons[0][0])
        lon, lat = point
        area_match = _AREA_RE.search(member)
        area = float(area_match.group(1)) if area_match else None
        rows.append((id_match.group(1), name_match.group(1), lon, lat, area, outline))
    return len(members), rows


def _fetch_page(token: str, start_index: int) -> str:
    params = {
        "service": "WFS",
        "request": "GetFeature",
        "version": "2.0.0",
        "typenames": "sn:Naturareal",
        "srsname": "urn:ogc:def:crs:EPSG::4326",
        "cql_filter": f"naturarealtype='{FOREST_TYPE}'",
        "count": str(PAGE_SIZE),
        "startindex": str(start_index),
    }
    url = f"{WFS_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
        return resp.read().decode("utf-8")


def settle_points(seen: dict[str, tuple[str, float, float, float | None, Outline]]) -> dict:
    """Give every forest a point that is its own, in place in `seen`.

    A forest's point is where the app puts the pin when the forest is chosen
    by name, and the app then names the *smallest* forest the pin is in. So
    the point must lie inside the forest's outline as published (rounded),
    clear of its edge, and -- where the forest has room -- outside every
    smaller named forest lying in it (Gribskov holds a dozen named parts; its
    centroid is in one of them). Points that already are all that are only
    rounded; the others are moved (`clear_inside_point`).

    Returns counts for the run report; `points_in_smaller_forest` is how many
    forests are left with a point inside a smaller one because no part of
    them is free of smaller forests.
    """
    areas: dict[str, float] = {}
    boxes: dict[str, tuple[float, float, float, float]] = {}
    cells: dict[tuple[int, int], list[str]] = {}
    cell = 0.1  # degrees; a forest is listed in every cell its box touches
    for sted_id, (_name, _lon, _lat, area, outline) in seen.items():
        if not outline:
            continue
        areas[sted_id] = area if area else sum(ring_area_m2(p[0]) for p in outline)
        box = outline_bbox(outline)
        boxes[sted_id] = box
        for cx in range(int(box[0] // cell), int(box[2] // cell) + 1):
            for cy in range(int(box[1] // cell), int(box[3] // cell) + 1):
                cells.setdefault((cx, cy), []).append(sted_id)

    moved = 0
    left_in_smaller = 0
    for sted_id, (name, lon, lat, area, outline) in list(seen.items()):
        if not outline:
            continue
        west, south, east, north = boxes[sted_id]
        near = {
            other
            for cx in range(int(west // cell), int(east // cell) + 1)
            for cy in range(int(south // cell), int(north // cell) + 1)
            for other in cells.get((cx, cy), [])
        }
        smaller = [
            seen[other][4]
            for other in sorted(near)
            if other != sted_id
            and areas[other] < areas[sted_id]
            and boxes[other][0] <= east
            and boxes[other][2] >= west
            and boxes[other][1] <= north
            and boxes[other][3] >= south
        ]
        if point_is_sound(lon, lat, outline, smaller):
            point = published_point(lon, lat)
        else:
            point = (
                clear_inside_point(outline, smaller)
                or clear_inside_point(outline, [])
                or published_point(lon, lat)
            )
            moved += 1
            if any(point_in_outline(point[0], point[1], other) for other in smaller):
                left_in_smaller += 1
        seen[sted_id] = (name, point[0], point[1], area, outline)
    return {"points_moved": moved, "points_in_smaller_forest": left_in_smaller}


def _page_path(raw_dir: Path, start_index: int) -> Path:
    return raw_dir / f"page-{start_index:05d}.xml"


def run(
    db_path: str | Path = DUCKDB_PATH,
    *,
    client_id: str | None = None,
    client_secret: str | None = None,
    raw_dir: str | Path | None = None,
) -> dict:
    """Pull (or, with `raw_dir`, reuse cached) WFS pages and rebuild the two
    forest tables. With `raw_dir`, a page already on disk is read from there
    and a fetched page is written there; credentials are only needed for
    pages that are not cached."""
    raw_dir = Path(raw_dir) if raw_dir is not None else None
    client_id = client_id or os.environ.get("DATAFORDELER_CLIENT_ID")
    client_secret = client_secret or os.environ.get("DATAFORDELER_CLIENT_SECRET")
    have_credentials = bool(client_id and client_secret)
    first_cached = raw_dir is not None and _page_path(raw_dir, 0).exists()
    if not have_credentials and not first_cached:
        return {"step": "stednavne", "skipped": "no Datafordeler credentials"}

    token: str | None = None

    def page(start_index: int) -> str:
        nonlocal token
        if raw_dir is not None and _page_path(raw_dir, start_index).exists():
            return _page_path(raw_dir, start_index).read_text(encoding="utf-8")
        if not have_credentials:
            raise SystemExit(
                f"page at index {start_index} is not cached and there are no credentials"
            )
        if token is None:
            token = get_token(client_id, client_secret)  # type: ignore[arg-type]
        text = _fetch_page(token, start_index)
        if raw_dir is not None:
            raw_dir.mkdir(parents=True, exist_ok=True)
            _page_path(raw_dir, start_index).write_text(text, encoding="utf-8")
        return text

    seen: dict[str, tuple[str, float, float, float | None, Outline]] = {}
    start_index = 0
    pages = 0
    total_members = 0
    while True:
        member_count, rows = _parse_page(page(start_index))
        pages += 1
        total_members += member_count
        for sted_id, name, lon, lat, area, outline in rows:
            seen[sted_id] = (name, lon, lat, area, outline)
        if member_count < PAGE_SIZE:
            break
        start_index += PAGE_SIZE

    points = settle_points(seen)

    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db_path))
    try:
        con.execute("DROP TABLE IF EXISTS named_forests")
        con.execute(_CREATE)
        db_rows = [
            (sted_id, name, lon, lat, area)
            for sted_id, (name, lon, lat, area, _outline) in seen.items()
        ]
        copy_rows(con, "named_forests", ["sted_id", "name", "lon", "lat", "area_m2"], db_rows)

        con.execute("DROP TABLE IF EXISTS named_forest_outlines")
        con.execute(_CREATE_OUTLINES)
        outline_rows = [
            (sted_id, json.dumps(outline, separators=(",", ":")))
            for sted_id, (_name, _lon, _lat, _area, outline) in seen.items()
            if outline
        ]
        copy_rows(con, "named_forest_outlines", ["sted_id", "outline"], outline_rows)
    finally:
        con.close()

    return {
        "step": "stednavne",
        "pages": pages,
        "raw_members": total_members,
        "named_forests": len(seen),
        "outlines": len(outline_rows),
        "outline_points": sum(
            len(ring) - 1
            for (_n, _lo, _la, _a, outline) in seen.values()
            for polygon in outline
            for ring in polygon
        ),
        "unparsed": total_members - len(seen),
        **points,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fetch named forest areas (skovPlantage) from Danske Stednavne."
    )
    parser.add_argument("--db", type=Path, default=DUCKDB_PATH)
    parser.add_argument(
        "--raw-dir",
        type=Path,
        default=None,
        help="keep the WFS pages here and reuse the ones already there",
    )
    args = parser.parse_args()
    print(json.dumps(run(args.db, raw_dir=args.raw_dir), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
