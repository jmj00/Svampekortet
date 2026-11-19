"""Ingest a Denmark-wide "recording effort" background: how much fungal
recording (of *any* species, not just the ~50 published target ones) happens
near a point -- the raw material for `pipeline.model.recording_effort`'s
grid, built to correct the habitat term for observer/accessibility bias
(target-group background). **Do not run this against a production
database.** ADR-0018 measured the correction against the real backtest and
rejected it -- it made the habitat term's ranking worse at every strength
tried. This ingest and its grid stay in the repo (tested, dormant), not
wired into `pipeline.build` or any deploy step.

    python -m pipeline.ingest.recording_effort --archive path/to/dwcarchive.zip

Re-scans the *same* archive `pipeline.ingest.svampeatlas` reads -- no new
external source. The only difference from that ingest is which records are
kept: every sufficiently precise, dated, georeferenced fungal record, not
just ones matching a target species, since the point here is "how much does
anyone report fungi here at all," not "where has this species been found."
Species identity and taxon rank are irrelevant for that question, so both
checks are dropped; every other quality gate (withheld/generalised records,
coordinates, Danish bounding box, coordinate uncertainty, a usable date)
carries over unchanged from `svampeatlas.classify`.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import duckdb

from pipeline.config import DUCKDB_PATH, MAX_COORDINATE_UNCERTAINTY_M, in_denmark
from pipeline.duckload import copy_rows
from pipeline.dwca import DwcArchive
from pipeline.ingest.svampeatlas import parse_event_date, parse_float
from pipeline.model.recording_effort import GRID_DEG

_SCHEMA = [
    "DROP TABLE IF EXISTS recording_effort_grid",
    "CREATE TABLE recording_effort_grid ("
    "lon DOUBLE NOT NULL, lat DOUBLE NOT NULL, n BIGINT NOT NULL)",
]


def _grid_key(lon: float, lat: float) -> tuple[int, int]:
    return round(lon / GRID_DEG), round(lat / GRID_DEG)


def classify(record: dict[str, str]) -> tuple[tuple[float, float] | None, str]:
    """Same quality gates as `pipeline.ingest.svampeatlas.classify`, minus the
    species-identity and taxon-rank checks -- a background point counts
    regardless of which species (or none confidently identified) it is."""
    if record.get("informationWithheld") or record.get("dataGeneralizations"):
        return None, "withheld/generalized"

    lon = parse_float(record.get("decimalLongitude"))
    lat = parse_float(record.get("decimalLatitude"))
    if lon is None or lat is None:
        return None, "no coordinates"
    if not in_denmark(lon, lat):
        return None, "outside Denmark"

    uncertainty = parse_float(record.get("coordinateUncertaintyInMeters"))
    if uncertainty is None:
        return None, "no coordinate uncertainty"
    if uncertainty > MAX_COORDINATE_UNCERTAINTY_M:
        return None, "coordinate uncertainty too high"

    if parse_event_date(record.get("eventDate")) is None:
        return None, "no usable date"

    return (lon, lat), ""


def run(archive_path: str | Path, db_path: str | Path = DUCKDB_PATH) -> dict:
    db_path = Path(db_path)
    counts: Counter[tuple[int, int]] = Counter()
    rows_scanned = 0
    kept = 0
    rejected: Counter[str] = Counter()

    with DwcArchive(archive_path) as archive:
        for record in archive.iter_core():
            rows_scanned += 1
            point, reason = classify(record)
            if point is None:
                rejected[reason] += 1
            else:
                counts[_grid_key(*point)] += 1
                kept += 1
            if rows_scanned % 200_000 == 0:
                print(f"  ...{rows_scanned:,} rows scanned, {kept:,} kept, {len(counts):,} cells")

    rows = [(round(gx * GRID_DEG, 5), round(gy * GRID_DEG, 5), n) for (gx, gy), n in counts.items()]

    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db_path))
    try:
        for statement in _SCHEMA:
            con.execute(statement)
        copy_rows(con, "recording_effort_grid", ("lon", "lat", "n"), rows)
    finally:
        con.close()

    return {
        "step": "recording_effort",
        "rows_scanned": rows_scanned,
        "kept": kept,
        "rejected_total": sum(rejected.values()),
        "rejected_by_reason": dict(rejected.most_common()),
        "grid_cells": len(rows),
        "db_path": str(db_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Grid every sufficiently precise fungal record (any species) into a "
        "recording-effort background."
    )
    parser.add_argument("--archive", type=Path, required=True, help="path to dwcarchive.zip")
    parser.add_argument("--db", type=Path, default=DUCKDB_PATH, help=f"DuckDB path [{DUCKDB_PATH}]")
    parser.add_argument("--report", type=Path, help="also write the report here as JSON")
    args = parser.parse_args()

    report = run(args.archive, args.db)
    text = json.dumps(report, indent=2, ensure_ascii=False, default=str)
    print(text)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
