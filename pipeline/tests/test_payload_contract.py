"""The published payload is an implicit contract with the web app: it hand-codes
these shapes in ``web/src/types.ts``, ``web/src/model.ts`` and the port in
``web/src/score.ts`` / ``rank.ts``.

If a key here is renamed, moved or retyped, update those files too -- this test
is the tripwire. It builds a small payload end to end and checks every file's
shape.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import duckdb
import pytest

from pipeline.derive.observation_weather import run as derive_weather
from pipeline.ingest.svampeatlas import run as ingest_svampeatlas
from pipeline.model.fit import run as fit_model
from pipeline.publish.site import run as publish_site
from pipeline.species import published_species

LOOKALIKE = {"low", "medium", "high"}
WEATHER_FEATURE_KEYS = {
    "precip_14d_mm",
    "precip_30d_mm",
    "mean_temp_14d_c",
    "dry_days_30d",
    "precip_60d_mm",
    "prior_summer_precip_mm",
}


@pytest.fixture
def payload(tmp_path: Path, tiny_dwca: Path) -> Path:
    db = tmp_path / "contract.duckdb"
    ingest_svampeatlas(tiny_dwca, db)

    rows = []
    for days_before in range(1, 41):  # 40 days ending 2021-08-14
        day = date(2021, 8, 15) - timedelta(days=days_before)
        rows.append(("c", day, "acc_precip", 3.0, 9.5, 56.2))
        rows.append(("c", day, "mean_temp", 13.0, 9.5, 56.2))
    con = duckdb.connect(str(db))
    try:
        con.execute(
            "CREATE TABLE weather_daily (cell_id TEXT, date DATE, parameter TEXT, "
            "value DOUBLE, cell_lon DOUBLE, cell_lat DOUBLE)"
        )
        con.executemany("INSERT INTO weather_daily VALUES (?, ?, ?, ?, ?, ?)", rows)
    finally:
        con.close()

    derive_weather(db)
    out = tmp_path / "publish"
    fit_model(db, out)
    publish_site(db, out)
    return out


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


# --------------------------------------------------------------------------- #
# manifest.json  ->  web/src/types.ts  (Manifest, SpeciesSummary, Attribution)
# --------------------------------------------------------------------------- #
def test_manifest_shape(payload: Path):
    manifest = _load(payload / "manifest.json")
    assert set(manifest) == {
        "version",
        "bbox",
        "attribution",
        "species",
        "forests",
        "forest_outlines",
    }
    assert isinstance(manifest["version"], str)
    assert isinstance(manifest["bbox"], list) and len(manifest["bbox"]) == 4
    assert set(manifest["attribution"]) == {
        "observations",
        "weather",
        "basemap",
        "redlist",
        "photos",
        "forests",
    }
    assert all(isinstance(v, str) for v in manifest["attribution"].values())
    assert manifest["forests"] is None or isinstance(manifest["forests"], str)
    # null: no outlines published, the app decides from the forest points alone
    assert manifest["forest_outlines"] is None or isinstance(manifest["forest_outlines"], list)

    assert len(manifest["species"]) == len(published_species())
    for entry in manifest["species"]:
        assert set(entry) == {
            "slug",
            "danish_name",
            "scientific_name",
            "group",
            "tier",
            "score_validated",
            "observation_count",
            "season_by_month",
            "thumbnail",
            "file",
        }
        assert entry["tier"] in {"core", "extra"}
        assert entry["score_validated"] == (entry["tier"] == "core")
        assert isinstance(entry["observation_count"], int)
        assert len(entry["season_by_month"]) == 12
        assert all(isinstance(n, int) for n in entry["season_by_month"])
        assert sum(entry["season_by_month"]) == entry["observation_count"]
        assert entry["thumbnail"] is None or entry["thumbnail"].startswith("https://")
        # the manifest summary must agree with the species file it points at
        doc = _load(payload / entry["file"])
        assert entry["season_by_month"] == doc["season_by_month"]
        assert (entry["thumbnail"] is None) == (not doc["images"])
        assert entry["file"] == f"species/{entry['slug']}.json"


# --------------------------------------------------------------------------- #
# species/<slug>.json  ->  web/src/types.ts  (SpeciesDoc, SpeciesImage)
# --------------------------------------------------------------------------- #
def test_species_doc_shape(payload: Path):
    for entry in _load(payload / "manifest.json")["species"]:
        doc = _load(payload / entry["file"])
        assert set(doc) == {
            "slug",
            "danish_name",
            "scientific_name",
            "group",
            "tier",
            "score_validated",
            "edible",
            "lookalike_risk",
            "gbif_usage_key",
            "redlist_category",
            "description",
            "images",
            "observation_count",
            "season_by_month",
            "observations",
        }
        assert doc["tier"] in {"core", "extra"}
        assert doc["score_validated"] == (doc["tier"] == "core")
        assert isinstance(doc["edible"], bool)
        assert doc["lookalike_risk"] in LOOKALIKE
        assert isinstance(doc["gbif_usage_key"], int)
        assert doc["redlist_category"] is None or isinstance(doc["redlist_category"], str)
        assert doc["description"] is None or isinstance(doc["description"], str)
        assert len(doc["season_by_month"]) == 12
        assert doc["observation_count"] == len(doc["observations"])
        for point in doc["observations"]:
            assert len(point) == 3
            assert _is_number(point[0]) and _is_number(point[1])
            assert isinstance(point[2], int) and 1 <= point[2] <= 12
        for image in doc["images"]:
            assert set(image) == {"url", "credit", "license", "source", "link"}


# --------------------------------------------------------------------------- #
# model/manifest.json  ->  web/src/model.ts  (ModelManifest, ModelManifestEntry)
# --------------------------------------------------------------------------- #
def test_model_manifest_shape(payload: Path):
    manifest = _load(payload / "model" / "manifest.json")
    for key in ("version", "weather_features", "current_conditions", "species"):
        assert key in manifest
    assert isinstance(manifest["weather_features"], list)
    assert set(manifest["weather_features"]) == WEATHER_FEATURE_KEYS
    assert manifest["current_conditions"] == "model/current.json"

    assert len(manifest["species"]) == len(published_species())
    for entry in manifest["species"]:
        assert {
            "slug",
            "file",
            "bandwidth_km",
            "weather_fitted",
            "biotope_fitted",
            "effort_corrected",
            "host_tree_fitted",
            "host_tree_scored",
        } <= set(entry)
        assert _is_number(entry["bandwidth_km"])
        assert isinstance(entry["weather_fitted"], bool)
        assert isinstance(entry["biotope_fitted"], bool)
        assert isinstance(entry["effort_corrected"], bool)
        assert isinstance(entry["host_tree_fitted"], bool)
        assert entry["file"] == f"model/{entry['slug']}.json"


# --------------------------------------------------------------------------- #
# model/<slug>.json  ->  web/src/model.ts (SpeciesModel) + score.ts port
# --------------------------------------------------------------------------- #
def test_species_model_shape(payload: Path):
    for entry in _load(payload / "model" / "manifest.json")["species"]:
        doc = _load(payload / entry["file"])
        assert set(doc) == {
            "slug",
            "habitat",
            "seasonality",
            "weather",
            "host_tree",
            "host_tree_scored",
            "biotope",
            "calibration",
            "fit",
        }

        assert set(doc["habitat"]) == {"bandwidth_km", "raw_ref", "ratio_ref"}
        assert _is_number(doc["habitat"]["bandwidth_km"])
        assert _is_number(doc["habitat"]["raw_ref"])
        # this fixture never builds a recording_effort_grid table either
        assert doc["habitat"]["ratio_ref"] is None

        assert set(doc["seasonality"]) == {"sigma_days", "curve"}
        assert len(doc["seasonality"]["curve"]) == 366
        assert all(_is_number(v) for v in doc["seasonality"]["curve"])

        weather = doc["weather"]
        assert weather is None or set(weather) == {"n_observations", "features"}
        if weather and weather["features"] is not None:
            for stat in weather["features"].values():
                assert set(stat) == {"mean", "sd"}

        # this fixture never builds a biotope_grid table, so every model is fit
        # without one; the shape when it is fitted is covered in test_model.py
        assert doc["biotope"] is None

        # nor a host_tree_grid table, so every model is fit without one too
        assert doc["host_tree"] is None
        assert isinstance(doc["host_tree_scored"], bool)

        calibration = doc["calibration"]
        assert calibration is None or set(calibration) == {"x", "y"}

        assert set(doc["fit"]) == {
            "n_observations",
            "locality_spacing_km",
            "weather_fitted",
            "biotope_fitted",
            "effort_corrected",
            "host_tree_fitted",
            "host_tree_scored",
            "calibrated",
        }


# --------------------------------------------------------------------------- #
# model/current.json  ->  web/src/model.ts (CurrentConditions, CurrentCell)
# --------------------------------------------------------------------------- #
def test_current_conditions_shape(payload: Path):
    current = _load(payload / "model" / "current.json")
    for key in ("as_of", "window_days", "features", "cells"):
        assert key in current
    assert isinstance(current["as_of"], str)
    assert current["cells"], "expected at least one covered cell"

    for cell in current["cells"]:
        assert {"cell_id", "lon", "lat", "precip_days_covered"} <= set(cell)
        assert set(cell) >= WEATHER_FEATURE_KEYS
        assert _is_number(cell["lon"]) and _is_number(cell["lat"])
        assert isinstance(cell["precip_days_covered"], int)
