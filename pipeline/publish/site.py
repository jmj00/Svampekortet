"""Write the static payload the web app loads: a manifest plus one file per species.

    python -m pipeline.publish.site

Output (under build/publish/, git-ignored):

    manifest.json              — version, bbox, attribution, species index (each
                                   entry also carries `season_by_month` and a
                                   `thumbnail` URL, so the species list needs no
                                   per-species file to draw its rows)
    species/<slug>.json        — metadata + monthly seasonality + observation points
    forests.json                — {name, lon, lat, area_m2} objects, one per named
                                   forest (Danske Stednavne, naturarealtype
                                   "skovPlantage" -- see pipeline.ingest.stednavne),
                                   only written if `named_forests` exists.
                                   manifest["forests"] is null otherwise, and the web
                                   app treats that as "no forest suggestions
                                   available" rather than an error. `lon`/`lat`
                                   is a point inside the forest.
    forest-outlines-<n>.json    — the same forests' simplified polygons, in the
                                   same order as forests.json (west to east),
                                   split into a few files that each cover a band
                                   of the country (see `write_forests` and
                                   `forest_outlines_payload`); only written if
                                   `named_forest_outlines` exists.
                                   manifest["forest_outlines"] lists the files
                                   with the forests and the area each covers, and
                                   is null otherwise: the web app then decides
                                   "which forest is the pin in" from the points
                                   alone. Fetched by the app on demand, one band
                                   at a time, not with the first paint.

`--forests-only` rewrites just forests.json and the outline files (and the
two manifest keys, if a manifest.json is already there) from the forest tables,
without needing the observation tables: for refreshing the forest snapshot
under web/public/data from a database that only holds the Stednavne pull.

Publishes the `core` and `extra` tiers (docs/adr/0012-species-tiers-core-and-extra.md);
each file carries `tier` and `score_validated`. Reads the DuckDB read-only; no network.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from pipeline.config import (
    DENMARK_BBOX,
    DESCRIPTIONS_DIR,
    DUCKDB_PATH,
    IMAGES_DIR,
    PUBLISH_DIR,
)
from pipeline.forest_outlines import COORD_SCALE, encode_outline
from pipeline.lookalikes import Lookalike, load_lookalikes, lookalikes_for
from pipeline.species import published_species

FORESTS_FILE = "forests.json"
FOREST_OUTLINES_FILE = "forest-outlines-{n}.json"
#: The outlines are split into files of at most this size (uncompressed): the
#: app then fetches one band of the country, not all of it, and each file of
#: the snapshot under web/public/data stays under the repo's large-file limit.
MAX_OUTLINE_FILE_BYTES = 400_000

ATTRIBUTION = {
    "observations": (
        "Atlas of Danish Fungi / Danmarks Svampeatlas, Danish Mycological Society (CC BY-NC 4.0)"
    ),
    "weather": "DMI – Frie Data",
    "basemap": "GeoDanmark / Klimadatastyrelsen (CC BY 4.0), Datafordeler",
    "redlist": "Den Danske Rødliste, DCE / Aarhus Universitet (2019)",
    "photos": "Fotos fra iNaturalist-fund (CC BY 4.0 / CC0) – se det enkelte billede",
    "forests": "Danske Stednavne, Klimadatastyrelsen (CC BY 4.0)",
}


def slugify(scientific_name: str) -> str:
    return scientific_name.lower().replace(" ", "-")


def _description(slug: str) -> str | None:
    path = DESCRIPTIONS_DIR / f"{slug}.md"
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8").strip() or None


def _images(slug: str) -> list[dict]:
    path = IMAGES_DIR / f"{slug}.json"
    if not path.exists():
        return []
    return [
        {
            "url": img["url"],
            "credit": img["credit"],
            "license": img["license"],
            "source": img.get("source", ""),
            "link": img.get("observation_url"),
        }
        for img in json.loads(path.read_text(encoding="utf-8"))
    ]


def _poisonous_lookalikes(slug: str, lookalikes: list[Lookalike]) -> list[dict]:
    """The 'Giftige forvekslinger' section of a species page (data/lookalikes.json)."""
    return [
        {
            "danish_name": entry["danish_name"],
            "scientific_name": entry["scientific_name"],
            "text": entry["text"],
            "images": _images(entry["slug"]),
        }
        for entry in lookalikes_for(slug, lookalikes)
    ]


_INAT_LARGE = re.compile(r"^(https://[^?#]+/photos/\d+/)large(\.[A-Za-z]+)$")


def _thumbnail(images: list[dict]) -> str | None:
    """A small rendition of the species' first photo, for the list rows.

    iNaturalist serves every photo in fixed size variants under one path
    (square 75 px, small 240 px, medium, large); the detail view uses `large`,
    the list wants `small`. Any other URL is passed through unchanged.
    """
    if not images:
        return None
    url = images[0]["url"]
    match = _INAT_LARGE.match(url)
    return f"{match.group(1)}small{match.group(2)}" if match else url


def _table_exists(con: duckdb.DuckDBPyConnection, name: str) -> bool:
    return bool(
        con.execute(
            "SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [name]
        ).fetchone()[0]
    )


def forest_outlines_payload(
    outlines: list[list | None], start: int = 0, stamp: str | None = None
) -> dict:
    """One `forest-outlines-<n>.json` document: a run of consecutive forests.

    `stamp` identifies the forests.json these outlines belong to (the manifest
    entry for the file carries the same one).

    `forests` runs parallel to forests.json from index `start`: entry *i* is
    the outline of forest `start + i` there, or null when it has none. An
    outline is a list of polygons (the parts of the forest), a polygon a list
    of rings (outer first, then holes), a ring a flat list of integers in
    1/`scale` degrees: the first corner as lon, lat, each later corner as the
    difference from the one before; the closing point is left out
    (`pipeline.forest_outlines.encode_ring`).
    """
    return {
        "version": 1,
        "scale": COORD_SCALE,
        "start": start,
        "count": len(outlines),
        "stamp": stamp,
        "forests": [encode_outline(o) if o else None for o in outlines],
    }


def _dump(document: object, **kwargs: object) -> str:
    """JSON text ending in a newline, as the repo's end-of-file check wants for
    the snapshot kept under web/public/data."""
    return json.dumps(document, **kwargs) + "\n"  # type: ignore[arg-type]


def _outline_bbox(outline: list | None, lon: float, lat: float) -> tuple[float, ...]:
    """(west, south, east, north) of a forest: its outline, or just its point."""
    if not outline:
        return (lon, lat, lon, lat)
    xs = [x for polygon in outline for x, _y in polygon[0]]
    ys = [y for polygon in outline for _x, y in polygon[0]]
    return (min(xs), min(ys), max(xs), max(ys))


def write_forests(
    con: duckdb.DuckDBPyConnection,
    out_dir: Path,
    max_file_bytes: int = MAX_OUTLINE_FILE_BYTES,
) -> tuple[int, list[dict] | None]:
    """Write forests.json and, when the outlines table exists, the outline files.

    Returns (forests written, the manifest's `forest_outlines` value): a list
    of `{file, start, count, bbox}` entries, one per outline file, or None
    when there is no outlines table (no file written).

    The forests are listed west to east, and the outline files are consecutive
    runs of that list, each at most `max_file_bytes`: so each file is a band of
    the country, and the app fetches only the band(s) whose `bbox` (west,
    south, east, north of everything in it) the pin falls in.
    """
    has_outlines = _table_exists(con, "named_forest_outlines")
    if has_outlines:
        rows = con.execute(
            # five decimals, like the outlines: a point rounded more coarsely
            # than the outline it must lie in can land just outside it
            "SELECT f.name, round(f.lon, 5), round(f.lat, 5), f.area_m2, o.outline "
            "FROM named_forests f LEFT JOIN named_forest_outlines o USING (sted_id) "
            "ORDER BY f.lon, f.sted_id"
        ).fetchall()
    else:
        rows = con.execute(
            "SELECT name, round(lon, 5), round(lat, 5), area_m2, NULL "
            "FROM named_forests ORDER BY lon, sted_id"
        ).fetchall()
    forests_text = _dump(
        [
            {"name": name, "lon": lon, "lat": lat, "area_m2": area}
            for name, lon, lat, area, _outline in rows
        ],
        ensure_ascii=False,
    )
    (out_dir / FORESTS_FILE).write_text(forests_text, encoding="utf-8")
    # Ties the outline files to this very list of forests: the app refuses an
    # outline file whose stamp is not the one the manifest gives, so a manifest
    # and an outline file from different publishes (a cache serving one of
    # them stale) fall back to the forest points instead of pairing outlines
    # with the wrong forests.
    stamp = hashlib.sha1(forests_text.encode("utf-8")).hexdigest()[:12]  # noqa: S324
    for stale in out_dir.glob("forest-outlines*.json"):
        stale.unlink()  # a previous run may have written more files than this one
    if not has_outlines:
        return len(rows), None

    outlines = [json.loads(outline) if outline else None for *_rest, outline in rows]
    sizes = [
        len(json.dumps(encode_outline(o) if o else None, separators=(",", ":"))) + 1
        for o in outlines
    ]
    entries: list[dict] = []
    start = 0
    while start < len(rows):
        end = start
        size = 80  # the document's own wrapper
        while end < len(rows) and (end == start or size + sizes[end] <= max_file_bytes):
            size += sizes[end]
            end += 1
        name = FOREST_OUTLINES_FILE.format(n=len(entries))
        (out_dir / name).write_text(
            _dump(
                forest_outlines_payload(outlines[start:end], start, stamp), separators=(",", ":")
            ),
            encoding="utf-8",
        )
        boxes = [_outline_bbox(outlines[i], rows[i][1], rows[i][2]) for i in range(start, end)]
        entries.append(
            {
                "file": name,
                "start": start,
                "count": end - start,
                "stamp": stamp,
                "bbox": [
                    round(min(b[0] for b in boxes), 5),
                    round(min(b[1] for b in boxes), 5),
                    round(max(b[2] for b in boxes), 5),
                    round(max(b[3] for b in boxes), 5),
                ],
            }
        )
        start = end
    return len(rows), entries


def run_forests_only(db_path: str | Path = DUCKDB_PATH, out_dir: str | Path = PUBLISH_DIR) -> dict:
    """Rewrite only the forest files (see the module docstring's `--forests-only`)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        if not _table_exists(con, "named_forests"):
            raise SystemExit("table 'named_forests' is missing -- run pipeline.ingest.stednavne")
        forest_count, outline_files = write_forests(con, out_dir)
    finally:
        con.close()
    manifest_path = out_dir / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["forests"] = FORESTS_FILE
        manifest["forest_outlines"] = outline_files
        manifest_path.write_text(_dump(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "step": "publish-forests",
        "out_dir": str(out_dir),
        "forests": forest_count,
        "outline_files": len(outline_files or []),
        "manifest_updated": manifest_path.exists(),
    }


def run(db_path: str | Path = DUCKDB_PATH, out_dir: str | Path = PUBLISH_DIR) -> dict:
    out_dir = Path(out_dir)
    (out_dir / "species").mkdir(parents=True, exist_ok=True)

    con = duckdb.connect(str(db_path), read_only=True)
    try:
        if not _table_exists(con, "observations"):
            raise SystemExit("table 'observations' is missing -- run the build first")
        has_redlist = _table_exists(con, "redlist")
        has_forests = _table_exists(con, "named_forests")

        index: list[dict] = []
        lookalikes = load_lookalikes()
        for species in published_species():
            sci = species["scientific_name"]
            slug = slugify(sci)
            points = con.execute(
                "SELECT round(lon, 4), round(lat, 4), month(observed_on) "
                "FROM observations WHERE scientific_name = ? ORDER BY observed_on, lon, lat",
                [sci],
            ).fetchall()

            season = [0] * 12
            for _lon, _lat, month in points:
                season[month - 1] += 1

            category = None
            if has_redlist:
                row = con.execute(
                    "SELECT category FROM redlist WHERE lower(scientific_name) = lower(?)", [sci]
                ).fetchone()
                category = row[0] if row else "not assessed"

            images = _images(slug)  # data/images/<slug>.json
            doc = {
                "slug": slug,
                "danish_name": species["danish_name"],
                "scientific_name": sci,
                "group": species["group"],
                "tier": species["tier"],
                "score_validated": species["tier"] == "core",
                "edible": species["edible"],
                "lookalike_risk": species["lookalike_risk"],
                "gbif_usage_key": species["gbif_usage_key"],
                "redlist_category": category,
                "description": _description(slug),  # data/descriptions/<slug>.md
                "images": images,
                "poisonous_lookalikes": _poisonous_lookalikes(slug, lookalikes),
                "observation_count": len(points),
                "season_by_month": season,
                "observations": [[lon, lat, month] for lon, lat, month in points],
            }
            (out_dir / "species" / f"{slug}.json").write_text(
                json.dumps(doc, ensure_ascii=False), encoding="utf-8"
            )
            index.append(
                {
                    "slug": slug,
                    "danish_name": species["danish_name"],
                    "scientific_name": sci,
                    "group": species["group"],
                    "tier": species["tier"],
                    "score_validated": species["tier"] == "core",
                    "observation_count": len(points),
                    # The list rows show a photo and the season without
                    # fetching every species file first.
                    "season_by_month": season,
                    "thumbnail": _thumbnail(images),
                    "file": f"species/{slug}.json",
                }
            )
        forest_count = 0
        outline_files: list[dict] | None = None
        if has_forests:
            forest_count, outline_files = write_forests(con, out_dir)
    finally:
        con.close()

    manifest = {
        "version": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bbox": list(DENMARK_BBOX),
        "attribution": ATTRIBUTION,
        "species": index,
        "forests": FORESTS_FILE if has_forests else None,
        # Older clients ignore this key; a null (or missing) one makes the app
        # fall back to the forest points alone.
        "forest_outlines": outline_files,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return {
        "step": "publish",
        "out_dir": str(out_dir),
        "species": len(index),
        "observations": sum(s["observation_count"] for s in index),
        "forests": forest_count,
        "forest_outline_files": len(outline_files or []),
        "files": len(index) + 1 + (1 if has_forests else 0) + len(outline_files or []),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Write the static web payload.")
    parser.add_argument("--db", type=Path, default=DUCKDB_PATH)
    parser.add_argument("--out", type=Path, default=PUBLISH_DIR)
    parser.add_argument(
        "--forests-only",
        action="store_true",
        help="rewrite only forests.json and the outline files (and their manifest keys)",
    )
    args = parser.parse_args()
    report = run_forests_only(args.db, args.out) if args.forests_only else run(args.db, args.out)
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
