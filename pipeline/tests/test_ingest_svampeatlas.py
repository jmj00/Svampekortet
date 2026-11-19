from datetime import date
from pathlib import Path

import duckdb
import pytest

from pipeline.ingest.svampeatlas import (
    classify,
    match_species,
    parse_event_date,
    parse_float,
    run,
)

from .conftest import KEPT_IDS


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Boletus edulis Bull.", "Boletus edulis"),
        ("Boletus edulis", "Boletus edulis"),
        ("Cantharellus tubaeformis", "Craterellus tubaeformis"),  # synonym
        ("Boletus badius", "Imleria badia"),  # synonym
        ("Amanita muscaria", None),
        ("Boletus", None),
    ],
)
def test_match_species(name, expected):
    result = match_species(name)
    assert (result["scientific_name"] if result else None) == expected


def test_parse_event_date():
    assert parse_event_date("2021-08-15") == date(2021, 8, 15)
    assert parse_event_date("2021-08-15/2021-08-16") == date(2021, 8, 15)
    assert parse_event_date("2021-08") is None
    assert parse_event_date("2021") is None
    assert parse_event_date("") is None


def test_parse_float():
    assert parse_float("50") == 50.0
    assert parse_float("50,5") == 50.5
    assert parse_float("  12 ") == 12.0
    assert parse_float("") is None
    assert parse_float(None) is None


def _classify_archive(archive_path: Path):
    from pipeline.dwca import DwcArchive

    kept, reasons = {}, {}
    with DwcArchive(archive_path) as archive:
        for record in archive.iter_core():
            observation, reason = classify(record)
            if observation is None:
                reasons[record["occurrenceID"]] = reason
            else:
                kept[observation.observation_id] = observation
    return kept, reasons


def test_classify_keeps_and_rejects_the_right_rows(tiny_dwca: Path):
    kept, reasons = _classify_archive(tiny_dwca)

    assert set(kept) == KEPT_IDS
    assert kept["SA:9"].scientific_name == "Craterellus tubaeformis"
    assert kept["SA:2"].observed_on == date(2020, 9, 1)

    assert reasons["SA:3"] == "outside Denmark"
    assert reasons["SA:4"] == "coordinate uncertainty too high"
    assert reasons["SA:5"] == "not a target species"
    assert reasons["SA:6"].startswith("rank ")
    assert reasons["SA:7"] == "no usable date"
    assert reasons["SA:8"] == "withheld/generalized"
    assert reasons["SA:10"] == "no coordinates"


def test_run_loads_duckdb_and_reports(tiny_dwca: Path, tmp_path: Path):
    db_path = tmp_path / "out.duckdb"
    report = run(tiny_dwca, db_path)

    assert report["kept"] == 3
    assert report["rows_scanned"] == 10
    assert report["rejected_by_reason"]["not a target species"] == 1
    assert report["kept_by_species"]["Cantharellus cibarius"] == 1
    # fixture is tiny, so every core species is under the minimum
    assert "Boletus edulis" in report["species_below_min"]

    con = duckdb.connect(str(db_path))
    try:
        assert con.execute("SELECT count(*) FROM observations").fetchone()[0] == 3
        assert con.execute("SELECT count(*) FROM species").fetchone()[0] == len(
            report["kept_by_species"]
        )
        # FK integrity: every observation references a known species
        orphans = con.execute(
            "SELECT count(*) FROM observations o "
            "LEFT JOIN species s USING (scientific_name) WHERE s.scientific_name IS NULL"
        ).fetchone()[0]
        assert orphans == 0
    finally:
        con.close()
