from datetime import date, timedelta
from pathlib import Path

import duckdb
import pytest

from pipeline import build
from pipeline.ingest import dmi as ingest_dmi
from pipeline.ingest import redlist as ingest_redlist
from pipeline.ingest import svampeatlas as ingest_svampeatlas


def _weather_rows() -> list[dict]:
    rows = []
    for days_before in range(1, 31):
        day = date(2021, 8, 15) - timedelta(days=days_before)
        for parameter, value in (("acc_precip", 4.0), ("mean_temp", 14.0)):
            rows.append(
                {
                    "cell_id": "c",
                    "date": day,
                    "parameter": parameter,
                    "value": value,
                    "cell_lon": 9.5,
                    "cell_lat": 56.2,
                }
            )
    return rows


def _assessment(name: str, category: str) -> dict:
    return {
        "scientific_name": name,
        "vernacular_name": None,
        "category": category,
        "overall_group": "Svampe",
        "taxon_id": None,
        "arter_dk_id": None,
    }


@pytest.fixture
def stub_network(monkeypatch, tiny_dwca: Path) -> Path:
    """Replace the two network-calling ingest inputs with fixtures; returns the archive."""
    rows = _weather_rows()

    def fake_iter_daily(parameter: str, year: int, _bbox) -> list[dict]:
        return [r for r in rows if r["parameter"] == parameter] if year == 2021 else []

    monkeypatch.setattr(ingest_dmi, "iter_daily", fake_iter_daily)
    monkeypatch.setattr(
        ingest_redlist, "iter_assessments", lambda: [_assessment("Cantharellus cibarius", "LC")]
    )
    # the tiny archive has only a handful of rows; don't trip the thin-species guard
    monkeypatch.setattr(ingest_svampeatlas, "MIN_PER_SPECIES", 0)
    return tiny_dwca


def test_build_runs_all_steps(stub_network: Path, tmp_path: Path):
    db = tmp_path / "b.duckdb"
    result = build.run(
        stub_network, db, dmi_from_year=2021, dmi_to_year=2021, publish_dir=tmp_path / "pub"
    )

    assert set(result["steps"]) == {
        "svampeatlas",
        "dmi",
        "redlist",
        "observation_weather",
        "model",
        "publish",
    }
    assert result["failures"] == []
    assert (tmp_path / "pub" / "manifest.json").exists()
    assert (tmp_path / "pub" / "model" / "manifest.json").exists()

    con = duckdb.connect(str(db))
    try:
        tables = {r[0] for r in con.execute("SHOW TABLES").fetchall()}
    finally:
        con.close()
    assert {"species", "observations", "weather_daily", "redlist", "observation_weather"} <= tables


def test_build_skip_dmi_and_publish(stub_network: Path, tmp_path: Path):
    db = tmp_path / "b.duckdb"
    build.run(stub_network, db, dmi_from_year=2021, dmi_to_year=2021, publish_dir=tmp_path / "pub")
    result = build.run(stub_network, db, skip_dmi=True, skip_model=True, skip_publish=True)
    assert "dmi" not in result["steps"]
    assert "model" not in result["steps"]
    assert "publish" not in result["steps"]
    assert result["failures"] == []


def test_build_dmi_incremental_keeps_other_years(stub_network: Path, tmp_path: Path):
    db = tmp_path / "b.duckdb"
    build.run(stub_network, db, dmi_from_year=2021, dmi_to_year=2021, publish_dir=tmp_path / "pub")
    # a second run for a different year must not wipe 2021 (no --dmi-fresh)
    build.run(stub_network, db, dmi_from_year=2022, dmi_to_year=2022, publish_dir=tmp_path / "pub")

    con = duckdb.connect(str(db))
    try:
        rows = con.execute("SELECT DISTINCT year(date) FROM weather_daily").fetchall()
    finally:
        con.close()
    assert {r[0] for r in rows} == {2021}  # 2021 survived a run for 2022


def test_build_flags_red_listed_target(monkeypatch, stub_network: Path, tmp_path: Path):
    monkeypatch.setattr(
        ingest_redlist, "iter_assessments", lambda: [_assessment("Boletus edulis", "EN")]
    )
    result = build.run(
        stub_network,
        tmp_path / "b.duckdb",
        dmi_from_year=2021,
        dmi_to_year=2021,
        publish_dir=tmp_path / "pub",
    )
    assert any("red-listed" in failure for failure in result["failures"])
