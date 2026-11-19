"""Ingest the Danish Red List (fungi) into DuckDB and guard the target species.

Loads a `redlist` table and checks every MVP target species against it. If a
target species is in the hide-set (RE/CR/EN/VU/NT) the run exits non-zero — that
species must not be in the app.

The Red List is a slow-changing annual assessment. If the API is unreachable but
the database already has a `redlist` table (e.g. a `--skip-dmi` web-only deploy
off a cached DuckDB), the run keeps that table and still runs the guard against
it, rather than failing the build. A first build with no cached table still
requires the API.

    python -m pipeline.ingest.redlist
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Iterable
from pathlib import Path

import duckdb

from pipeline.config import DUCKDB_PATH
from pipeline.duckload import copy_rows
from pipeline.redlist import is_hidden, iter_assessments
from pipeline.species import TARGET_SPECIES

_COLUMNS = ("scientific_name", "vernacular_name", "category", "hidden", "taxon_id", "arter_dk_id")

_SCHEMA = [
    "DROP TABLE IF EXISTS redlist",
    """CREATE TABLE redlist (
        scientific_name  TEXT PRIMARY KEY,
        vernacular_name  TEXT,
        category         TEXT NOT NULL,
        hidden           BOOLEAN NOT NULL,
        taxon_id         TEXT,
        arter_dk_id      TEXT
    )""",
]


def _cached_assessments(db_path: Path) -> list[dict] | None:
    """The existing `redlist` table as `iter_assessments`-shaped records, or
    None when there is nothing usable to fall back to."""
    if not db_path.exists():
        return None
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        has_table = con.execute(
            "SELECT count(*) FROM information_schema.tables WHERE table_name = 'redlist'"
        ).fetchone()[0]
        rows = (
            con.execute(
                "SELECT scientific_name, vernacular_name, category, taxon_id, arter_dk_id "
                "FROM redlist"
            ).fetchall()
            if has_table
            else []
        )
    finally:
        con.close()
    return (
        [
            {
                "scientific_name": name,
                "vernacular_name": vernacular,
                "category": category,
                "taxon_id": taxon_id,
                "arter_dk_id": arter_dk_id,
            }
            for name, vernacular, category, taxon_id, arter_dk_id in rows
        ]
        if rows
        else None
    )


def run(db_path: str | Path = DUCKDB_PATH, assessments: Iterable[dict] | None = None) -> dict:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    if assessments is not None:
        records, source = list(assessments), "provided"
    else:
        try:
            records, source = list(iter_assessments()), "live"
        except RuntimeError as err:
            cached = _cached_assessments(db_path)
            if cached is None:
                raise
            print(f"  red list API unavailable ({err}); keeping the cached table", flush=True)
            records, source = cached, "cached"

    by_name = {r["scientific_name"].lower(): r for r in records if r["scientific_name"]}

    hidden_names = {name for name, r in by_name.items() if is_hidden(r["category"])}
    targets_hidden = [
        {"scientific_name": s["scientific_name"], "category": by_name[key]["category"]}
        for s in TARGET_SPECIES
        if (key := s["scientific_name"].lower()) in hidden_names
    ]

    con = duckdb.connect(str(db_path))
    try:
        if source != "cached":
            for statement in _SCHEMA:
                con.execute(statement)
            copy_rows(
                con,
                "redlist",
                _COLUMNS,
                (
                    (
                        r["scientific_name"],
                        r["vernacular_name"],
                        r["category"],
                        is_hidden(r["category"]),
                        r["taxon_id"],
                        r["arter_dk_id"],
                    )
                    for r in by_name.values()
                ),
            )
        by_category = dict(
            con.execute(
                "SELECT category, count(*) FROM redlist GROUP BY 1 ORDER BY 2 DESC"
            ).fetchall()
        )
    finally:
        con.close()

    target_categories = {
        s["scientific_name"]: by_name.get(s["scientific_name"].lower(), {}).get(
            "category", "not assessed"
        )
        for s in TARGET_SPECIES
    }
    return {
        "step": "redlist",
        "round": "2019",
        "source": source,
        "assessed": len(by_name),
        "hidden": len(hidden_names),
        "by_category": by_category,
        "target_species": target_categories,
        "target_species_hidden": targets_hidden,
        "db_path": str(db_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest the Danish Red List (fungi).")
    parser.add_argument("--db", type=Path, default=DUCKDB_PATH)
    parser.add_argument("--report", type=Path, help="also write the report here as JSON")
    args = parser.parse_args()

    report = run(args.db)
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(
            json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8"
        )

    if report["target_species_hidden"]:
        raise SystemExit(
            f"FAIL: target species on the red-list hide-set: {report['target_species_hidden']}"
        )


if __name__ == "__main__":
    main()
