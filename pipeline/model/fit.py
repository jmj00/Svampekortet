"""Fit the v0 model per published species (core + extra) and write the artifacts.

    python -m pipeline.model.fit

Reads the DuckDB built by the ingest + derive steps and writes, under
``build/publish/model/``:

    manifest.json        — version, parameters, per-species index, backtest summary
    <slug>.json          — habitat params, the 366-point seasonality curve, the
                           per-feature historic weather distribution (calibration
                           slot present but identity -- ADR-0008, ADR-0009)
    current.json         — antecedent weather per DMI cell as of the latest day
    backtest.json        — the full two-regime backtest report (the ship gate)

Every published species gets a file, including any with no observations yet (its
habitat ``raw_ref`` is 0, so every score is 0). The web app loads these
alongside the species payload and combines them for a pin.

Also fits and publishes each species' ``biotope`` field (forest-/soil-type
affinity) and, when the ingest step has populated a ``biotope_grid`` table,
``model/biotope_grid.json``. This is advisory context only (ADR-0016) -- it is
not part of ``manifest["terms"]`` and never reaches ``combine()``/the ranked
score; the web app reads it separately to describe a pin's site.

Also fits and publishes each species' ``host_tree`` field and, when the
ingest step has populated a ``host_tree_grid`` table, ``model/
host_tree_grid.json``. Whether a species' ``host_tree`` actually reaches the
ranked score is decided **per species** (``SpeciesModel.host_tree_scored``,
``HOST_TREE_SCORED_SPECIES`` in ``pipeline.model.host_tree``) against the real
backtest, not uniformly like ``weather`` -- see that module's docstring for
the full investigation and why literature-known host specificity turned out
to predict the *wrong* species.

When the ingest step has populated a ``recording_effort_grid`` table, also
publishes ``model/recording_effort_grid.json`` and fits each ``HabitatModel``
with it, giving the habitat term a second, effort-corrected reference
alongside its original one -- see ``pipeline.model.habitat``. **Do not run
that ingest against a production database**: ADR-0018 measured this against
the real backtest and rejected it -- at every correction strength tried it
made ranking worse, catastrophically so at full strength. The machinery stays
here, dormant and tested, only because it's fully backward compatible (no
effort grid, no change to any existing score) and the two-reference pattern
may be useful for some *other* optional habitat refinement later.

Also runs two gates whose failures are returned (not written) for
``pipeline.build`` to act on: the two-regime backtest (ADR-0007) and the
golden-location checks (``golden.py``, ADR-0006).
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path

import duckdb

from pipeline.config import DUCKDB_PATH, PUBLISH_DIR
from pipeline.derive.observation_weather import FULL_WINDOW_DAYS
from pipeline.model import backtest, current, golden
from pipeline.model.biotope import BiotopeGrid, BiotopeModel
from pipeline.model.calibration import IsotonicCalibrator
from pipeline.model.habitat import HabitatModel
from pipeline.model.host_tree import (
    HOST_TREE_SCORED_SPECIES,
    HOST_TREE_SPECIES,
    HostTreeGrid,
    HostTreeModel,
)
from pipeline.model.recording_effort import EffortGrid
from pipeline.model.seasonality import DEFAULT_SIGMA_DAYS, SeasonalityModel
from pipeline.model.species_model import SpeciesModel
from pipeline.model.weather import WEATHER_FEATURES, WeatherModel, coverage_column_and_threshold
from pipeline.publish.site import slugify
from pipeline.species import published_species

MODEL_DIR_NAME = "model"
BIOTOPE_GRID_NAME = "biotope_grid.json"
EFFORT_GRID_NAME = "recording_effort_grid.json"
HOST_TREE_GRID_NAME = "host_tree_grid.json"

# The backtest fits candidate isotonic calibrators, but the model does not apply
# them. Three calibration routes were measured against the temporal backtest and
# none improved it: per-axis isotonic (ADR-0008), isotonic vs backtest labels,
# and percentile-among-finds (both ADR-0009). The 0..100 spread comes from the
# geometric-mean combine instead.
ATTACH_CALIBRATION = False


def _table_exists(con: duckdb.DuckDBPyConnection, name: str) -> bool:
    return bool(
        con.execute(
            "SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [name]
        ).fetchone()[0]
    )


def _weather_stats(
    con: duckdb.DuckDBPyConnection, scientific_name: str
) -> tuple[int, dict[str, tuple[float | None, float | None]]]:
    # WEATHER_FEATURES is a fixed in-repo constant, not user input. Each
    # feature is averaged only over the rows where *its own* antecedent
    # window is fully covered (ADR-0017) -- precip_60d_mm and
    # prior_summer_precip_mm need a wider/different window than the rest.
    agg_cols = []
    for f in WEATHER_FEATURES:
        col, threshold = coverage_column_and_threshold(f)
        agg_cols.append(f"avg(ow.{f}) FILTER (WHERE ow.{col} >= {threshold})")
        agg_cols.append(f"stddev_samp(ow.{f}) FILTER (WHERE ow.{col} >= {threshold})")
    cols = ", ".join(agg_cols)
    row = con.execute(
        f"SELECT {cols}, "
        f"count(*) FILTER (WHERE ow.precip_days_covered >= {FULL_WINDOW_DAYS}) "
        "FROM observation_weather ow "
        "JOIN observations o USING (observation_id) "
        "WHERE o.scientific_name = ?",
        [scientific_name],
    ).fetchone()
    stats = {f: (row[2 * i], row[2 * i + 1]) for i, f in enumerate(WEATHER_FEATURES)}
    return int(row[-1]), stats


def _load_biotope_grid(con: duckdb.DuckDBPyConnection) -> BiotopeGrid | None:
    if not _table_exists(con, "biotope_grid"):
        return None
    rows = con.execute("SELECT lon, lat, forest_type, soil_tsym FROM biotope_grid").fetchall()
    return BiotopeGrid.from_rows(rows)


def _load_effort_grid(con: duckdb.DuckDBPyConnection) -> EffortGrid | None:
    if not _table_exists(con, "recording_effort_grid"):
        return None
    rows = con.execute("SELECT lon, lat, n FROM recording_effort_grid").fetchall()
    return EffortGrid.from_rows(rows)


def _load_host_tree_grid(con: duckdb.DuckDBPyConnection) -> HostTreeGrid | None:
    if not _table_exists(con, "host_tree_grid"):
        return None
    cols = ", ".join(HOST_TREE_SPECIES)
    rows = con.execute(f"SELECT lon, lat, {cols} FROM host_tree_grid").fetchall()
    return HostTreeGrid.from_rows(rows)


def fit_species(
    con: duckdb.DuckDBPyConnection,
    scientific_name: str,
    slug: str,
    *,
    with_weather: bool,
    biotope_grid: BiotopeGrid | None = None,
    effort_grid: EffortGrid | None = None,
    host_tree_grid: HostTreeGrid | None = None,
    host_tree_background: Mapping[str, float] | None = None,
    calibration: IsotonicCalibrator | None = None,
) -> SpeciesModel:
    rows = con.execute(
        "SELECT lon, lat, observed_on FROM observations "
        "WHERE scientific_name = ? ORDER BY observed_on, lon, lat",
        [scientific_name],
    ).fetchall()
    points = [(lon, lat) for lon, lat, _ in rows]
    days_of_year = [observed_on.timetuple().tm_yday for _, _, observed_on in rows]

    weather = None
    if with_weather:
        n_full, stats = _weather_stats(con, scientific_name)
        weather = WeatherModel.from_stats(n_full, stats)

    biotope = None
    if biotope_grid is not None:
        sites = [biotope_grid.classify(lon, lat) for lon, lat in points]
        biotope = BiotopeModel.fit(sites)

    host_tree = None
    if host_tree_grid is not None:
        host_sites = [host_tree_grid.classify(lon, lat) for lon, lat in points]
        host_tree = HostTreeModel.fit(host_sites, host_tree_background)

    return SpeciesModel(
        slug=slug,
        habitat=HabitatModel.fit(points, effort_grid),
        seasonality=SeasonalityModel.fit(days_of_year),
        weather=weather,
        host_tree=host_tree,
        host_tree_scored=scientific_name in HOST_TREE_SCORED_SPECIES,
        biotope=biotope,
        calibration=calibration,
    )


def run(
    db_path: str | Path = DUCKDB_PATH,
    out_dir: str | Path = PUBLISH_DIR,
    *,
    skip_backtest: bool = False,
    skip_golden: bool = False,
) -> dict:
    model_dir = Path(out_dir) / MODEL_DIR_NAME
    model_dir.mkdir(parents=True, exist_ok=True)

    # The backtest fits the calibrators and is the ship gate. It needs a
    # read-write connection for one temp table, so it runs (and closes) before
    # the read-only fit connection opens on the same file.
    bt = (
        backtest.run(db_path, out_dir, strict=False)
        if not skip_backtest
        else backtest.BacktestResult(report={"available": False})
    )

    con = duckdb.connect(str(db_path), read_only=True)
    try:
        if not _table_exists(con, "observations"):
            raise SystemExit("table 'observations' is missing -- run the ingest steps first")
        with_weather = _table_exists(con, "observation_weather")
        biotope_grid = _load_biotope_grid(con)
        effort_grid = _load_effort_grid(con)
        host_tree_grid = _load_host_tree_grid(con)
        host_tree_background = host_tree_grid.background_means() if host_tree_grid else None

        index: list[dict] = []
        models: dict[str, SpeciesModel] = {}
        for species in published_species():
            sci = species["scientific_name"]
            slug = slugify(sci)
            calibration = bt.calibrators.get(slug) if ATTACH_CALIBRATION else None
            model = fit_species(
                con,
                sci,
                slug,
                with_weather=with_weather,
                biotope_grid=biotope_grid,
                effort_grid=effort_grid,
                host_tree_grid=host_tree_grid,
                host_tree_background=host_tree_background,
                calibration=calibration,
            )
            models[slug] = model
            calibrated = model.calibration is not None and not model.calibration.is_identity
            biotope_fitted = bool(
                model.biotope and (model.biotope.forest.scores or model.biotope.soil.scores)
            )
            effort_corrected = model.habitat.ratio_ref is not None
            host_tree_fitted = bool(model.host_tree and model.host_tree.affinity)
            doc = model.to_dict()
            spacing = model.habitat.spacing_km
            doc["fit"] = {
                "n_observations": len(model.habitat.observations),
                "locality_spacing_km": round(spacing, 3) if spacing is not None else None,
                "weather_fitted": bool(model.weather and model.weather.is_fitted),
                "biotope_fitted": biotope_fitted,
                "effort_corrected": effort_corrected,
                "host_tree_fitted": host_tree_fitted,
                "host_tree_scored": model.host_tree_scored,
                "calibrated": calibrated,
            }
            (model_dir / f"{slug}.json").write_text(
                json.dumps(doc, ensure_ascii=False), encoding="utf-8"
            )
            index.append(
                {
                    "slug": slug,
                    "scientific_name": sci,
                    "tier": species["tier"],
                    "file": f"{MODEL_DIR_NAME}/{slug}.json",
                    "n_observations": len(model.habitat.observations),
                    "bandwidth_km": round(model.habitat.bandwidth_km, 3),
                    "weather_fitted": bool(model.weather and model.weather.is_fitted),
                    "biotope_fitted": biotope_fitted,
                    "effort_corrected": effort_corrected,
                    "host_tree_fitted": host_tree_fitted,
                    "host_tree_scored": model.host_tree_scored,
                    "calibrated": calibrated,
                }
            )

        if biotope_grid is not None:
            (model_dir / BIOTOPE_GRID_NAME).write_text(
                json.dumps(biotope_grid.to_list(), ensure_ascii=False), encoding="utf-8"
            )
        if effort_grid is not None:
            (model_dir / EFFORT_GRID_NAME).write_text(
                json.dumps(effort_grid.to_list(), ensure_ascii=False), encoding="utf-8"
            )
        if host_tree_grid is not None:
            (model_dir / HOST_TREE_GRID_NAME).write_text(
                json.dumps(host_tree_grid.to_list(), ensure_ascii=False), encoding="utf-8"
            )

        current_report = (
            current.build(con, model_dir) if _table_exists(con, "weather_daily") else None
        )
    finally:
        con.close()

    golden_report = (
        golden.run(models)
        if not skip_golden
        else {"passed": True, "failures": [], "skipped": [], "cases": []}
    )

    backtest_ran = bool(bt.report.get("species"))
    manifest = {
        "version": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "terms": ["habitat", "seasonality", "weather", "host_tree"],
        "seasonality_sigma_days": DEFAULT_SIGMA_DAYS,
        "weather_features": list(WEATHER_FEATURES),
        "current_conditions": (f"{MODEL_DIR_NAME}/{current.OUT_NAME}" if current_report else None),
        "biotope_grid": (
            f"{MODEL_DIR_NAME}/{BIOTOPE_GRID_NAME}" if biotope_grid is not None else None
        ),
        "recording_effort_grid": (
            f"{MODEL_DIR_NAME}/{EFFORT_GRID_NAME}" if effort_grid is not None else None
        ),
        "host_tree_grid": (
            f"{MODEL_DIR_NAME}/{HOST_TREE_GRID_NAME}" if host_tree_grid is not None else None
        ),
        "backtest": _backtest_summary(bt.report) if backtest_ran else None,
        "backtest_report": f"{MODEL_DIR_NAME}/backtest.json" if backtest_ran else None,
        "species": index,
    }
    (model_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return {
        "step": "model",
        "out_dir": str(model_dir),
        "species": len(index),
        "species_without_observations": sum(1 for s in index if s["n_observations"] == 0),
        "species_with_weather": sum(1 for s in index if s["weather_fitted"]),
        "species_with_biotope": sum(1 for s in index if s["biotope_fitted"]),
        "species_effort_corrected": sum(1 for s in index if s["effort_corrected"]),
        "species_with_host_tree": sum(1 for s in index if s["host_tree_fitted"]),
        "species_host_tree_scored": sum(1 for s in index if s["host_tree_scored"]),
        "species_calibrated": sum(1 for s in index if s["calibrated"]),
        "current_conditions": current_report,
        "backtest": bt.report if backtest_ran else None,
        "backtest_failures": bt.report.get("failures", []) if backtest_ran else [],
        "golden": golden_report,
        "golden_failures": golden_report["failures"],
        "files": len(index) + 1 + (1 if current_report else 0) + (1 if backtest_ran else 0),
    }


def _backtest_summary(report: dict) -> dict:
    def _auc(entry: dict, regime: str) -> dict | None:
        block = entry.get(regime)
        return {"full": block["auc_full"], "baseline": block["auc_baseline"]} if block else None

    return {
        "passed_all": report["passed_all"],
        "test_years": report["test_years"],
        "gate": report["gate"],
        "species": {
            s["slug"]: {
                "passed": s.get("passed"),
                "skipped": s["skipped"],
                "week_matched": _auc(s, "week_matched"),
                "calendar_random": _auc(s, "calendar_random"),
            }
            for s in report["species"]
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Fit the v0 model and write its artifacts.")
    parser.add_argument("--db", type=Path, default=DUCKDB_PATH)
    parser.add_argument("--out", type=Path, default=PUBLISH_DIR)
    parser.add_argument("--report", type=Path, help="also write the report here as JSON")
    parser.add_argument("--skip-backtest", action="store_true", help="don't run the backtest gate")
    parser.add_argument(
        "--skip-golden", action="store_true", help="don't run the golden-location gate"
    )
    args = parser.parse_args()

    report = run(args.db, args.out, skip_backtest=args.skip_backtest, skip_golden=args.skip_golden)
    text = json.dumps(report, indent=2, ensure_ascii=False, default=str)
    print(text)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
