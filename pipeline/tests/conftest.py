"""Shared test fixtures."""

from __future__ import annotations

import zipfile
from datetime import date, timedelta
from pathlib import Path

import duckdb
import pytest

from pipeline import species

TRACKED_SCOPE_FILE = species.SCOPE_FILE


@pytest.fixture(autouse=True)
def _ignore_curated_scope(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests run against every candidate species, whatever the curated scope in
    data/species_scope.json currently excludes -- otherwise a fixture built
    around a species would start failing the day that species is switched off."""
    monkeypatch.setattr(species, "SCOPE_FILE", tmp_path / "no-scope.json")


_META_XML = """<?xml version="1.0" encoding="UTF-8"?>
<archive xmlns="http://rs.tdwg.org/dwc/text/">
  <core encoding="UTF-8" fieldsTerminatedBy="\\t" linesTerminatedBy="\\n"
        ignoreHeaderLines="0" rowType="http://rs.tdwg.org/dwc/terms/Occurrence">
    <files><location>occurrence.txt</location></files>
    <id index="0"/>
    <field index="0" term="http://rs.tdwg.org/dwc/terms/occurrenceID"/>
    <field index="1" term="http://rs.tdwg.org/dwc/terms/scientificName"/>
    <field index="2" term="http://rs.tdwg.org/dwc/terms/taxonRank"/>
    <field index="3" term="http://rs.tdwg.org/dwc/terms/eventDate"/>
    <field index="4" term="http://rs.tdwg.org/dwc/terms/decimalLatitude"/>
    <field index="5" term="http://rs.tdwg.org/dwc/terms/decimalLongitude"/>
    <field index="6" term="http://rs.tdwg.org/dwc/terms/coordinateUncertaintyInMeters"/>
    <field index="7" term="http://rs.tdwg.org/dwc/terms/license"/>
    <field index="8" term="http://rs.tdwg.org/dwc/terms/recordedBy"/>
    <field index="9" term="http://rs.tdwg.org/dwc/terms/informationWithheld"/>
  </core>
</archive>
"""

_NC = "https://creativecommons.org/licenses/by-nc/4.0/"

# Columns: occurrenceID, scientificName, taxonRank, eventDate, lat, lon,
# coordinateUncertaintyInMeters, license (the token LIC below), recordedBy,
# informationWithheld. Tab-separated. SA:1, SA:2 and SA:9 are the keepers.
_TABLE = """\
SA:1\tCantharellus cibarius Fr.\tsp.\t2021-08-15\t56.2\t9.5\t50\tLIC\tJens\t
SA:2\tBoletus edulis Bull.\tsp.\t2020-09-01/2020-09-02\t57.0\t10.0\t100\tLIC\tIda\t
SA:3\tCantharellus cibarius\tsp.\t2021-09-10\t53.50\t10.00\t25\tLIC\tOle\t
SA:4\tBoletus edulis\tsp.\t2019-08-20\t56.5\t9.8\t9000\tLIC\tPer\t
SA:5\tAmanita muscaria\tsp.\t2021-09-15\t56.3\t9.6\t30\tLIC\tKim\t
SA:6\tCantharellus cibarius var. pallidus\tvar.\t2021-08-10\t56.1\t9.4\t40\tLIC\tLiv\t
SA:7\tImleria badia\tsp.\t2021\t56.4\t9.7\t60\tLIC\tSten\t
SA:8\tCraterellus tubaeformis\tsp.\t2021-10-05\t56.6\t9.9\t70\tLIC\tMai\tOccurrence blurred
SA:9\tCantharellus tubaeformis\tsp.\t2022-10-01\t56.7\t9.2\t80\tLIC\tBo\t
SA:10\tBoletus edulis\tsp.\t2021-08-01\t\t\t40\tLIC\tAnn\t
"""

KEPT_IDS = {"SA:1", "SA:2", "SA:9"}  # SA:9 is a synonym of Craterellus tubaeformis


@pytest.fixture
def tiny_dwca(tmp_path: Path) -> Path:
    """A minimal Darwin Core Archive zip covering each accept/reject path."""
    body = _TABLE.replace("\tLIC\t", f"\t{_NC}\t")
    archive_path = tmp_path / "tiny_dwca.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("meta.xml", _META_XML)
        zf.writestr("occurrence.txt", body)
    return archive_path


@pytest.fixture
def ingested_db(tmp_path: Path, tiny_dwca: Path) -> Path:
    """A DuckDB with `species`/`observations` from the tiny archive plus synthetic
    `weather_daily`: a near cell with 5 mm/15 C every day for the 30 days before
    SA:1 (2021-08-15), and a far cell with different values. SA:2 and SA:9 get no
    weather."""
    from pipeline.ingest.svampeatlas import run as ingest_svampeatlas

    db_path = tmp_path / "ingested.duckdb"
    ingest_svampeatlas(tiny_dwca, db_path)

    rows = []
    for days_before in range(1, 31):
        day = date(2021, 8, 15) - timedelta(days=days_before)
        rows += [
            ("near", day, "acc_precip", 5.0, 9.51, 56.21),
            ("near", day, "mean_temp", 15.0, 9.51, 56.21),
            ("far", day, "acc_precip", 99.0, 12.0, 55.0),
            ("far", day, "mean_temp", 30.0, 12.0, 55.0),
        ]

    con = duckdb.connect(str(db_path))
    try:
        con.execute(
            "CREATE TABLE weather_daily (cell_id TEXT, date DATE, parameter TEXT, "
            "value DOUBLE, cell_lon DOUBLE, cell_lat DOUBLE, "
            "PRIMARY KEY (cell_id, date, parameter))"
        )
        con.executemany("INSERT INTO weather_daily VALUES (?, ?, ?, ?, ?, ?)", rows)
    finally:
        con.close()
    return db_path
