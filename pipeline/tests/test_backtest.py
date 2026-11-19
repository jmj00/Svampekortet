"""Tests for the two-regime backtest ship gate (ADR-0007)."""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

import duckdb
import pytest

from pipeline.duckload import copy_rows
from pipeline.model import backtest

CLUSTER = (9.60, 56.30)  # coincides with grid cell "a"
FAR = (10.30, 56.70)  # grid cell "b"
IN_SEASON = list(range(225, 259))  # ~mid-Aug .. mid-Sep


def _weather_daily_rows() -> list[tuple]:
    rows: list[tuple] = []
    day = date(2021, 12, 1)
    end = date(2025, 12, 31)
    while day <= end:
        for cell_id, (lon, lat) in (("a", CLUSTER), ("b", FAR)):
            rows.append((cell_id, day, "acc_precip", 3.0, lon, lat))
            rows.append((cell_id, day, "mean_temp", 12.0, lon, lat))
        day += timedelta(days=1)
    return rows


def _observations() -> tuple[list[tuple], list[tuple]]:
    obs: list[tuple] = []
    ow: list[tuple] = []
    oid = 0
    for phase, years in (("train", (2018, 2019, 2020, 2021)), ("test", (2022, 2023, 2024, 2025))):
        count = 130 if phase == "train" else 60
        for k in range(count):
            oid += 1
            year = years[k % len(years)]
            doy = IN_SEASON[k % len(IN_SEASON)]
            when = date(year, 1, 1) + timedelta(days=doy - 1)
            lon = CLUSTER[0] + ((k % 7) - 3) * 0.004
            lat = CLUSTER[1] + ((k % 5) - 2) * 0.004
            obs.append((f"O{oid}", "Cantharellus cibarius", when, lon, lat))
            ow.append(
                (
                    f"O{oid}",
                    40.0 + k % 8,
                    80.0 + k % 12,
                    13.0 + (k % 4) * 0.3,
                    15.0,
                    30.0,
                    160.0 + k % 20,  # precip_60d_mm
                    60.0,  # precip_60d_days_covered -- full
                    250.0 + k % 30,  # prior_summer_precip_mm
                    90.0,  # prior_summer_days_covered -- full
                )
            )
    return obs, ow


@pytest.fixture
def backtest_db(tmp_path: Path) -> Path:
    db = tmp_path / "bt.duckdb"
    obs, ow = _observations()
    con = duckdb.connect(str(db))
    try:
        con.execute(
            "CREATE TABLE observations (observation_id TEXT, scientific_name TEXT, "
            "observed_on DATE, lon DOUBLE, lat DOUBLE)"
        )
        con.executemany("INSERT INTO observations VALUES (?, ?, ?, ?, ?)", obs)
        con.execute(
            "CREATE TABLE observation_weather (observation_id TEXT, precip_14d_mm DOUBLE, "
            "precip_30d_mm DOUBLE, mean_temp_14d_c DOUBLE, dry_days_30d DOUBLE, "
            "precip_days_covered DOUBLE, precip_60d_mm DOUBLE, precip_60d_days_covered DOUBLE, "
            "prior_summer_precip_mm DOUBLE, prior_summer_days_covered DOUBLE)"
        )
        con.executemany("INSERT INTO observation_weather VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ow)
        con.execute(
            "CREATE TABLE weather_daily (cell_id TEXT, date DATE, parameter TEXT, "
            "value DOUBLE, cell_lon DOUBLE, cell_lat DOUBLE)"
        )
        copy_rows(
            con,
            "weather_daily",
            ("cell_id", "date", "parameter", "value", "cell_lon", "cell_lat"),
            _weather_daily_rows(),
        )
    finally:
        con.close()
    return db


def test_gate_helper():
    ok = {"auc_full": 0.90, "auc_baseline": 0.91}  # 0.01 below -> within tolerance
    win = {"auc_full": 0.95, "auc_baseline": 0.90}
    passed, reason = backtest._gate(ok, win)
    assert passed and reason is None

    passed, reason = backtest._gate({"auc_full": 0.80, "auc_baseline": 0.90}, win)
    assert not passed and "week_matched" in reason

    passed, reason = backtest._gate(ok, {"auc_full": 0.902, "auc_baseline": 0.90})
    assert not passed and "calendar_random" in reason


def test_backtest_runs_and_the_full_model_passes(backtest_db: Path, tmp_path: Path):
    result = backtest.run(backtest_db, tmp_path / "pub")
    report = result.report

    assert report["passed_all"] is True
    assert report["failures"] == []
    assert report["advisory_failures"] == []  # only Cantharellus has test finds here
    assert report["gate"]["week_matched_tolerance"] == backtest.WEEK_MATCHED_TOLERANCE

    kantarel = next(s for s in report["species"] if s["slug"] == "cantharellus-cibarius")
    assert kantarel["skipped"] is False
    assert kantarel["tier"] == "core"
    assert kantarel["passed"] is True
    wm, cr = kantarel["week_matched"], kantarel["calendar_random"]
    # habitat alone is a strong spatial ranker; season/weather don't help there ...
    assert wm["auc_full"] >= wm["auc_baseline"] - backtest.WEEK_MATCHED_TOLERANCE
    # ... but do help once the date is free
    assert cr["auc_full"] >= cr["auc_baseline"] + backtest.CALENDAR_RANDOM_MARGIN

    # the geometric-mean value spread over the held-out finds (ADR-0008)
    pct = kantarel["positive_score_percentiles"]
    assert pct["p10"] <= pct["p50"] <= pct["p90"] <= pct["max"] <= 100

    assert "cantharellus-cibarius" in result.calibrators
    assert (tmp_path / "pub" / "model" / "backtest.json").exists()


def test_extra_tier_gate_failure_is_advisory_not_blocking(
    backtest_db: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(
        backtest,
        "published_species",
        lambda: [{"scientific_name": "Cantharellus cibarius", "tier": "extra"}],
    )
    monkeypatch.setattr(backtest, "_gate", lambda week, cal: (False, "forced"))

    report = backtest.run(backtest_db).report
    assert report["failures"] == []
    assert report["passed_all"] is True
    assert report["advisory_failures"] == ["cantharellus-cibarius"]
    entry = next(s for s in report["species"] if s["slug"] == "cantharellus-cibarius")
    assert entry["tier"] == "extra"
    assert entry["passed"] is False


def test_species_without_test_finds_are_skipped(backtest_db: Path):
    report = backtest.run(backtest_db).report
    boletus = next(s for s in report["species"] if s["slug"] == "boletus-edulis")
    assert boletus["skipped"] is True
    assert boletus["n_test_positives"] == 0


def test_missing_inputs(tmp_path: Path):
    empty = tmp_path / "empty.duckdb"
    duckdb.connect(str(empty)).close()
    with pytest.raises(SystemExit):
        backtest.run(empty)
    assert backtest.run(empty, strict=False).report == {"available": False}
