"""Ingest DMI daily climate-grid values into DuckDB.

Pulls the 10 km grid (mean temperature, accumulated precipitation) over the
Denmark bounding box into a `weather_daily` table, one year at a time. Each year
is deleted and re-loaded, so a run can be resumed by narrowing `--from-year`.

    python -m pipeline.ingest.dmi --from-year 2009 --to-year 2026

Still a slow network job (hundreds of requests) but the DB write is a fast COPY.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime
from pathlib import Path

import duckdb

from pipeline.config import DENMARK_BBOX, DUCKDB_PATH
from pipeline.dmi import DAILY_PARAMETERS, iter_daily
from pipeline.duckload import copy_rows

_COLUMNS = ("cell_id", "date", "parameter", "value", "cell_lon", "cell_lat")

# No PRIMARY KEY: (cell_id, date, parameter) is unique by construction -- each year
# is DELETEd then reloaded, and rows are de-duplicated in memory first. The ART
# index a PK builds badly slows the per-year COPY once the table has millions of rows.
_CREATE = """
CREATE TABLE IF NOT EXISTS weather_daily (
    cell_id    TEXT NOT NULL,
    date       DATE NOT NULL,
    parameter  TEXT NOT NULL,
    value      DOUBLE,
    cell_lon   DOUBLE NOT NULL,
    cell_lat   DOUBLE NOT NULL
)
"""


def run(
    from_year: int,
    to_year: int,
    db_path: str | Path = DUCKDB_PATH,
    *,
    fresh: bool = False,
) -> dict:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    per_param_year: Counter[str] = Counter()
    con = duckdb.connect(str(db_path))
    try:
        if fresh:
            con.execute("DROP TABLE IF EXISTS weather_daily")
        con.execute(_CREATE)

        for year in range(from_year, to_year + 1):
            con.execute("DELETE FROM weather_daily WHERE year(date) = ?", [year])
            year_rows: dict[tuple, tuple] = {}
            for parameter in DAILY_PARAMETERS:
                before = len(year_rows)
                for row in iter_daily(parameter, year, DENMARK_BBOX):
                    key = (row["cell_id"], row["date"], row["parameter"])
                    year_rows[key] = tuple(row[column] for column in _COLUMNS)
                per_param_year[f"{parameter} {year}"] = len(year_rows) - before
                print(
                    f"  {parameter} {year}: {per_param_year[f'{parameter} {year}']} cell-days",
                    flush=True,
                )
            copy_rows(con, "weather_daily", _COLUMNS, year_rows.values())

        con.execute("CHECKPOINT")  # reclaim space from the per-year DELETEs

        total = con.execute("SELECT count(*) FROM weather_daily").fetchone()[0]
        cells = con.execute("SELECT count(DISTINCT cell_id) FROM weather_daily").fetchone()[0]
        span = con.execute("SELECT min(date), max(date) FROM weather_daily").fetchone()
        nulls = con.execute("SELECT count(*) FROM weather_daily WHERE value IS NULL").fetchone()[0]
    finally:
        con.close()

    return {
        "source": "dmi",
        "years": [from_year, to_year],
        "rows": total,
        "distinct_cells": cells,
        "date_span": [str(span[0]), str(span[1])],
        "null_values": nulls,
        "per_parameter_year": dict(per_param_year),
        "db_path": str(db_path),
    }


def main() -> None:
    now_year = datetime.now().year
    parser = argparse.ArgumentParser(description="Ingest DMI daily climate-grid values.")
    parser.add_argument("--from-year", type=int, default=2011)  # the 10 km grid starts 2011
    parser.add_argument("--to-year", type=int, default=now_year)
    parser.add_argument("--db", type=Path, default=DUCKDB_PATH)
    parser.add_argument("--fresh", action="store_true", help="drop weather_daily first")
    parser.add_argument("--report", type=Path, help="also write the report here as JSON")
    args = parser.parse_args()

    if args.from_year > args.to_year:
        raise SystemExit("--from-year must be <= --to-year")

    report = run(args.from_year, args.to_year, args.db, fresh=args.fresh)
    text = json.dumps(report, indent=2, ensure_ascii=False, default=str)
    print(text)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
