"""Rebuild the database end to end: ingest, derive, publish.

    python -m pipeline.build --archive path/to/dwcarchive.zip

Steps, in order:

1. ingest.svampeatlas  — observations + species
2. ingest.dmi          — weather_daily (slow). --skip-dmi reuses it as-is;
                         otherwise only the --dmi-from-year..now range is refreshed
                         (each year is deleted and reloaded), so an existing DB can
                         be topped up cheaply. --dmi-fresh wipes the table first.
3. ingest.redlist      — redlist + target-species guard. If the API is down but
                         the DB already has the table, that table is kept and the
                         guard still runs against it.
4. derive.observation_weather — observation_cell + observation_weather
5. model.fit           — per-species conditions-model artifacts, plus the
                         two-regime backtest and the golden-location checks as
                         gates (--skip-model to omit)
6. publish.site        — the static payload for the web app (--skip-publish to omit)

Exits non-zero if any step's guard trips: a published species too thin, a target
species on the red-list hide-set, or -- for a `core`-tier species only -- the
backtest's full model failing to beat the habitat-only baseline or a golden
location scoring outside its expected band. `extra`-tier gate failures are
advisory (docs/adr/0012-species-tiers-core-and-extra.md).
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

from pipeline.config import DUCKDB_PATH, PUBLISH_DIR
from pipeline.derive import observation_weather
from pipeline.ingest import dmi, redlist, svampeatlas
from pipeline.model import fit as model_fit
from pipeline.publish import site


def run(
    archive: str | Path,
    db_path: str | Path = DUCKDB_PATH,
    *,
    dmi_from_year: int = 2011,
    dmi_to_year: int | None = None,
    dmi_fresh: bool = False,
    skip_dmi: bool = False,
    skip_model: bool = False,
    skip_publish: bool = False,
    publish_dir: str | Path = PUBLISH_DIR,
) -> dict:
    dmi_to_year = dmi_to_year or datetime.now().year
    reports: dict[str, dict] = {}
    failures: list[str] = []

    print("[1/6] ingest.svampeatlas")
    reports["svampeatlas"] = svampeatlas.run(archive, db_path)
    thin = reports["svampeatlas"]["species_below_min"]
    if thin:
        failures.append(f"published species too thin: {thin}")

    if skip_dmi:
        print("[2/6] ingest.dmi -- skipped")
    else:
        print(f"[2/6] ingest.dmi ({dmi_from_year}-{dmi_to_year}{', fresh' if dmi_fresh else ''})")
        reports["dmi"] = dmi.run(dmi_from_year, dmi_to_year, db_path, fresh=dmi_fresh)

    print("[3/6] ingest.redlist")
    reports["redlist"] = redlist.run(db_path)
    if reports["redlist"].get("source") == "cached":
        print("      red list API unavailable -- kept the cached table")
    hidden = reports["redlist"]["target_species_hidden"]
    if hidden:
        failures.append(f"target species red-listed: {hidden}")

    print("[4/6] derive.observation_weather")
    reports["observation_weather"] = observation_weather.run(db_path)

    if skip_model:
        print("[5/6] model.fit -- skipped")
    else:
        print("[5/6] model.fit")
        reports["model"] = model_fit.run(db_path, publish_dir)
        beaten = reports["model"].get("backtest_failures")
        if beaten:
            failures.append(f"model backtest: full score no better than baseline for {beaten}")
        golden_bad = reports["model"].get("golden_failures")
        if golden_bad:
            failures.append(f"golden locations: {golden_bad}")

    if skip_publish:
        print("[6/6] publish.site -- skipped")
    else:
        print("[6/6] publish.site")
        reports["publish"] = site.run(db_path, publish_dir)

    return {"db_path": str(db_path), "steps": reports, "failures": failures}


def main() -> None:
    parser = argparse.ArgumentParser(description="Rebuild the DuckDB database end to end.")
    parser.add_argument("--archive", type=Path, required=True, help="Svampeatlas dwcarchive.zip")
    parser.add_argument("--db", type=Path, default=DUCKDB_PATH)
    parser.add_argument("--dmi-from-year", type=int, default=2011)
    parser.add_argument("--dmi-to-year", type=int, default=None)
    parser.add_argument("--dmi-fresh", action="store_true", help="wipe weather_daily first")
    parser.add_argument("--skip-dmi", action="store_true", help="reuse the loaded weather_daily")
    parser.add_argument("--skip-model", action="store_true", help="don't fit the model artifacts")
    parser.add_argument("--skip-publish", action="store_true", help="don't write the web payload")
    parser.add_argument("--report", type=Path, help="also write the combined report here as JSON")
    args = parser.parse_args()

    result = run(
        args.archive,
        args.db,
        dmi_from_year=args.dmi_from_year,
        dmi_to_year=args.dmi_to_year,
        dmi_fresh=args.dmi_fresh,
        skip_dmi=args.skip_dmi,
        skip_model=args.skip_model,
        skip_publish=args.skip_publish,
    )
    text = json.dumps(result, indent=2, ensure_ascii=False, default=str)
    print(text)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")

    if result["failures"]:
        raise SystemExit("BUILD FAILED:\n  " + "\n  ".join(result["failures"]))


if __name__ == "__main__":
    main()
