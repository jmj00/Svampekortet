from pathlib import Path

import duckdb
import pytest

import pipeline.ingest.redlist as redlist_ingest
from pipeline.ingest.redlist import run
from pipeline.redlist import hidden_scientific_names, is_hidden, normalise


def test_normalise():
    record = normalise(
        {
            "scientificName": " Cantharellus cibarius ",
            "vernacularName": "almindelig kantarel",
            "redlistCategory": "lc",
            "overallSpeciesGroup": "Svampe",
            "taxonId": 42,
            "arterDkId": "867c11f4-f785-ea11-aa77-501ac539d1ea",
        }
    )
    assert record["scientific_name"] == "Cantharellus cibarius"
    assert record["category"] == "LC"
    assert record["taxon_id"] == "42"  # coerced to str; the API also returns UUIDs
    assert record["arter_dk_id"] == "867c11f4-f785-ea11-aa77-501ac539d1ea"


@pytest.mark.parametrize(
    ("category", "hidden"),
    [
        ("RE", True),
        ("CR", True),
        ("EN", True),
        ("VU", True),
        ("NT", True),
        ("DD", False),
        ("LC", False),
        ("lc", False),
        ("NA", False),
        ("", False),
    ],
)
def test_is_hidden(category, hidden):
    assert is_hidden(category) is hidden


def test_hidden_scientific_names():
    assessments = [
        {"scientific_name": "Boletus edulis", "category": "LC"},
        {"scientific_name": "Rare fungus", "category": "EN"},
        {"scientific_name": "Data poor fungus", "category": "DD"},
    ]
    assert hidden_scientific_names(assessments) == {"rare fungus"}


def _assessment(name: str, category: str) -> dict:
    return {
        "scientific_name": name,
        "vernacular_name": None,
        "category": category,
        "overall_group": "Svampe",
        "taxon_id": None,
        "arter_dk_id": None,
    }


def test_run_loads_table_and_passes_guard(tmp_path: Path):
    db = tmp_path / "rl.duckdb"
    report = run(
        db,
        assessments=[
            _assessment("Cantharellus cibarius", "LC"),
            _assessment("Boletus edulis", "LC"),
            _assessment("Some rarity", "VU"),
        ],
    )
    assert report["assessed"] == 3
    assert report["hidden"] == 1
    assert report["target_species_hidden"] == []
    assert report["target_species"]["Cantharellus cibarius"] == "LC"
    assert report["target_species"]["Suillus luteus"] == "not assessed"

    con = duckdb.connect(str(db))
    try:
        assert con.execute("SELECT count(*) FROM redlist WHERE hidden").fetchone()[0] == 1
    finally:
        con.close()


def test_run_flags_a_red_listed_target(tmp_path: Path):
    report = run(
        tmp_path / "rl.duckdb",
        assessments=[_assessment("Cantharellus cibarius", "EN")],
    )
    assert report["target_species_hidden"] == [
        {"scientific_name": "Cantharellus cibarius", "category": "EN"}
    ]


def _boom():
    raise RuntimeError("GET ... failed after 4 attempts: <urlopen error timed out>")


def test_run_keeps_the_cached_table_when_the_api_is_down(tmp_path: Path, monkeypatch):
    db = tmp_path / "rl.duckdb"
    run(
        db,
        assessments=[
            _assessment("Cantharellus cibarius", "LC"),
            _assessment("Some rarity", "VU"),
        ],
    )

    monkeypatch.setattr(redlist_ingest, "iter_assessments", _boom)
    report = run(db)  # API path now raises; must fall back to the table

    assert report["source"] == "cached"
    assert report["assessed"] == 2
    assert report["hidden"] == 1
    assert report["target_species"]["Cantharellus cibarius"] == "LC"
    con = duckdb.connect(str(db))
    try:
        assert con.execute("SELECT count(*) FROM redlist").fetchone()[0] == 2
    finally:
        con.close()


def test_run_reraises_when_the_api_is_down_and_no_cache(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(redlist_ingest, "iter_assessments", _boom)
    with pytest.raises(RuntimeError):
        run(tmp_path / "cold.duckdb")
