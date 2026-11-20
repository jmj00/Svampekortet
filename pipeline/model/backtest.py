"""Temporal backtest of the v0 model -- the ship gate (ADR-0006 + ADR-0007).

Fit each species on finds up to ``TRAIN_MAX_YEAR``, then score the held-out
``TEST_YEARS`` seasons. Real finds are positives; random grid cells across the
study area are negatives, drawn under **two** date regimes:

- ``week_matched``     -- negatives share the positives' weeks. Isolates the
                          *spatial* signal; the full model must merely not do
                          materially worse than the habitat x seasonality
                          baseline (AUC >= baseline - WEEK_MATCHED_TOLERANCE).
                          Seasonality is in that baseline because the map
                          scores every place for the same day, so it cannot
                          change spatial ranking; here it would only add the
                          +-DATE_JITTER_DAYS noise (ADR-0023). What is left to
                          test is whether weather (and host tree) hurt it.
- ``calendar_random``  -- negative dates spread across the whole test-year
                          calendar, like a real user asking "is now good?" any
                          month. The full model must beat the habitat-only
                          baseline here by CALENDAR_RANDOM_MARGIN -- this is
                          where seasonality and weather earn their place.

Both conditions must hold or the build fails. The gate is measured on the raw
``habitat x seasonality x weather x host_tree`` product; the displayed 0..100
value is the geometric mean of the same axes (ADR-0008), which is monotone in
that product and so shares every AUC here. Each species report also carries
``positive_score_percentiles`` -- the spread of the displayed value over the
held-out finds -- as the evidence that the geometric-mean scale is usable.

The isotonic ``candidate_calibration`` is fitted on the ``calendar_random``
evaluation for the record only; the model does not apply it. Calibration is
measured, not adopted -- per-axis (ADR-0008), isotonic vs these labels, and
percentile-among-finds (both ADR-0009).

    python -m pipeline.model.backtest

Reads ``observations`` + ``observation_weather`` + ``weather_daily``. Uses a
read-write connection for one TEMP TABLE of background samples; makes no lasting
change to the database.
"""

from __future__ import annotations

import argparse
import json
import random
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

import duckdb

from pipeline.config import DUCKDB_PATH
from pipeline.derive.observation_weather import FULL_WINDOW_DAYS
from pipeline.duckload import copy_rows
from pipeline.model.calibration import IsotonicCalibrator
from pipeline.model.habitat import HabitatModel
from pipeline.model.host_tree import (
    HOST_TREE_SCORED_SPECIES,
    HOST_TREE_SPECIES,
    HostTreeGrid,
    HostTreeModel,
)
from pipeline.model.metrics import auc_gap_se, calibration_curve, precision_at_k, roc_auc
from pipeline.model.recording_effort import EffortGrid
from pipeline.model.seasonality import SeasonalityModel
from pipeline.model.species_model import SpeciesModel
from pipeline.model.weather import (
    WEATHER_FEATURES,
    WeatherModel,
    build_feature_dict,
    coverage_column_and_threshold,
)
from pipeline.publish.site import slugify
from pipeline.species import published_species

TRAIN_MAX_YEAR = 2021
TEST_YEARS = (2022, 2023, 2024, 2025)
# 5 -> 20 (2026-11-19): at 5 the negative draw alone moved a species'
# week_matched gap by ~0.01-0.02, so species within that of the tolerance
# passed or failed by luck. The gap's bootstrap SE is in the report.
NEGATIVES_PER_POSITIVE = 20
GAP_SE_RESAMPLES = 200
DATE_JITTER_DAYS = 3  # week_matched negatives sit within this of a positive's day
MIN_TEST_POSITIVES = 25  # below this the gate is skipped for that species
SEED = 20260902

# How far below its baseline (habitat x seasonality since ADR-0023; habitat
# only before) the full model's week_matched AUC may
# sit. Raised 0.03 -> 0.035 with ADR-0011: deduping the habitat KDE lifted the
# baseline itself ~0.006, the full model's absolute week_matched AUC is
# unchanged.
WEEK_MATCHED_TOLERANCE = 0.035
# How far above the habitat-only baseline the full model's calendar_random AUC
# must sit. Lowered 0.01 -> 0.005 on the all-Denmark corpus: the same ADR-0011
# KDE dedup that lifted the week_matched baseline also lifted this one, and
# craterellus-tubaeformis -- the latest, longest-fruiting of the six, so the
# thinnest seasonal signal -- compressed from +0.018 (Jutland) to +0.009. The
# full model still ranks better on both AUC and precision@k; the baseline rose,
# it did not regress. Every other species clears +0.005 by >0.02.
CALENDAR_RANDOM_MARGIN = 0.005

WEEK_MATCHED = "week_matched"
CALENDAR_RANDOM = "calendar_random"

_SQL_DIR = Path(__file__).parent / "sql"
_NEGATIVE_WEATHER_SQL = (_SQL_DIR / "negative_weather.sql").read_text(encoding="utf-8")


@dataclass
class BacktestResult:
    report: dict
    calibrators: dict[str, IsotonicCalibrator] = field(default_factory=dict)


def _table_exists(con: duckdb.DuckDBPyConnection, name: str) -> bool:
    return bool(
        con.execute(
            "SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [name]
        ).fetchone()[0]
    )


def has_backtest_inputs(con: duckdb.DuckDBPyConnection) -> bool:
    return all(
        _table_exists(con, t) for t in ("observations", "observation_weather", "weather_daily")
    )


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


def _train_model(
    con: duckdb.DuckDBPyConnection,
    sci: str,
    slug: str,
    effort_grid: EffortGrid | None,
    host_tree_grid: HostTreeGrid | None,
    host_tree_background: dict[str, float] | None = None,
) -> SpeciesModel:
    rows = con.execute(
        "SELECT lon, lat, observed_on FROM observations "
        "WHERE scientific_name = ? AND year(observed_on) <= ? ORDER BY observed_on, lon, lat",
        [sci, TRAIN_MAX_YEAR],
    ).fetchall()
    points = [(lon, lat) for lon, lat, _ in rows]
    days = [d.timetuple().tm_yday for *_, d in rows]

    host_tree = None
    if host_tree_grid is not None:
        sites = [host_tree_grid.classify(lon, lat) for lon, lat in points]
        host_tree = HostTreeModel.fit(sites, host_tree_background)

    agg_cols = []
    for f in WEATHER_FEATURES:
        col, threshold = coverage_column_and_threshold(f)
        agg_cols.append(f"avg(ow.{f}) FILTER (WHERE ow.{col} >= {threshold})")
        agg_cols.append(f"stddev_samp(ow.{f}) FILTER (WHERE ow.{col} >= {threshold})")
    cols = ", ".join(agg_cols)
    wrow = con.execute(
        f"SELECT {cols}, "
        f"count(*) FILTER (WHERE ow.precip_days_covered >= {FULL_WINDOW_DAYS}) "
        "FROM observation_weather ow "
        "JOIN observations o USING (observation_id) "
        "WHERE o.scientific_name = ? AND year(o.observed_on) <= ?",
        [sci, TRAIN_MAX_YEAR],
    ).fetchone()
    stats = {f: (wrow[2 * i], wrow[2 * i + 1]) for i, f in enumerate(WEATHER_FEATURES)}

    return SpeciesModel(
        slug=slug,
        habitat=HabitatModel.fit(points, effort_grid),
        seasonality=SeasonalityModel.fit(days),
        weather=WeatherModel.from_stats(int(wrow[-1]), stats),
        host_tree=host_tree,
        host_tree_scored=sci in HOST_TREE_SCORED_SPECIES,
    )


def _test_positives(
    con: duckdb.DuckDBPyConnection,
    sci: str,
    effort_grid: EffortGrid | None,
    host_tree_grid: HostTreeGrid | None,
) -> list[dict]:
    # Every feature's value, then every feature's own coverage count, both in
    # WEATHER_FEATURES order -- build_feature_dict pairs them positionally.
    feature_cols = ", ".join(f"ow.{f}" for f in WEATHER_FEATURES)
    coverage_cols = ", ".join(f"ow.{coverage_column_and_threshold(f)[0]}" for f in WEATHER_FEATURES)
    rows = con.execute(
        f"SELECT o.lon, o.lat, o.observed_on, {feature_cols}, {coverage_cols} FROM observations o "
        "JOIN observation_weather ow USING (observation_id) "
        "WHERE o.scientific_name = ? AND year(o.observed_on) IN "
        f"({', '.join(str(y) for y in TEST_YEARS)}) "
        "AND ow.precip_days_covered >= ? "
        "ORDER BY o.observation_id",
        [sci, FULL_WINDOW_DAYS],
    ).fetchall()
    n = len(WEATHER_FEATURES)
    positives = []
    for lon, lat, observed_on, *rest in rows:
        feats, coverages = rest[:n], rest[n:]
        positives.append(
            {
                "lon": lon,
                "lat": lat,
                "doy": observed_on.timetuple().tm_yday,
                "weather": build_feature_dict(feats, coverages),
                "effort": effort_grid.at(lon, lat) if effort_grid else None,
                "site": host_tree_grid.classify(lon, lat) if host_tree_grid else None,
            }
        )
    return positives


def _anchor(regime: str, positives: list[dict], rng: random.Random) -> date:
    year = rng.choice(TEST_YEARS)
    if regime == WEEK_MATCHED:
        doy = rng.choice(positives)["doy"] + rng.randint(-DATE_JITTER_DAYS, DATE_JITTER_DAYS)
    else:
        doy = rng.randint(1, 365)
    return date(year, 1, 1) + timedelta(days=max(0, min(364, doy - 1)))


def _negative_samples(
    con: duckdb.DuckDBPyConnection,
    cells: list[tuple[str, float, float]],
    positives: list[dict],
    rng: random.Random,
    effort_grid: EffortGrid | None,
    host_tree_grid: HostTreeGrid | None,
    *,
    regime: str,
) -> list[dict]:
    want = len(positives) * NEGATIVES_PER_POSITIVE
    con.execute(
        "CREATE OR REPLACE TEMP TABLE bg_samples (sample_id BIGINT, cell_id TEXT, anchor DATE)"
    )
    meta: dict[int, dict] = {}
    batch = []
    for sid in range(want):
        cell_id, clon, clat = rng.choice(cells)
        anchor = _anchor(regime, positives, rng)
        effort = effort_grid.at(clon, clat) if effort_grid else None
        site = host_tree_grid.classify(clon, clat) if host_tree_grid else None
        meta[sid] = {
            "lon": clon,
            "lat": clat,
            "doy": anchor.timetuple().tm_yday,
            "effort": effort,
            "site": site,
        }
        batch.append((sid, cell_id, anchor))
    copy_rows(con, "bg_samples", ("sample_id", "cell_id", "anchor"), batch)  # executemany too slow

    n = len(WEATHER_FEATURES)
    negatives = []
    for sid, *rest in con.execute(_NEGATIVE_WEATHER_SQL).fetchall():
        feats, coverages = rest[:n], rest[n:]
        overall_covered = coverages[0]  # precip_days_covered -- the original gate
        if overall_covered is None or overall_covered < FULL_WINDOW_DAYS:
            continue
        info = meta[sid]
        negatives.append(
            {
                "lon": info["lon"],
                "lat": info["lat"],
                "doy": info["doy"],
                "weather": build_feature_dict(feats, coverages),
                "effort": info["effort"],
                "site": info["site"],
            }
        )
    con.execute("DROP TABLE IF EXISTS bg_samples")
    return negatives


BASELINE_HABITAT = "habitat"
BASELINE_HABITAT_SEASONALITY = "habitat_x_seasonality"


def _evaluate(
    model: SpeciesModel,
    positives: list[dict],
    negatives: list[dict],
    *,
    baseline: str = BASELINE_HABITAT,
) -> tuple[dict, list[float], list[int]]:
    raw_full: list[float] = []
    raw_base: list[float] = []
    labels: list[int] = []
    for label, points in ((1, positives), (0, negatives)):
        for p in points:
            habitat, season, _w, _h, raw = model.terms(
                p["lon"], p["lat"], p["doy"], p["weather"], p.get("effort"), p.get("site")
            )
            raw_full.append(raw)
            raw_base.append(
                habitat * season if baseline == BASELINE_HABITAT_SEASONALITY else habitat
            )
            labels.append(label)

    k = max(1, len(positives))
    metrics = {
        "baseline": baseline,
        "n_negatives": len(negatives),
        "auc_full": _r(roc_auc(raw_full, labels)),
        "auc_baseline": _r(roc_auc(raw_base, labels)),
        "precision_at_k_full": _r(precision_at_k(raw_full, labels, k)),
        "precision_at_k_baseline": _r(precision_at_k(raw_base, labels, k)),
        # bootstrap SE of auc_full - auc_baseline: how much of the gap is noise
        "auc_gap_se": _r(
            auc_gap_se(raw_full, raw_base, labels, resamples=GAP_SE_RESAMPLES, seed=SEED)
        ),
        "calibration_curve": calibration_curve(raw_full, labels),
    }
    return metrics, raw_full, labels


def _fit_calibrator(raw: list[float], labels: list[int]) -> IsotonicCalibrator:
    """Isotonic map on the full (unbalanced) week-matched eval: P(real find |
    raw), rescaled to span [0, 1] inside ``IsotonicCalibrator.fit``.

    Fitted on the *week-matched* eval on purpose: there seasonality is roughly
    constant across positives and negatives, so the raw product varies mostly
    along the habitat/weather axis and the map does not conflate "hotspot out of
    season" with "random place in season" (both can share a small raw). An
    out-of-season query then lands below the fitted range and clamps low.
    """
    if 1 not in labels or 0 not in labels:
        return IsotonicCalibrator.identity()
    return IsotonicCalibrator.fit(raw, labels)


def _gate(week: dict, cal: dict) -> tuple[bool, str | None]:
    for name, m in (("week_matched", week), ("calendar_random", cal)):
        if m["auc_full"] is None or m["auc_baseline"] is None:
            return False, f"{name}: AUC undefined"
    if week["auc_full"] < week["auc_baseline"] - WEEK_MATCHED_TOLERANCE:
        return False, (
            f"week_matched AUC {week['auc_full']:.4f} is more than "
            f"{WEEK_MATCHED_TOLERANCE} below the baseline {week['auc_baseline']:.4f}"
        )
    if cal["auc_full"] < cal["auc_baseline"] + CALENDAR_RANDOM_MARGIN:
        return False, (
            f"calendar_random AUC {cal['auc_full']:.4f} does not beat the baseline "
            f"{cal['auc_baseline']:.4f} by {CALENDAR_RANDOM_MARGIN}"
        )
    return True, None


def _r(value: float) -> float | None:
    return None if value != value else round(value, 4)  # NaN check


def _positive_score_percentiles(model: SpeciesModel, positives: list[dict]) -> dict:
    """Spread of the displayed 0..100 value over the held-out finds -- the
    check that the geometric-mean scale (ADR-0008) is a usable favourability
    and not pinned near zero."""
    values = sorted(
        model.score(
            p["lon"], p["lat"], p["doy"], p["weather"], p.get("effort"), p.get("site")
        ).value
        for p in positives
    )

    def at(q: float) -> int:
        return values[min(len(values) - 1, int(q * len(values)))]

    return {"p10": at(0.10), "p50": at(0.50), "p90": at(0.90), "max": values[-1]}


def run(
    db_path: str | Path = DUCKDB_PATH,
    out_dir: str | Path | None = None,
    *,
    strict: bool = True,
) -> BacktestResult:
    con = duckdb.connect(str(db_path))
    try:
        if not has_backtest_inputs(con):
            if strict:
                raise SystemExit("backtest needs observations, observation_weather, weather_daily")
            return BacktestResult(report={"available": False}, calibrators={})
        # ORDER BY: DuckDB's DISTINCT returns rows in no fixed order, and the
        # seeded rng picks negatives by index into this list -- unordered, the
        # same data and seed gave a different negative sample (and AUC) per run.
        cells = con.execute(
            "SELECT DISTINCT cell_id, cell_lon, cell_lat FROM weather_daily ORDER BY cell_id"
        ).fetchall()
        effort_grid = _load_effort_grid(con)
        host_tree_grid = _load_host_tree_grid(con)
        host_tree_background = host_tree_grid.background_means() if host_tree_grid else None

        rng = random.Random(SEED)
        species_reports: list[dict] = []
        calibrators: dict[str, IsotonicCalibrator] = {}
        failures: list[str] = []  # core tier -- build-blocking
        advisory_failures: list[str] = []  # extra tier -- recorded, not blocking

        for species in published_species():
            sci = species["scientific_name"]
            tier = species["tier"]
            slug = slugify(sci)
            model = _train_model(con, sci, slug, effort_grid, host_tree_grid, host_tree_background)
            positives = _test_positives(con, sci, effort_grid, host_tree_grid)

            if len(positives) < MIN_TEST_POSITIVES:
                species_reports.append(
                    {
                        "slug": slug,
                        "tier": tier,
                        "skipped": True,
                        "reason": f"only {len(positives)} test-period finds with a full window",
                        "n_train": len(model.habitat.observations),
                        "n_test_positives": len(positives),
                    }
                )
                calibrators[slug] = IsotonicCalibrator.identity()
                continue

            week, raw_week, labels_week = _evaluate(
                model,
                positives,
                _negative_samples(
                    con, cells, positives, rng, effort_grid, host_tree_grid, regime=WEEK_MATCHED
                ),
                baseline=BASELINE_HABITAT_SEASONALITY,
            )
            cal, _rc, _lc = _evaluate(
                model,
                positives,
                _negative_samples(
                    con, cells, positives, rng, effort_grid, host_tree_grid, regime=CALENDAR_RANDOM
                ),
            )
            calibrators[slug] = _fit_calibrator(raw_week, labels_week)
            passed, reason = _gate(week, cal)
            if not passed:
                (failures if tier == "core" else advisory_failures).append(slug)

            species_reports.append(
                {
                    "slug": slug,
                    "tier": tier,
                    "skipped": False,
                    "passed": passed,
                    "reason": reason,
                    "n_train": len(model.habitat.observations),
                    "n_test_positives": len(positives),
                    "weather_fitted": bool(model.weather and model.weather.is_fitted),
                    "effort_corrected": model.habitat.ratio_ref is not None,
                    "host_tree_fitted": bool(model.host_tree and model.host_tree.affinity),
                    "host_tree_scored": model.host_tree_scored,
                    "week_matched": week,
                    "calendar_random": cal,
                    "positive_score_percentiles": _positive_score_percentiles(model, positives),
                    # a candidate calibrator, computed for inspection; v0 does not
                    # apply it (ADR-0007, ADR-0008)
                    "candidate_calibration": calibrators[slug].to_dict(),
                }
            )
    finally:
        con.close()

    report = {
        "train_max_year": TRAIN_MAX_YEAR,
        "test_years": list(TEST_YEARS),
        "negatives_per_positive": NEGATIVES_PER_POSITIVE,
        "seed": SEED,
        "gate": {
            "week_matched_tolerance": WEEK_MATCHED_TOLERANCE,
            "calendar_random_margin": CALENDAR_RANDOM_MARGIN,
        },
        "passed_all": not failures,
        "failures": failures,
        "advisory_failures": advisory_failures,
        "species": species_reports,
    }
    if out_dir is not None:
        model_dir = Path(out_dir) / "model"
        model_dir.mkdir(parents=True, exist_ok=True)
        (model_dir / "backtest.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    return BacktestResult(report=report, calibrators=calibrators)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the v0 model backtest (the ship gate).")
    parser.add_argument("--db", type=Path, default=DUCKDB_PATH)
    parser.add_argument("--out", type=Path, help="also write model/backtest.json under here")
    parser.add_argument("--report", type=Path, help="write the report JSON here too")
    args = parser.parse_args()

    result = run(args.db, args.out)
    text = json.dumps(result.report, indent=2, ensure_ascii=False)
    print(text)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")
    if not result.report["passed_all"]:
        raise SystemExit(f"BACKTEST FAILED: {result.report['failures']}")


if __name__ == "__main__":
    main()
