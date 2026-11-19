"""Antecedent weather per DMI cell as of the latest available day.

    python -m pipeline.model.current

Writes ``build/publish/model/current.json`` -- the "how wet / warm has it been"
vector for every grid cell, which the web app pairs with the per-species
weather distributions to score a pin. Reads ``weather_daily`` read-only.
"""

from __future__ import annotations

import argparse
import json
from datetime import date, timedelta
from pathlib import Path

import duckdb

from pipeline.config import DUCKDB_PATH, PUBLISH_DIR
from pipeline.derive.observation_weather import FULL_WINDOW_DAYS

_SQL = (Path(__file__).parent / "sql" / "current_conditions.sql").read_text(encoding="utf-8")

CELL_FEATURES = (
    "precip_7d_mm",
    "precip_14d_mm",
    "precip_30d_mm",
    "precip_60d_mm",
    "mean_temp_7d_c",
    "mean_temp_14d_c",
    "mean_temp_30d_c",
    "dry_days_30d",
    "prior_summer_precip_mm",
)
# Coverage counts published alongside precip_days_covered (the original 30-day
# gate) -- precip_60d_mm and prior_summer_precip_mm need their own, wider or
# differently-timed window (ADR-0017), so the web app gates each separately
# instead of by one shared cutoff (see coverage_column_and_threshold).
COVERAGE_FEATURES = ("precip_60d_days_covered", "prior_summer_days_covered")
OUT_NAME = "current.json"


def _table_exists(con: duckdb.DuckDBPyConnection, name: str) -> bool:
    return bool(
        con.execute(
            "SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [name]
        ).fetchone()[0]
    )


def _round(value: float | None) -> float | None:
    return round(value, 1) if value is not None else None


def build(con: duckdb.DuckDBPyConnection, out_dir: Path, *, as_of: date | None = None) -> dict:
    """Write ``current.json`` under ``out_dir`` using an already-open connection.

    The anchor defaults to the day *after* the latest ``weather_daily`` row, so
    the 30-day window ``[anchor - 30, anchor - 1]`` (matching
    ``observation_weather``) includes every day of data available.
    """
    if as_of is not None:
        anchor = as_of
    else:
        latest = con.execute("SELECT max(date) FROM weather_daily").fetchone()[0]
        if latest is None:
            raise SystemExit("weather_daily is empty -- run the DMI ingest first")
        anchor = latest + timedelta(days=1)

    rows = con.execute(_SQL, [anchor, anchor]).fetchall()
    columns = [d[0] for d in con.description]
    cells = []
    for row in rows:
        record = dict(zip(columns, row, strict=True))
        cell = {
            "cell_id": record["cell_id"],
            "lon": _round(record["cell_lon"]),
            "lat": _round(record["cell_lat"]),
            "precip_days_covered": int(record["precip_days_covered"]),
        }
        for feature in COVERAGE_FEATURES:
            value = record[feature]
            cell[feature] = int(value) if value is not None else 0
        for feature in CELL_FEATURES:
            cell[feature] = _round(record[feature])
        cells.append(cell)

    covered = sum(1 for c in cells if c["precip_days_covered"] >= FULL_WINDOW_DAYS)
    payload = {
        "as_of": anchor.isoformat(),
        "window_days": 30,
        "features": list(CELL_FEATURES),
        "cells": cells,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / OUT_NAME).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    return {
        "as_of": anchor.isoformat(),
        "cells": len(cells),
        "cells_with_full_window": covered,
    }


def run(
    db_path: str | Path = DUCKDB_PATH,
    out_dir: str | Path = PUBLISH_DIR,
    *,
    as_of: date | None = None,
) -> dict:
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        if not _table_exists(con, "weather_daily"):
            raise SystemExit("table 'weather_daily' is missing -- run the DMI ingest first")
        return build(con, Path(out_dir) / "model", as_of=as_of)
    finally:
        con.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Write current per-cell antecedent weather.")
    parser.add_argument("--db", type=Path, default=DUCKDB_PATH)
    parser.add_argument("--out", type=Path, default=PUBLISH_DIR)
    parser.add_argument("--as-of", type=date.fromisoformat, help="anchor date (default: latest)")
    args = parser.parse_args()
    print(json.dumps(run(args.db, args.out, as_of=args.as_of), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
