"""Tests for the golden-location gate (pipeline/model/golden.py).

These exercise the gate logic on synthetic models; the real-data check runs
inside ``pipeline.model.fit`` as a build gate.
"""

from __future__ import annotations

from pipeline.model import golden
from pipeline.model.habitat import HabitatModel
from pipeline.model.seasonality import SeasonalityModel
from pipeline.model.species_model import SpeciesModel

PEAK_DOY = 245
FAR_AWAY = [(11.6, 55.0)]  # Kiel Bay, well clear of all three golden forests


def _grid(centre: tuple[float, float]) -> list[tuple[float, float]]:
    # a ~4 km cluster; 225 points keeps each centre above golden.MIN_CORPUS
    lon, lat = centre
    return [(lon + i * 0.004, lat + j * 0.004) for i in range(15) for j in range(15)]


def _model(centres: list[tuple[float, float]], *, seasonal: bool) -> SpeciesModel:
    points = [pt for centre in centres for pt in _grid(centre)]
    days = [PEAK_DOY] * 20 if seasonal else list(range(1, 366, 5))  # flat curve if not seasonal
    return SpeciesModel(
        slug="cantharellus-cibarius",
        habitat=HabitatModel.fit(points),
        seasonality=SeasonalityModel.fit(days, sigma_days=15),
    )


FOREST_CENTRES = list(golden.FORESTS.values())


def test_golden_passes_for_a_model_peaked_on_the_forests():
    model = _model(FOREST_CENTRES, seasonal=True)
    report = golden.run({"cantharellus-cibarius": model})

    assert report["passed"] is True
    assert report["failures"] == []

    rold = next(c for c in report["cases"] if c["place"] == "Rold Skov")
    assert rold["peak"] >= golden.PEAK_FLOOR
    assert rold["peak"] - rold["winter"] >= golden.SEASON_DROP

    sea = next(c for c in report["cases"] if c["place"] == "North Sea")
    assert sea["kind"] == "negative"
    assert sea["peak"] <= golden.OFFSHORE_CEIL


def test_golden_fails_when_the_forest_scores_low():
    model = _model(FAR_AWAY, seasonal=True)  # nowhere near the golden forests
    report = golden.run({"cantharellus-cibarius": model})

    assert report["passed"] is False
    assert any("cantharellus-cibarius @ Rold Skov" in f for f in report["failures"])


def test_golden_fails_without_a_seasonal_drop():
    model = _model(FOREST_CENTRES, seasonal=False)  # flat curve
    report = golden.run({"cantharellus-cibarius": model})

    assert report["passed"] is False
    rold = next(c for c in report["cases"] if c["place"] == "Rold Skov")
    assert rold["peak"] >= golden.PEAK_FLOOR  # still a hotspot spatially ...
    assert rold["peak"] - rold["winter"] < golden.SEASON_DROP  # ... but no timing signal


def test_golden_ignores_species_it_has_no_anchor_for():
    # empty input, and slugs outside POSITIVES, both yield a clean pass
    assert golden.run({})["passed"] is True
    assert golden.run({})["cases"] == []
    assert "suillus-variegatus" not in golden.POSITIVES
