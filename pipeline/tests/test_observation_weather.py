from pathlib import Path

import duckdb
import pytest

from pipeline.derive.observation_weather import run


def test_report_counts(ingested_db: Path):
    report = run(ingested_db)
    assert report["observations"] == 3
    assert report["with_full_window"] == 1  # only SA:1 has weather
    assert report["without_full_window"] == 2


def test_features_for_covered_observation(ingested_db: Path):
    run(ingested_db)
    con = duckdb.connect(str(ingested_db))
    try:
        row = con.execute(
            "SELECT cell_id, precip_7d_mm, precip_14d_mm, precip_30d_mm, "
            "mean_temp_30d_c, dry_days_30d, precip_days_covered "
            "FROM observation_weather WHERE observation_id = 'SA:1'"
        ).fetchone()
    finally:
        con.close()

    cell_id, p7, p14, p30, t30, dry, covered = row
    assert cell_id == "near"  # nearest cell wins over the far one
    assert p7 == pytest.approx(35.0)  # 7 days x 5 mm
    assert p14 == pytest.approx(70.0)
    assert p30 == pytest.approx(150.0)
    assert t30 == pytest.approx(15.0)
    assert dry == 0
    assert covered == 30


def test_observation_without_weather_is_null(ingested_db: Path):
    run(ingested_db)
    con = duckdb.connect(str(ingested_db))
    try:
        p30, covered = con.execute(
            "SELECT precip_30d_mm, precip_days_covered "
            "FROM observation_weather WHERE observation_id = 'SA:2'"
        ).fetchone()
    finally:
        con.close()
    assert p30 is None
    assert covered == 0


def test_missing_tables_fail_fast(tmp_path: Path):
    empty = tmp_path / "empty.duckdb"
    duckdb.connect(str(empty)).close()
    with pytest.raises(SystemExit):
        run(empty)
