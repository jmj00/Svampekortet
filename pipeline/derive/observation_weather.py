"""Attach antecedent-weather features to every observation.

For each observation: find the nearest DMI grid cell, then summarise that cell's
weather over the 30 days *before* the observation date (the fungal fruiting
response lags rainfall by days to a few weeks).

Produces two tables:

- `observation_cell`   — observation_id -> nearest cell_id, distance
- `observation_weather` — observation_id + the weather feature columns

    python -m pipeline.derive.observation_weather

Runs against the DuckDB built by the ingest steps; no network.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import duckdb

from pipeline.config import DUCKDB_PATH

_SQL_DIR = Path(__file__).parent / "sql"
FULL_WINDOW_DAYS = 28  # of the 30 antecedent days, count >= 28 present as "covered"


def _table_exists(con: duckdb.DuckDBPyConnection, name: str) -> bool:
    return bool(
        con.execute(
            "SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [name]
        ).fetchone()[0]
    )


def run(db_path: str | Path = DUCKDB_PATH) -> dict:
    con = duckdb.connect(str(db_path))
    try:
        for table in ("observations", "weather_daily"):
            if not _table_exists(con, table):
                raise SystemExit(f"table {table!r} is missing -- run the ingest steps first")

        con.execute((_SQL_DIR / "nearest_cell.sql").read_text(encoding="utf-8"))
        con.execute((_SQL_DIR / "weather_features.sql").read_text(encoding="utf-8"))

        total = con.execute("SELECT count(*) FROM observation_weather").fetchone()[0]
        covered = con.execute(
            "SELECT count(*) FROM observation_weather WHERE precip_days_covered >= ?",
            [FULL_WINDOW_DAYS],
        ).fetchone()[0]
        dist = con.execute(
            "SELECT quantile_cont(dist_km, [0.5, 0.9, 1.0]) FROM observation_cell"
        ).fetchone()[0]
        covered_by_year = dict(
            con.execute(
                "SELECT year(o.observed_on)::TEXT, count(*) "
                "FROM observation_weather ow JOIN observations o USING (observation_id) "
                "WHERE ow.precip_days_covered >= ? GROUP BY 1 ORDER BY 1",
                [FULL_WINDOW_DAYS],
            ).fetchall()
        )
        sample = con.execute(
            "SELECT observation_id, cell_id, round(dist_km, 1), round(precip_30d_mm, 1), "
            "round(mean_temp_30d_c, 1), dry_days_30d "
            "FROM observation_weather WHERE precip_days_covered >= ? LIMIT 3",
            [FULL_WINDOW_DAYS],
        ).fetchall()
    finally:
        con.close()

    return {
        "step": "observation_weather",
        "observations": total,
        "with_full_window": covered,
        "without_full_window": total - covered,
        "cell_distance_km": {"p50": dist[0], "p90": dist[1], "max": dist[2]} if dist else None,
        "with_full_window_by_year": covered_by_year,
        "sample": sample,
        "db_path": str(db_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Attach antecedent weather to observations.")
    parser.add_argument("--db", type=Path, default=DUCKDB_PATH)
    parser.add_argument("--report", type=Path, help="also write the report here as JSON")
    args = parser.parse_args()

    report = run(args.db)
    text = json.dumps(report, indent=2, ensure_ascii=False, default=str)
    print(text)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
