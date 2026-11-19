"""Named-forest outlines: geometry helpers, the Stednavne parser, and what is published."""

from __future__ import annotations

import json
import math
from pathlib import Path

import duckdb
import pytest

from pipeline.config import REPO_ROOT
from pipeline.forest_outlines import (
    COORD_SCALE,
    MIN_HOLE_AREA_M2,
    clear_inside_point,
    close_ring,
    decode_ring,
    distance_to_outline_m,
    encode_ring,
    point_in_outline,
    point_in_ring,
    point_is_sound,
    point_on_surface,
    ring_area_m2,
    ring_is_simple,
    simplify_outline,
    simplify_ring,
)
from pipeline.ingest import stednavne
from pipeline.publish.site import forest_outlines_payload, run_forests_only, write_forests

# About 1 km x 1 km at 56 N: 0.016 degrees of longitude, 0.009 of latitude.
SQUARE = [(10.0, 56.0), (10.016, 56.0), (10.016, 56.009), (10.0, 56.009), (10.0, 56.0)]


def _circle(lon: float, lat: float, radius_m: float, n: int = 240) -> list[tuple[float, float]]:
    kx = 111_320.0 * math.cos(math.radians(lat))
    ring = [
        (
            lon + radius_m * math.cos(2 * math.pi * i / n) / kx,
            lat + radius_m * math.sin(2 * math.pi * i / n) / 110_540.0,
        )
        for i in range(n)
    ]
    return close_ring(ring)


# --------------------------------------------------------------------------- #
# geometry
# --------------------------------------------------------------------------- #
def test_ring_area_is_in_square_metres():
    assert ring_area_m2(SQUARE) == pytest.approx(1_000_000, rel=0.02)
    assert ring_area_m2(SQUARE[:3]) == 0.0  # not a closed polygon


def test_point_in_ring_and_holes():
    assert point_in_ring(10.008, 56.0045, SQUARE)
    assert not point_in_ring(10.02, 56.0045, SQUARE)
    hole = [
        (10.006, 56.003),
        (10.010, 56.003),
        (10.010, 56.006),
        (10.006, 56.006),
        (10.006, 56.003),
    ]
    assert not point_in_outline(10.008, 56.0045, [[SQUARE, hole]])  # in the hole
    assert point_in_outline(10.002, 56.001, [[SQUARE, hole]])  # in the forest proper


def test_simplify_drops_points_within_tolerance_and_keeps_the_shape():
    circle = _circle(10.0, 56.0, 800.0)
    simplified = simplify_ring(circle, 25.0)
    assert simplified is not None
    assert len(simplified) < len(circle) / 4
    assert simplified[0] == simplified[-1]
    assert ring_is_simple(simplified)
    # A 25 m tolerance on an 800 m circle costs at most a few per cent of area.
    assert ring_area_m2(simplified) == pytest.approx(ring_area_m2(circle), rel=0.06)
    # published precision
    assert all(round(lon, 5) == lon and round(lat, 5) == lat for lon, lat in simplified)


def test_simplify_keeps_corners_and_rejects_degenerate_rings():
    assert simplify_ring(SQUARE) == SQUARE
    assert simplify_ring([(10.0, 56.0), (10.001, 56.0), (10.0, 56.0)]) is None  # a line
    assert simplify_ring([(10.0, 56.0)] * 5) is None  # a point


def test_simplify_never_publishes_a_self_crossing_ring():
    # A thin hairpin whose two arms lie closer together than the tolerance:
    # naive Douglas-Peucker folds one arm across the other.
    kx = 111_320.0 * math.cos(math.radians(56.0))
    ky = 110_540.0

    def at(x_m: float, y_m: float) -> tuple[float, float]:
        return (10.0 + x_m / kx, 56.0 + y_m / ky)

    ring = close_ring(
        [at(0, 0), at(600, 0), at(600, 300), at(20, 300), at(20, 290), at(580, 290)]
        + [at(580, 10 + 20 * math.sin(i)) for i in range(1, 6)]
        + [at(0, 12)]
    )
    simplified = simplify_ring(ring, 25.0)
    assert simplified is None or ring_is_simple(simplified)


def test_ring_is_simple_spots_a_bow_tie():
    bow_tie = [(0.0, 0.0), (1.0, 1.0), (1.0, 0.0), (0.0, 1.0), (0.0, 0.0)]
    assert not ring_is_simple(bow_tie)
    assert ring_is_simple(SQUARE)
    assert not ring_is_simple(SQUARE[:-1])  # not closed


def test_simplify_outline_drops_small_holes_and_bad_parts():
    small_hole = _circle(10.008, 56.0045, 40.0)  # ~0.5 ha
    big_hole = _circle(10.008, 56.0045, 150.0)  # ~7 ha
    assert ring_area_m2(small_hole) < MIN_HOLE_AREA_M2 < ring_area_m2(big_hole)
    assert len(simplify_outline([[SQUARE, small_hole]])[0]) == 1
    assert len(simplify_outline([[SQUARE, big_hole]])[0]) == 2
    line = [(10.0, 56.0), (10.001, 56.0), (10.0, 56.0)]
    assert simplify_outline([[line], [SQUARE]]) == [[SQUARE]]


def test_point_on_surface_is_inside_even_for_a_crescent():
    assert point_on_surface([[SQUARE]]) == pytest.approx((10.008, 56.0045), abs=1e-6)
    # A "C": the centroid lies in the open middle, outside the forest.
    c_shape = [
        (10.0, 56.0),
        (10.03, 56.0),
        (10.03, 56.004),
        (10.006, 56.004),
        (10.006, 56.016),
        (10.03, 56.016),
        (10.03, 56.02),
        (10.0, 56.02),
        (10.0, 56.0),
    ]
    lon, lat = point_on_surface([[c_shape]])
    assert point_in_outline(lon, lat, [[c_shape]])
    assert point_on_surface([]) is None


def test_point_on_surface_avoids_a_hole_over_the_centroid():
    hole = _circle(10.008, 56.0045, 200.0)
    lon, lat = point_on_surface([[SQUARE, hole]])
    assert point_in_outline(lon, lat, [[SQUARE, hole]])


def test_encode_ring_round_trips_and_is_delta_coded():
    encoded = encode_ring(SQUARE)
    assert encoded[:2] == [10 * COORD_SCALE, 56 * COORD_SCALE]
    assert encoded[2:4] == [1600, 0]  # 0.016 degrees east, in 1e-5 degrees
    assert len(encoded) == 2 * (len(SQUARE) - 1)  # the closing point is left out
    assert decode_ring(encoded) == SQUARE


# --------------------------------------------------------------------------- #
# the Stednavne parser
# --------------------------------------------------------------------------- #
def _member(sted_id: str, name: str, polygons: str, area: float | None = 1_000_000.0) -> str:
    area_xml = (
        f'<sn:areal gml:uom="http://qudt.org/vocab/unit#SquareMeter">{area}</sn:areal>'
        if area is not None
        else ""
    )
    return (
        f'<sn:Naturareal gml:id="sn.{sted_id}">'
        f"<sn:id.lokalId>{sted_id}</sn:id.lokalId>"
        f"<sn:navn_1.skrivemaade>{name}</sn:navn_1.skrivemaade>"
        f"{area_xml}<sn:geometri>{polygons}</sn:geometri>"
        "<sn:naturarealtype>skovPlantage</sn:naturarealtype></sn:Naturareal>"
    )


def _pos_list(ring: list[tuple[float, float]]) -> str:
    """GML as the service sends it: **lat lon** pairs."""
    return " ".join(f"{lat} {lon}" for lon, lat in ring)


def _polygon(outer: list[tuple[float, float]], *holes: list[tuple[float, float]]) -> str:
    interiors = "".join(
        f"<gml:interior><gml:LinearRing><gml:posList>{_pos_list(h)}</gml:posList>"
        "</gml:LinearRing></gml:interior>"
        for h in holes
    )
    return (
        '<gml:Polygon srsDimension="2" srsName="urn:ogc:def:crs:EPSG::4326"><gml:exterior>'
        f"<gml:LinearRing><gml:posList>{_pos_list(outer)}</gml:posList></gml:LinearRing>"
        f"</gml:exterior>{interiors}</gml:Polygon>"
    )


def test_parse_page_swaps_the_axis_order():
    page = _member("a", "Storskov", _polygon(SQUARE))
    count, rows = stednavne._parse_page(page)
    assert count == 1
    sted_id, name, lon, lat, area, outline = rows[0]
    assert (sted_id, name, area) == ("a", "Storskov", 1_000_000.0)
    # Denmark: longitude about 10, latitude about 56 -- not the other way round.
    assert lon == pytest.approx(10.008, abs=1e-4)
    assert lat == pytest.approx(56.0045, abs=1e-4)
    assert outline == [[SQUARE]]
    assert all(8 < x < 16 and 54 < y < 58 for x, y in outline[0][0])


def test_parse_page_reads_holes_and_every_part():
    hole = _circle(10.008, 56.0045, 150.0)
    island = [(10.03, 56.0), (10.04, 56.0), (10.04, 56.005), (10.03, 56.005), (10.03, 56.0)]
    page = _member("b", "Todelt Skov", _polygon(SQUARE, hole) + _polygon(island))
    _count, rows = stednavne._parse_page(page)
    outline = rows[0][5]
    assert len(outline) == 2  # two parts
    assert len(outline[0]) == 2  # the first has its hole
    assert outline[1] == [island]
    # the inside point is in the forest, not in the hole that covers its centroid
    assert point_in_outline(rows[0][2], rows[0][3], outline)


def test_parse_page_counts_members_it_cannot_use():
    nameless = _member("c", "x", _polygon(SQUARE)).replace(
        "<sn:navn_1.skrivemaade>x</sn:navn_1.skrivemaade>", ""
    )
    no_geometry = _member("d", "Uden Flade", "")
    count, rows = stednavne._parse_page(
        nameless + no_geometry + _member("e", "Ok", _polygon(SQUARE))
    )
    assert count == 3  # pagination stops on the raw count
    assert [row[0] for row in rows] == ["e"]


def test_run_reuses_cached_pages_without_credentials(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("DATAFORDELER_CLIENT_ID", raising=False)
    monkeypatch.delenv("DATAFORDELER_CLIENT_SECRET", raising=False)
    raw = tmp_path / "raw"
    raw.mkdir()
    page = "<wfs>" + _member("a", "Storskov", _polygon(SQUARE)) + "</wfs>"
    (raw / "page-00000.xml").write_text(page, encoding="utf-8")
    db = tmp_path / "forests.duckdb"

    report = stednavne.run(db, raw_dir=raw)
    assert report["named_forests"] == 1 and report["outlines"] == 1

    con = duckdb.connect(str(db), read_only=True)
    try:
        assert con.execute("SELECT name, area_m2 FROM named_forests").fetchall() == [
            ("Storskov", 1_000_000.0)
        ]
        (outline,) = con.execute("SELECT outline FROM named_forest_outlines").fetchone()
    finally:
        con.close()
    assert json.loads(outline) == [[[list(p) for p in SQUARE]]]

    # no cache and no credentials: skipped, as before
    assert "skipped" in stednavne.run(tmp_path / "other.duckdb", raw_dir=tmp_path / "empty")


# --------------------------------------------------------------------------- #
# what is published
# --------------------------------------------------------------------------- #
def test_forest_outlines_payload_is_parallel_to_the_forest_list():
    payload = forest_outlines_payload([[[SQUARE]], None], start=7)
    assert payload["version"] == 1
    assert payload["scale"] == COORD_SCALE
    assert (payload["start"], payload["count"]) == (7, 2)
    assert payload["stamp"] is None
    assert forest_outlines_payload([None], stamp="abc")["stamp"] == "abc"
    assert payload["forests"][1] is None
    assert decode_ring(payload["forests"][0][0][0]) == SQUARE


def _shift(ring: list[tuple[float, float]], d_lon: float) -> list[list[float]]:
    return [[round(lon + d_lon, 5), lat] for lon, lat in ring]


def _forest_db(path: Path, *, with_outlines: bool) -> Path:
    """Three forests, deliberately not inserted west to east; the middle one
    has no outline."""
    con = duckdb.connect(str(path))
    try:
        con.execute(stednavne._CREATE)
        con.execute(
            "INSERT INTO named_forests VALUES "
            "('a', 'Østskov', 12.008, 56.0045, 1e6), "
            "('b', 'Midtskov', 11.0, 56.01, 5000.0), "
            "('c', 'Vestskov', 10.008, 56.0045, 1e6)"
        )
        if with_outlines:
            con.execute(stednavne._CREATE_OUTLINES)
            con.executemany(
                "INSERT INTO named_forest_outlines VALUES (?, ?)",
                [
                    ("a", json.dumps([[_shift(SQUARE, 2.0)]])),
                    ("c", json.dumps([[_shift(SQUARE, 0.0)]])),
                ],
            )
    finally:
        con.close()
    return path


def test_forests_only_writes_forests_and_outlines_in_one_order(tmp_path: Path):
    db = _forest_db(tmp_path / "f.duckdb", with_outlines=True)
    out = tmp_path / "data"
    out.mkdir()
    (out / "manifest.json").write_text(json.dumps({"version": "x", "forests": None}), "utf-8")
    (out / "forest-outlines-9.json").write_text("{}", "utf-8")  # left by an earlier run

    report = run_forests_only(db, out)
    assert report["forests"] == 3 and report["outline_files"] == 1 and report["manifest_updated"]
    assert not (out / "forest-outlines-9.json").exists()

    forests = json.loads((out / "forests.json").read_text("utf-8"))
    assert [f["name"] for f in forests] == ["Vestskov", "Midtskov", "Østskov"]  # west to east
    assert set(forests[0]) == {"name", "lon", "lat", "area_m2"}  # unchanged for older clients

    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    assert manifest["forests"] == "forests.json"
    assert manifest["version"] == "x"  # everything else is left alone
    (entry,) = manifest["forest_outlines"]
    assert entry["file"] == "forest-outlines-0.json"
    assert (entry["start"], entry["count"]) == (0, 3)
    # west, south, east, north of everything in the file, the bare point included
    assert entry["bbox"] == [10.0, 56.0, 12.016, 56.01]

    outlines = json.loads((out / entry["file"]).read_text("utf-8"))
    assert (outlines["start"], outlines["count"]) == (0, 3)
    # one stamp ties the manifest entry and the file to this forests.json
    assert len(entry["stamp"]) == 12 and outlines["stamp"] == entry["stamp"]
    assert decode_ring(outlines["forests"][0][0][0]) == SQUARE
    assert outlines["forests"][1] is None  # a forest without an outline keeps its slot
    assert decode_ring(outlines["forests"][2][0][0])[0] == (12.0, 56.0)
    # the snapshot under web/public/data is kept in git: files end in a newline
    assert (out / "forests.json").read_text("utf-8").endswith("]\n")
    assert (out / entry["file"]).read_text("utf-8").endswith("}\n")


def test_outlines_are_split_into_bands_under_the_size_limit(tmp_path: Path):
    db = _forest_db(tmp_path / "f.duckdb", with_outlines=True)
    out = tmp_path / "data"
    out.mkdir()
    con = duckdb.connect(str(db), read_only=True)
    try:
        count, entries = write_forests(con, out, max_file_bytes=150)
    finally:
        con.close()
    assert count == 3
    assert entries is not None and len(entries) > 1
    # consecutive runs that together cover every forest exactly once
    assert entries[0]["start"] == 0
    for before, after in zip(entries, entries[1:], strict=False):
        assert after["start"] == before["start"] + before["count"]
    assert entries[-1]["start"] + entries[-1]["count"] == count
    for entry in entries:
        document = json.loads((out / entry["file"]).read_text("utf-8"))
        assert (document["start"], document["count"]) == (entry["start"], entry["count"])
        assert len(document["forests"]) == entry["count"]
    # each band's box covers its own forests only
    assert entries[0]["bbox"][2] < entries[-1]["bbox"][0]


def test_forests_only_without_an_outlines_table(tmp_path: Path):
    db = _forest_db(tmp_path / "f.duckdb", with_outlines=False)
    out = tmp_path / "data"
    out.mkdir()
    (out / "manifest.json").write_text(json.dumps({"version": "x"}), "utf-8")

    report = run_forests_only(db, out)
    assert report["forests"] == 3 and report["outline_files"] == 0
    assert not list(out.glob("forest-outlines*.json"))
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    assert manifest["forest_outlines"] is None  # the app falls back to the points


# --------------------------------------------------------------------------- #
# a point that is the forest's own
# --------------------------------------------------------------------------- #
# A named part that covers the middle of SQUARE, centroid included.
MIDDLE = [(10.005, 56.003), (10.011, 56.003), (10.011, 56.006), (10.005, 56.006), (10.005, 56.003)]


def test_distance_to_outline_is_in_metres():
    # 0.001 degrees of latitude south of the square's southern edge
    assert distance_to_outline_m(10.008, 55.999, [[SQUARE]]) == pytest.approx(110.5, abs=0.5)
    assert distance_to_outline_m(10.008, 56.0045, [[SQUARE]]) == pytest.approx(497, abs=3)


def test_point_is_sound_wants_inside_clear_of_the_edge_and_of_smaller_forests():
    assert point_is_sound(10.008, 56.0045, [[SQUARE]], [])
    assert not point_is_sound(10.02, 56.0045, [[SQUARE]], [])  # outside
    assert not point_is_sound(10.00002, 56.0045, [[SQUARE]], [])  # a metre inside the edge
    assert not point_is_sound(10.008, 56.0045, [[SQUARE]], [[[MIDDLE]]])  # in the named part


def test_clear_inside_point_steps_out_of_a_smaller_forest():
    lon, lat = clear_inside_point([[SQUARE]], [[[MIDDLE]]])
    assert point_in_outline(lon, lat, [[SQUARE]])
    assert not point_in_outline(lon, lat, [[MIDDLE]])
    # as far from both edges as the forest allows, not hugging either
    assert distance_to_outline_m(lon, lat, [[SQUARE]]) > 100
    assert distance_to_outline_m(lon, lat, [[MIDDLE]]) > 100
    assert (round(lon, 5), round(lat, 5)) == (lon, lat)  # already as published


def test_clear_inside_point_gives_up_when_the_forest_is_wholly_covered():
    assert clear_inside_point([[MIDDLE]], [[[SQUARE]]]) is None
    assert clear_inside_point([], []) is None


def test_settle_points_moves_only_the_points_that_need_it():
    seen = {
        "big": ("Storskov", 10.008, 56.0045, 1_000_000.0, [[SQUARE]]),  # centroid in the part
        "part": ("Lilleskov", 10.008, 56.0045, 60_000.0, [[MIDDLE]]),
        "alone": ("Eneskov", 12.0080001, 56.0045, None, [[[(x + 2, y) for x, y in SQUARE]]]),
        "bare": ("Uden Omrids", 9.0, 55.0, None, []),
    }
    report = stednavne.settle_points(seen)
    assert report == {"points_moved": 1, "points_in_smaller_forest": 0}

    _name, lon, lat, _area, outline = seen["big"]
    assert point_in_outline(lon, lat, outline) and not point_in_outline(lon, lat, [[MIDDLE]])
    assert seen["part"][1:3] == (10.008, 56.0045)  # the smaller forest keeps its own middle
    assert seen["alone"][1:3] == (12.008, 56.0045)  # only rounded
    assert seen["bare"][1:3] == (9.0, 55.0)  # nothing to test it against


def test_settle_points_counts_a_forest_wholly_inside_smaller_ones():
    seen = {
        # registered as the larger of the two, yet lying wholly inside the other
        "inner": ("Indre", 10.008, 56.0045, 2_000_000.0, [[MIDDLE]]),
        "outer": ("Ydre", 10.001, 56.001, 1_000_000.0, [[SQUARE]]),
    }
    report = stednavne.settle_points(seen)
    assert report["points_in_smaller_forest"] == 1
    assert point_in_outline(seen["inner"][1], seen["inner"][2], [[MIDDLE]])  # still its own


# --------------------------------------------------------------------------- #
# the snapshot the web app is developed against (web/public/data)
# --------------------------------------------------------------------------- #
def _snapshot():
    data = REPO_ROOT / "web" / "public" / "data"
    manifest = json.loads((data / "manifest.json").read_text("utf-8"))
    if not manifest.get("forest_outlines"):
        pytest.skip("the snapshot has no forest outlines")
    forests = json.loads((data / "forests.json").read_text("utf-8"))
    outlines: list = [None] * len(forests)
    for entry in manifest["forest_outlines"]:
        document = json.loads((data / entry["file"]).read_text("utf-8"))
        assert document["stamp"] == entry["stamp"]
        assert (document["start"], document["count"]) == (entry["start"], entry["count"])
        for i, encoded in enumerate(document["forests"]):
            if encoded:
                outlines[entry["start"] + i] = [[decode_ring(r) for r in poly] for poly in encoded]
    return manifest, forests, outlines


def test_snapshot_outline_files_cover_every_forest_once():
    manifest, forests, _outlines = _snapshot()
    entries = manifest["forest_outlines"]
    assert entries[0]["start"] == 0
    for before, after in zip(entries, entries[1:], strict=False):
        assert after["start"] == before["start"] + before["count"]
    assert entries[-1]["start"] + entries[-1]["count"] == len(forests)
    assert len({entry["stamp"] for entry in entries}) == 1


def test_snapshot_every_forest_point_is_inside_its_own_outline():
    _manifest, forests, outlines = _snapshot()
    outside = [
        forest["name"]
        for forest, outline in zip(forests, outlines, strict=True)
        if outline and not point_in_outline(forest["lon"], forest["lat"], outline)
    ]
    assert outside == []


def test_snapshot_few_forest_points_lie_in_a_smaller_forest():
    """Choosing a forest by name puts the pin on its point; a point inside a
    smaller named forest would be claimed by that one. Only forests with no
    room of their own may be left (three in the 2026-11 pull)."""
    _manifest, forests, outlines = _snapshot()
    boxes = [
        (
            min(x for poly in o for x, _ in poly[0]),
            min(y for poly in o for _, y in poly[0]),
            max(x for poly in o for x, _ in poly[0]),
            max(y for poly in o for _, y in poly[0]),
        )
        if o
        else None
        for o in outlines
    ]
    claimed = []
    for i, forest in enumerate(forests):
        lon, lat = forest["lon"], forest["lat"]
        for j, other in enumerate(outlines):
            box = boxes[j]
            if j == i or not other or not (box[0] <= lon <= box[2] and box[1] <= lat <= box[3]):
                continue
            if (forests[j]["area_m2"] or 0) < (forest["area_m2"] or 0) and point_in_outline(
                lon, lat, other
            ):
                claimed.append((forest["name"], forests[j]["name"]))
                break
    assert len(claimed) <= 3, claimed
