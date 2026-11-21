"""Tests for the v0 conditions model: kernel maths, the per-term models, the
combiner, and the fit/publish step. Includes the ADR-0006 property tests
(score rises with nearby finds, drops off-season, drops under drought)."""

from __future__ import annotations

import json
import math
from datetime import date, timedelta
from pathlib import Path

import duckdb
import pytest

from pipeline.model import current
from pipeline.model.biotope import BiotopeGrid, BiotopeModel, CategoryAffinity
from pipeline.model.fit import run as fit_run
from pipeline.model.habitat import (
    DENSITY_GRID_DEG,
    MAX_BANDWIDTH_KM,
    MIN_BANDWIDTH_KM,
    HabitatModel,
    _dedupe,
)
from pipeline.model.host_tree import HOST_TREE_SPECIES, HostTreeGrid, HostTreeModel
from pipeline.model.kernels import (
    circular_delta_days,
    gaussian,
    haversine_km,
    quantile,
    subsample,
)
from pipeline.model.recording_effort import MIN_EFFORT_TO_CORRECT, EffortGrid
from pipeline.model.seasonality import SeasonalityModel
from pipeline.model.species_model import SpeciesModel, combine, confidence_band
from pipeline.model.weather import (
    MIN_WEATHER_OBSERVATIONS,
    WEATHER_FEATURES,
    WeatherModel,
    build_feature_dict,
    coverage_column_and_threshold,
)

# --- a compact cluster of finds used across the habitat / combiner tests -------
CLUSTER_LON, CLUSTER_LAT = 9.60, 56.30
CLUSTER = [
    (CLUSTER_LON + i * 0.002, CLUSTER_LAT + j * 0.002) for i in range(6) for j in range(5)
]  # 30 points spanning ~0.6 x 0.9 km
FAR_AWAY = (10.40, 56.30)  # ~50 km east


# --------------------------------------------------------------------------- #
# kernels                                                                      #
# --------------------------------------------------------------------------- #
def test_haversine_one_degree_latitude():
    assert haversine_km(56.0, 9.0, 57.0, 9.0) == pytest.approx(111.19, abs=0.1)
    assert haversine_km(56.0, 9.0, 56.0, 9.0) == 0.0


def test_gaussian_peak_and_decay():
    assert gaussian(0.0, 3.0) == 1.0
    assert gaussian(1.0, 3.0) > gaussian(2.0, 3.0) > gaussian(5.0, 3.0)
    assert 0.0 < gaussian(10.0, 3.0) < 0.01
    with pytest.raises(ValueError):
        gaussian(1.0, 0.0)


def test_circular_delta_days_wraps():
    assert circular_delta_days(1, 366) == 1
    assert circular_delta_days(10, 20) == 10
    assert circular_delta_days(200, 10) == 176
    assert circular_delta_days(5, 5) == 0
    assert circular_delta_days(1, 183) == circular_delta_days(183, 1)


def test_quantile():
    assert quantile([10], 0.5) == 10
    assert quantile([4, 1, 3, 2], 0.5) == pytest.approx(2.5)
    assert quantile([1, 2, 3, 4, 5], 0.0) == 1
    assert quantile([1, 2, 3, 4, 5], 1.0) == 5
    with pytest.raises(ValueError):
        quantile([], 0.5)


def test_subsample_is_deterministic_and_capped():
    assert list(subsample(range(5), 10)) == [0, 1, 2, 3, 4]
    picked = subsample(list(range(100)), 10)
    assert picked == list(range(0, 100, 10))
    assert len(subsample(list(range(1000)), 50)) == 50


# --------------------------------------------------------------------------- #
# habitat                                                                      #
# --------------------------------------------------------------------------- #
def test_habitat_fit_clamps_bandwidth_for_a_tight_cluster():
    model = HabitatModel.fit(CLUSTER)
    assert model.bandwidth_km == MIN_BANDWIDTH_KM  # locality spacing << the floor
    assert model.raw_ref > 0
    assert MIN_BANDWIDTH_KM <= model.bandwidth_km <= MAX_BANDWIDTH_KM


def test_habitat_bandwidth_scales_with_locality_spacing():
    # localities ~2 km apart along a line -> bandwidth lifts well off the floor
    spread = [(9.5 + i * 0.03, 56.3) for i in range(12)]
    model = HabitatModel.fit(spread)
    assert model.spacing_km is not None and model.spacing_km > 3.0
    assert MIN_BANDWIDTH_KM < model.bandwidth_km < MAX_BANDWIDTH_KM


def test_habitat_bandwidth_ignores_revisited_spots():
    # one real locality visited 200 times + three more ~4 km away: the 200
    # coincident points must not drag the spacing to zero
    base = [(9.60, 56.30)] * 200
    others = [(9.66, 56.30), (9.72, 56.30), (9.78, 56.30)]
    model = HabitatModel.fit(base + others)
    assert model.bandwidth_km > MIN_BANDWIDTH_KM


def test_habitat_scores_high_inside_the_cluster_and_near_zero_far_off():
    model = HabitatModel.fit(CLUSTER)
    assert model.score(CLUSTER_LON + 0.004, CLUSTER_LAT + 0.004) >= 0.5
    assert model.score(*FAR_AWAY) <= 0.01


def test_habitat_empty_and_single_point():
    empty = HabitatModel.fit([])
    assert empty.raw_ref == 0.0
    assert empty.score(CLUSTER_LON, CLUSTER_LAT) == 0.0

    one = HabitatModel.fit([(CLUSTER_LON, CLUSTER_LAT)])
    assert one.raw_ref == 1.0
    assert one.score(CLUSTER_LON, CLUSTER_LAT) == pytest.approx(1.0)
    assert one.score(*FAR_AWAY) <= 0.01


def test_habitat_raw_rises_with_a_find_in_a_new_locality():
    # ADR-0006 property test, adapted for ADR-0011: the KDE runs over deduped
    # ~660 m localities, so a find in a *new* cell raises the pre-normalised
    # density. Bandwidth pinned so only the locality set varies.
    query = (9.612, 56.30)  # ~0.7 km east of the cluster edge
    locs = tuple(_dedupe(CLUSTER, DENSITY_GRID_DEG))
    sparse = HabitatModel(MIN_BANDWIDTH_KM, 1.0, None, locs, tuple(CLUSTER), None)
    denser = HabitatModel(
        MIN_BANDWIDTH_KM, 1.0, None, (*locs, (9.606, 56.312)), tuple(CLUSTER), None
    )  # a fresh ~660 m cell just north of the cluster
    assert denser.raw(*query) > sparse.raw(*query)


def test_habitat_fit_thins_the_kde_support_but_keeps_every_find_for_the_count():
    # ADR-0011: revisits collapse in the KDE support (localities) but not in the
    # confidence count (observations).
    revisited = [(CLUSTER_LON, CLUSTER_LAT)] * 50 + [(CLUSTER_LON + 0.02, CLUSTER_LAT)] * 50
    model = HabitatModel.fit(revisited)
    assert len(model.observations) == 100
    assert len(model.localities) == 2  # two ~660 m cells
    assert model.count_within(CLUSTER_LON, CLUSTER_LAT, radius_km=0.1) == 50


def test_habitat_score_higher_in_a_dense_area_than_near_a_lone_find():
    model = HabitatModel.fit([*CLUSTER, FAR_AWAY])  # cluster + one distant outlier
    assert model.score(CLUSTER_LON, CLUSTER_LAT) > model.score(*FAR_AWAY)


def test_habitat_count_within_bandwidth():
    model = HabitatModel.fit(CLUSTER)
    assert model.count_within(CLUSTER_LON, CLUSTER_LAT) == len(CLUSTER)
    assert model.count_within(*FAR_AWAY) == 0


def test_habitat_to_dict_omits_points():
    model = HabitatModel.fit(CLUSTER)
    d = model.to_dict()
    assert set(d) == {"bandwidth_km", "raw_ref", "ratio_ref"}
    assert d["ratio_ref"] is None  # no effort grid supplied to fit()


# --------------------------------------------------------------------------- #
# habitat: effort correction (ADR-0018)                                       #
# --------------------------------------------------------------------------- #
def test_effort_grid_looks_up_by_cell_and_defaults_to_zero():
    grid = EffortGrid.from_rows([(9.6, 56.3, 42)])
    assert grid.at(9.6, 56.3) == 42
    assert grid.at(20.0, 60.0) == 0  # never recorded there at all


def test_effort_grid_to_list_round_trips_through_from_rows():
    grid = EffortGrid.from_rows([(9.6, 56.3, 10), (10.1, 56.5, 3)])
    restored = EffortGrid.from_rows([(row["lon"], row["lat"], row["n"]) for row in grid.to_list()])
    assert restored.at(9.6, 56.3) == 10
    assert restored.at(10.1, 56.5) == 3


def test_habitat_fit_without_effort_grid_leaves_ratio_ref_none():
    assert HabitatModel.fit(CLUSTER).ratio_ref is None


def test_habitat_score_effort_correction_favours_low_effort_over_high():
    # one training locality (duplicated so fit() clears its len(pts) >= 2
    # floor), calibrated against its own (floor-level) effort
    grid = EffortGrid.from_rows([(CLUSTER_LON, CLUSTER_LAT, MIN_EFFORT_TO_CORRECT)])
    model = HabitatModel.fit([(CLUSTER_LON, CLUSTER_LAT)] * 2, grid)
    assert model.ratio_ref is not None

    low = model.score(CLUSTER_LON, CLUSTER_LAT, effort=MIN_EFFORT_TO_CORRECT)
    high = model.score(CLUSTER_LON, CLUSTER_LAT, effort=MIN_EFFORT_TO_CORRECT * 20)
    assert low == pytest.approx(1.0)  # matches its own calibration exactly
    # same raw density, but far more of the recording here is "explained" by
    # everyone visiting a lot, not by this species being unusually common
    assert high < low


def test_habitat_score_without_effort_falls_back_to_the_uncorrected_reference():
    grid = EffortGrid.from_rows([(CLUSTER_LON, CLUSTER_LAT, 50)])
    corrected = HabitatModel.fit(CLUSTER, grid)
    uncorrected = HabitatModel.fit(CLUSTER)
    # a caller that doesn't look up and pass effort (golden.py, in particular)
    # gets exactly today's score, unaffected by whether the model was fit with
    # an effort grid at all
    assert corrected.score(CLUSTER_LON, CLUSTER_LAT) == pytest.approx(
        uncorrected.score(CLUSTER_LON, CLUSTER_LAT)
    )


# --------------------------------------------------------------------------- #
# seasonality                                                                  #
# --------------------------------------------------------------------------- #
def test_seasonality_peak_is_one_in_season_and_near_zero_off_season():
    model = SeasonalityModel.fit([225] * 20, sigma_days=15)
    assert model.score(225) == pytest.approx(1.0)
    assert model.score(120) < model.score(225)
    assert model.score(30) < 0.01


def test_seasonality_wraps_across_the_new_year():
    model = SeasonalityModel.fit([365, 1, 2, 3, 4], sigma_days=10)
    assert model.score(1) > 0.5
    assert model.score(365) > 0.5  # December is a neighbour of January
    assert model.score(183) < 0.01


def test_seasonality_empty():
    model = SeasonalityModel.fit([])
    assert model.score(225) == 0.0


def test_seasonality_to_dict_curve_length():
    d = SeasonalityModel.fit([225] * 5).to_dict()
    assert len(d["curve"]) == 366
    assert max(d["curve"]) == pytest.approx(1.0)


# --------------------------------------------------------------------------- #
# combiner                                                                     #
# --------------------------------------------------------------------------- #
def test_confidence_band_thresholds():
    assert confidence_band(0) == "low"
    assert confidence_band(4) == "low"
    assert confidence_band(5) == "medium"
    assert confidence_band(19) == "medium"
    assert confidence_band(20) == "high"


def test_combine_is_geometric_mean_over_available_axes():
    # weather present, host_tree absent -> cube root of the product
    assert combine(0.8, 0.5, 0.2, 1.0, weather_available=True, host_tree_available=False) == (
        pytest.approx((0.8 * 0.5 * 0.2) ** (1 / 3))
    )
    # both present -> 4th root of the product
    assert combine(0.8, 0.5, 0.2, 0.4, weather_available=True, host_tree_available=True) == (
        pytest.approx((0.8 * 0.5 * 0.2 * 0.4) ** (1 / 4))
    )
    # neither present -> square root of habitat x seasonality only
    assert combine(0.8, 0.5, 1.0, 1.0, weather_available=False, host_tree_available=False) == (
        pytest.approx(math.sqrt(0.8 * 0.5))
    )
    # monotone in the product, and lifts a middling value off the floor
    assert combine(1.0, 0.3, 1.0, 1.0, weather_available=True, host_tree_available=False) > (
        0.3 * 1.0 * 1.0
    )
    assert combine(0.0, 0.9, 0.9, 1.0, weather_available=True, host_tree_available=False) == 0.0
    assert combine(1.0, 1.0, 1.0, 1.0, weather_available=True, host_tree_available=True) == (
        pytest.approx(1.0)
    )


GOOD_WEATHER = {"precip_14d_mm": 30.0, "precip_30d_mm": 60.0, "mean_temp_14d_c": 13.0}


def _weather_model() -> WeatherModel:
    return WeatherModel.from_stats(
        200,
        {
            "precip_14d_mm": (30.0, 8.0),
            "precip_30d_mm": (60.0, 15.0),
            "mean_temp_14d_c": (13.0, 2.0),
            "dry_days_30d": (8.0, 3.0),
        },
    )


SITE = ("coniferous", "ES")  # a category both sub-terms below have actually seen


def _biotope_model() -> BiotopeModel:
    return BiotopeModel(
        forest=CategoryAffinity.fit(["coniferous"] * 20 + ["broadleaf"] * 5),
        soil=CategoryAffinity.fit(["ES"] * 20 + ["ML"] * 5),
    )


HOST_SITE = {"pinus_sylvestris": 0.9}  # a tree both sub-terms below have actually seen


def _host_tree_model() -> HostTreeModel:
    return HostTreeModel(affinity={"pinus_sylvestris": 0.8})


def _species_model(
    *, with_weather: bool = False, with_host_tree: bool = False, calibration=None
) -> SpeciesModel:
    return SpeciesModel(
        slug="test",
        habitat=HabitatModel.fit(CLUSTER),
        seasonality=SeasonalityModel.fit([225] * 20, sigma_days=15),
        weather=_weather_model() if with_weather else None,
        host_tree=_host_tree_model() if with_host_tree else None,
        host_tree_scored=with_host_tree,
        calibration=calibration,
    )


def test_species_score_in_habitat_and_season():
    sm = _species_model()
    sc = sm.score(CLUSTER_LON + 0.004, CLUSTER_LAT + 0.004, 225)
    assert sc.weather == 1.0  # no weather passed -> neutral term
    assert sc.weather_available is False
    assert sc.raw == pytest.approx(sc.habitat * sc.seasonality * sc.weather)
    # no weather -> value is the geometric mean of habitat x seasonality
    assert sc.value == round(100 * math.sqrt(sc.habitat * sc.seasonality))
    assert sc.value >= 40
    assert sc.confidence == "medium"  # "high" knocked down: weather missing


def test_species_score_applies_a_calibrator_when_attached():
    from pipeline.model.calibration import IsotonicCalibrator

    # a map that pushes mid favourabilities up: 0.5 -> 0.95
    cal = IsotonicCalibrator((0.0, 0.5, 1.0), (0.0, 0.95, 1.0))
    plain = _species_model()
    tuned = _species_model(calibration=cal)
    q = (CLUSTER_LON + 0.02, CLUSTER_LAT + 0.02)
    plain_sc = plain.score(*q, 225)
    combined = math.sqrt(plain_sc.habitat * plain_sc.seasonality)  # no weather
    assert 0.01 < combined < 0.98
    # the calibrator now maps the combined favourability, not the raw product
    assert tuned.score(*q, 225).value == round(100 * cal.predict(combined))
    assert tuned.score(*q, 225).value > plain_sc.value


def test_species_score_collapses_off_season_and_far_away():
    sm = _species_model()
    assert sm.score(CLUSTER_LON, CLUSTER_LAT, 30).value == 0  # off season
    off = sm.score(*FAR_AWAY, 225)
    assert off.value == 0  # outside the habitat
    assert off.confidence == "low"


def test_species_score_uses_weather_and_keeps_confidence_when_present():
    sm = _species_model(with_weather=True, with_host_tree=True)
    q = (CLUSTER_LON + 0.004, CLUSTER_LAT + 0.004)

    matched = sm.score(*q, 225, GOOD_WEATHER, None, HOST_SITE)
    assert matched.weather_available is True
    assert matched.host_tree_available is True
    assert matched.confidence == "high"  # not knocked down: both optional axes present
    assert matched.weather == pytest.approx(1.0, abs=0.05)

    drought = sm.score(
        *q, 225, {**GOOD_WEATHER, "precip_30d_mm": 3.0, "precip_14d_mm": 1.0}, None, HOST_SITE
    )
    assert drought.weather < matched.weather  # ADR-0006 drought property
    assert drought.value < matched.value


def test_species_score_knocks_down_confidence_when_only_one_optional_axis_is_present():
    sm = _species_model(with_weather=True, with_host_tree=True)
    q = (CLUSTER_LON + 0.004, CLUSTER_LAT + 0.004)

    weather_only = sm.score(*q, 225, GOOD_WEATHER)  # no site -> host_tree unavailable
    assert weather_only.weather_available is True
    assert weather_only.host_tree_available is False
    assert weather_only.confidence == "medium"  # knocked down from "high"

    host_tree_only = sm.score(*q, 225, None, None, HOST_SITE)  # no weather features
    assert host_tree_only.weather_available is False
    assert host_tree_only.host_tree_available is True
    assert host_tree_only.confidence == "medium"


def test_species_score_ignores_a_fitted_host_tree_when_not_in_the_scored_set():
    # ADR-0019: host_tree is fitted for every species with enough data, but
    # only consulted by terms()/score() when host_tree_scored is True -- a
    # species not in HOST_TREE_SCORED_SPECIES stays neutral/unavailable even
    # with a real fitted affinity and a matching site, exactly like biotope.
    sm = SpeciesModel(
        slug="test",
        habitat=HabitatModel.fit(CLUSTER),
        seasonality=SeasonalityModel.fit([225] * 20, sigma_days=15),
        host_tree=_host_tree_model(),
        host_tree_scored=False,
    )
    q = (CLUSTER_LON + 0.004, CLUSTER_LAT + 0.004)
    sc = sm.score(*q, 225, None, None, HOST_SITE)
    assert sc.host_tree == 1.0
    assert sc.host_tree_available is False


def test_conditions_score_as_dict_shape():
    sc = _species_model().score(CLUSTER_LON, CLUSTER_LAT, 225)
    assert set(sc.as_dict()) == {
        "value",
        "raw",
        "habitat",
        "seasonality",
        "weather",
        "host_tree",
        "n_nearby",
        "weather_available",
        "host_tree_available",
        "confidence",
    }


# --------------------------------------------------------------------------- #
# weather term                                                                 #
# --------------------------------------------------------------------------- #
def test_weather_model_unfitted_below_the_observation_floor():
    thin = WeatherModel.from_stats(MIN_WEATHER_OBSERVATIONS - 1, {"precip_14d_mm": (30.0, 8.0)})
    assert thin.is_fitted is False
    assert thin.score(GOOD_WEATHER) == 1.0  # neutral


def test_weather_model_unfitted_when_a_feature_stat_is_missing():
    model = WeatherModel.from_stats(200, {"precip_14d_mm": (30.0, None)})
    assert model.is_fitted is False


def test_weather_model_scores_peak_at_the_mean_and_low_far_off():
    model = _weather_model()
    at_mean = model.score(
        {"precip_14d_mm": 30.0, "precip_30d_mm": 60.0, "mean_temp_14d_c": 13.0, "dry_days_30d": 8.0}
    )
    assert at_mean == pytest.approx(1.0, abs=1e-9)
    far = model.score(
        {"precip_14d_mm": 120.0, "precip_30d_mm": 5.0, "mean_temp_14d_c": 3.0, "dry_days_30d": 25.0}
    )
    assert 0.0 < far < 0.2


def test_weather_model_neutral_when_no_features_supplied():
    assert _weather_model().score(None) == 1.0
    assert _weather_model().score({}) == 1.0
    assert _weather_model().score({"unrelated": 5.0}) == 1.0


def test_weather_model_dict_roundtrip():
    model = _weather_model()
    restored = WeatherModel.from_dict(model.to_dict())
    assert restored.score(GOOD_WEATHER) == pytest.approx(model.score(GOOD_WEATHER))

    unfitted = WeatherModel.from_stats(3, None)
    assert WeatherModel.from_dict(unfitted.to_dict()).is_fitted is False


def test_weather_model_keeps_features_that_fit_when_one_does_not():
    # precip_60d_mm has too few full-60d-window finds to have an sd (None) --
    # the term should still fit on precip_14d_mm rather than going fully
    # neutral (ADR-0017; the pre-ADR-0017 behaviour disabled the whole term).
    model = WeatherModel.from_stats(
        200, {"precip_14d_mm": (30.0, 8.0), "precip_60d_mm": (100.0, None)}
    )
    assert model.is_fitted is True
    assert set(model.features) == {"precip_14d_mm"}
    # the unfitted feature is simply not scored, even if a value is supplied
    assert model.score({"precip_14d_mm": 30.0, "precip_60d_mm": 999.0}) == pytest.approx(1.0)


def test_coverage_column_and_threshold_overrides_the_wide_window_features():
    assert coverage_column_and_threshold("precip_14d_mm") == ("precip_days_covered", 28)
    assert coverage_column_and_threshold("precip_60d_mm") == ("precip_60d_days_covered", 56)
    assert coverage_column_and_threshold("prior_summer_precip_mm") == (
        "prior_summer_days_covered",
        85,
    )


def test_build_feature_dict_nulls_an_undercovered_feature_without_dropping_the_row():
    values = (40.0, 80.0, 13.0, 15.0, 160.0, 250.0)
    # precip_days_covered=28 (fine for the first four); precip_60d covered
    # only 40/60 days (below its 56 threshold); prior-summer fully covered.
    coverages = (28, 28, 28, 28, 40, 90)
    result = build_feature_dict(values, coverages)
    assert result["precip_14d_mm"] == 40.0
    assert result["precip_60d_mm"] is None  # undercovered -> nulled, not dropped
    assert result["prior_summer_precip_mm"] == 250.0
    assert set(result) == set(WEATHER_FEATURES)


# --------------------------------------------------------------------------- #
# host tree term (ADR-0019)                                                    #
# --------------------------------------------------------------------------- #
def test_host_tree_grid_classifies_by_grid_cell_and_defaults_to_none():
    grid = HostTreeGrid.from_rows([(9.6, 56.3, 0.9, 0.1, 0.8, None, 0.2, 0.05)])
    assert grid.classify(9.6, 56.3) == {
        "fagus_sylvatica": 0.9,
        "picea_abies": 0.1,
        "pinus_sylvestris": 0.8,
        "prunus_avium": None,
        "quercus_robur": 0.2,
        "salix_caprea": 0.05,
    }
    assert grid.classify(20.0, 60.0) is None  # far outside any classified cell


def test_host_tree_grid_to_list_round_trips_through_from_rows():
    grid = HostTreeGrid.from_rows([(9.6, 56.3, 0.9, 0.1, 0.8, None, 0.2, 0.05)])
    row = grid.to_list()[0]
    restored = HostTreeGrid.from_rows(
        [(row["lon"], row["lat"], *(row[t] for t in HOST_TREE_SPECIES))]
    )
    assert restored.classify(9.6, 56.3) == grid.classify(9.6, 56.3)


def test_host_tree_model_unfitted_below_the_observation_floor():
    from pipeline.model.host_tree import MIN_OBSERVATIONS_TO_FIT

    thin = HostTreeModel.fit([{"pinus_sylvestris": 0.9}] * (MIN_OBSERVATIONS_TO_FIT - 1))
    assert thin.affinity == {}
    assert thin.score({"pinus_sylvestris": 0.9}) == (1.0, False)  # neutral


def test_host_tree_model_fits_the_mean_probability_among_training_finds():
    sites = [{"pinus_sylvestris": 0.8}] * 15 + [{"pinus_sylvestris": 0.6}] * 10
    model = HostTreeModel.fit(sites)
    assert model.affinity["pinus_sylvestris"] == pytest.approx(0.8 * 0.6 + 0.6 * 0.4, abs=1e-9)


def test_host_tree_model_fit_divides_by_background_when_supplied():
    # ADR-0019: without a background, affinity is the raw mean at finds (a
    # widespread tree like oak then dominates every species regardless of real
    # ecology); with one, it's an enrichment ratio over that tree's general
    # prevalence, so a rarer, more genuinely-associated tree can outrank it.
    sites = [{"pinus_sylvestris": 0.8}] * 25
    unweighted = HostTreeModel.fit(sites)
    assert unweighted.affinity["pinus_sylvestris"] == pytest.approx(0.8)

    enriched = HostTreeModel.fit(sites, background={"pinus_sylvestris": 0.4})
    assert enriched.affinity["pinus_sylvestris"] == pytest.approx(0.8 / 0.4)

    # a tree missing from (or zero in) the background falls back to the raw mean
    no_background_entry = HostTreeModel.fit(sites, background={})
    assert no_background_entry.affinity["pinus_sylvestris"] == pytest.approx(0.8)


def test_host_tree_grid_background_means_averages_over_classified_cells():
    grid = HostTreeGrid.from_rows(
        [
            (9.6, 56.3, 0.8, None, 0.4, None, None, None),
            (9.7, 56.4, 0.6, None, 0.2, None, None, None),
        ]
    )
    means = grid.background_means()
    assert means["fagus_sylvatica"] == pytest.approx(0.7)
    assert means["pinus_sylvestris"] == pytest.approx(0.3)
    assert "picea_abies" not in means  # never present -> no mean to report


def test_host_tree_model_score_is_a_weighted_average_of_raw_probabilities():
    model = HostTreeModel(affinity={"pinus_sylvestris": 0.8, "quercus_robur": 0.2})
    score, available = model.score({"pinus_sylvestris": 1.0, "quercus_robur": 0.0})
    assert available is True
    assert score == pytest.approx((0.8 * 1.0 + 0.2 * 0.0) / (0.8 + 0.2))


def test_host_tree_model_neutral_when_nothing_to_compare():
    empty = HostTreeModel()
    assert empty.score({"pinus_sylvestris": 0.9}) == (1.0, False)
    fitted = HostTreeModel(affinity={"pinus_sylvestris": 0.8})
    assert fitted.score(None) == (1.0, False)


def test_host_tree_model_dict_roundtrip():
    model = HostTreeModel(affinity={"pinus_sylvestris": 0.8, "quercus_robur": 0.2})
    restored = HostTreeModel.from_dict(model.to_dict())
    assert restored.score(HOST_SITE) == model.score(HOST_SITE)


# --------------------------------------------------------------------------- #
# biotope term                                                                 #
# --------------------------------------------------------------------------- #
def test_category_affinity_unfitted_below_the_observation_floor():
    from pipeline.model.biotope import MIN_OBSERVATIONS_TO_FIT

    thin = CategoryAffinity.fit(["coniferous"] * (MIN_OBSERVATIONS_TO_FIT - 1))
    assert thin.scores == {}
    assert thin.score("coniferous") == 1.0  # neutral: too few observations to trust a distribution


def test_category_affinity_peaks_at_one_and_floors_unseen_categories():
    from pipeline.model.biotope import UNSEEN_CATEGORY_SCORE

    affinity = CategoryAffinity.fit(["coniferous"] * 30 + ["broadleaf"] * 10)
    assert affinity.score("coniferous") == pytest.approx(1.0)
    assert affinity.score("broadleaf") == pytest.approx(10 / 30)
    # a category never seen among this species' observations floors, not zeros --
    # a hard zero would kill the whole combined score (ADR-0016)
    assert affinity.score("mixed") == UNSEEN_CATEGORY_SCORE
    assert affinity.score(None) == 1.0  # no classification at the query point: neutral


def test_biotope_model_neutral_when_nothing_to_compare():
    model = BiotopeModel(forest=CategoryAffinity.fit([]), soil=CategoryAffinity.fit([]))
    score, available = model.score("coniferous", "ES")
    assert score == 1.0
    assert available is False  # neither sub-term has a fitted distribution


def test_biotope_model_scores_the_geometric_mean_of_its_sub_terms():
    model = _biotope_model()
    score, available = model.score(*SITE)
    assert available is True
    expected = model.forest.score(SITE[0]) ** 0.5 * model.soil.score(SITE[1]) ** 0.5
    assert score == pytest.approx(expected)


def test_biotope_model_dict_roundtrip():
    model = _biotope_model()
    restored = BiotopeModel.from_dict(model.to_dict())
    assert restored.score(*SITE) == model.score(*SITE)


def test_biotope_grid_classifies_by_grid_cell_and_defaults_to_unclassified():
    grid = BiotopeGrid.from_rows([(9.6, 56.3, "coniferous", "ES")])
    assert grid.classify(9.6, 56.3) == ("coniferous", "ES")
    assert grid.classify(20.0, 60.0) == (None, None)  # far outside any classified cell


def test_biotope_grid_to_list_round_trips_through_from_rows():
    grid = BiotopeGrid.from_rows([(9.6, 56.3, "coniferous", "ES"), (10.1, 56.5, None, "ML")])
    restored = BiotopeGrid.from_rows(
        [(row["lon"], row["lat"], row["forest_type"], row["soil_tsym"]) for row in grid.to_list()]
    )
    assert restored.classify(9.6, 56.3) == ("coniferous", "ES")
    assert restored.classify(10.1, 56.5) == (None, "ML")


# --------------------------------------------------------------------------- #
# fit step                                                                     #
# --------------------------------------------------------------------------- #
@pytest.fixture
def observations_db(tmp_path: Path) -> Path:
    """A DuckDB with just the `observations` columns the fit step reads: a
    50-point Cantharellus cluster in Aug/Sep and a few Boletus finds."""
    db = tmp_path / "obs.duckdb"
    rows: list[tuple] = []
    for k in range(50):
        rows.append(
            (
                f"C:{k}",
                "Cantharellus cibarius",
                date(2018 + k % 5, 8, 1) + timedelta(days=k % 40),
                CLUSTER_LON + (k % 7) * 0.003,
                CLUSTER_LAT + (k % 5) * 0.003,
            )
        )
    for k in range(8):
        rows.append((f"B:{k}", "Boletus edulis", date(2020, 9, 10) + timedelta(days=k), 10.0, 56.5))

    con = duckdb.connect(str(db))
    try:
        con.execute(
            "CREATE TABLE observations "
            "(observation_id TEXT, scientific_name TEXT, observed_on DATE, lon DOUBLE, lat DOUBLE)"
        )
        con.executemany("INSERT INTO observations VALUES (?, ?, ?, ?, ?)", rows)
    finally:
        con.close()
    return db


def test_fit_run_writes_manifest_and_species_files(observations_db: Path, tmp_path: Path):
    out = tmp_path / "publish"
    report = fit_run(observations_db, out)

    assert report["step"] == "model"
    assert report["species"] == 56  # 28 core + 28 extra
    assert report["files"] == 57  # manifest + 56 (no weather_daily -> no current.json)
    assert report["species_without_observations"] == 54  # only kantarel + Karl Johan have rows
    assert report["current_conditions"] is None

    manifest = json.loads((out / "model" / "manifest.json").read_text("utf-8"))
    assert manifest["terms"] == ["habitat", "seasonality", "weather", "host_tree"]
    assert manifest["current_conditions"] is None
    assert len(manifest["species"]) == 56

    kantarel = json.loads((out / "model" / "cantharellus-cibarius.json").read_text("utf-8"))
    assert kantarel["slug"] == "cantharellus-cibarius"
    assert kantarel["fit"]["n_observations"] == 50
    assert len(kantarel["seasonality"]["curve"]) == 366
    assert MIN_BANDWIDTH_KM <= kantarel["habitat"]["bandwidth_km"] <= MAX_BANDWIDTH_KM
    assert kantarel["habitat"]["raw_ref"] > 0


def test_fit_run_emits_empty_model_for_species_without_observations(
    observations_db: Path, tmp_path: Path
):
    out = tmp_path / "publish"
    fit_run(observations_db, out)
    suillus = json.loads((out / "model" / "suillus-luteus.json").read_text("utf-8"))
    assert suillus["fit"]["n_observations"] == 0
    assert suillus["habitat"]["raw_ref"] == 0


def test_fit_run_needs_the_observations_table(tmp_path: Path):
    empty = tmp_path / "empty.duckdb"
    duckdb.connect(str(empty)).close()
    with pytest.raises(SystemExit):
        fit_run(empty, tmp_path / "publish")


# --------------------------------------------------------------------------- #
# current conditions                                                           #
# --------------------------------------------------------------------------- #
def _weather_daily_rows(anchor: date, cells: dict[str, tuple[float, float]]) -> list[tuple]:
    rows: list[tuple] = []
    for cell_id, (lon, lat) in cells.items():
        for days_before in range(1, 31):
            day = anchor - timedelta(days=days_before)
            rows.append((cell_id, day, "acc_precip", 3.0, lon, lat))
            rows.append((cell_id, day, "mean_temp", 12.0, lon, lat))
    return rows


@pytest.fixture
def weather_db(tmp_path: Path) -> Path:
    db = tmp_path / "weather.duckdb"
    anchor = date(2026, 8, 30)
    con = duckdb.connect(str(db))
    try:
        con.execute(
            "CREATE TABLE weather_daily (cell_id TEXT, date DATE, parameter TEXT, "
            "value DOUBLE, cell_lon DOUBLE, cell_lat DOUBLE)"
        )
        con.executemany(
            "INSERT INTO weather_daily VALUES (?, ?, ?, ?, ?, ?)",
            _weather_daily_rows(anchor, {"a": (9.5, 56.2), "b": (10.1, 56.8)}),
        )
    finally:
        con.close()
    return db


def test_current_conditions_shape(weather_db: Path, tmp_path: Path):
    out = tmp_path / "publish"
    report = current.run(weather_db, out)

    assert report["as_of"] == "2026-08-30"
    assert report["cells"] == 2
    assert report["cells_with_full_window"] == 2

    payload = json.loads((out / "model" / "current.json").read_text("utf-8"))
    assert payload["as_of"] == "2026-08-30"
    cell = next(c for c in payload["cells"] if c["cell_id"] == "a")
    assert cell["precip_30d_mm"] == pytest.approx(90.0)  # 30 days x 3 mm
    assert cell["precip_14d_mm"] == pytest.approx(42.0)
    assert cell["mean_temp_14d_c"] == pytest.approx(12.0)
    assert cell["dry_days_30d"] == 0
    assert cell["precip_days_covered"] == 30


def test_current_conditions_honours_an_explicit_anchor(weather_db: Path, tmp_path: Path):
    report = current.run(weather_db, tmp_path / "p", as_of=date(2026, 8, 20))
    assert report["as_of"] == "2026-08-20"
    # only 20 of the 30 antecedent days exist before this earlier anchor
    payload = json.loads((tmp_path / "p" / "model" / "current.json").read_text("utf-8"))
    assert payload["cells"][0]["precip_days_covered"] < 30


def test_current_conditions_needs_weather_daily(tmp_path: Path):
    empty = tmp_path / "empty.duckdb"
    duckdb.connect(str(empty)).close()
    with pytest.raises(SystemExit):
        current.run(empty, tmp_path / "p")


# --------------------------------------------------------------------------- #
# fit step: the weather term                                                   #
# --------------------------------------------------------------------------- #
@pytest.fixture
def model_db(observations_db: Path) -> Path:
    """`observations_db` plus `observation_weather` (full window for all rows;
    Cantharellus clears the fit floor, Boletus does not) and `weather_daily`."""
    rows: list[tuple] = [
        (
            f"C:{k}",
            30.0 + k % 10,  # precip_14d_mm
            60.0 + k % 15,  # precip_30d_mm
            13.0 + (k % 5) * 0.4,  # mean_temp_14d_c
            float(8 + k % 6),  # dry_days_30d
            30.0,  # precip_days_covered
            120.0 + k % 20,  # precip_60d_mm
            60.0,  # precip_60d_days_covered -- full
            240.0 + k % 25,  # prior_summer_precip_mm
            90.0,  # prior_summer_days_covered -- full
        )
        for k in range(50)
    ] + [(f"B:{k}", 25.0, 55.0, 12.0, 10.0, 30.0, 110.0, 60.0, 230.0, 90.0) for k in range(8)]

    con = duckdb.connect(str(observations_db))
    try:
        con.execute(
            "CREATE TABLE observation_weather ("
            "observation_id TEXT, precip_14d_mm DOUBLE, precip_30d_mm DOUBLE, "
            "mean_temp_14d_c DOUBLE, dry_days_30d DOUBLE, precip_days_covered DOUBLE, "
            "precip_60d_mm DOUBLE, precip_60d_days_covered DOUBLE, "
            "prior_summer_precip_mm DOUBLE, prior_summer_days_covered DOUBLE)"
        )
        con.executemany(
            "INSERT INTO observation_weather VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows
        )
        con.execute(
            "CREATE TABLE weather_daily (cell_id TEXT, date DATE, parameter TEXT, "
            "value DOUBLE, cell_lon DOUBLE, cell_lat DOUBLE)"
        )
        con.executemany(
            "INSERT INTO weather_daily VALUES (?, ?, ?, ?, ?, ?)",
            _weather_daily_rows(date(2026, 8, 30), {"a": (9.6, 56.3)}),
        )
    finally:
        con.close()
    return observations_db


def test_fit_run_fits_the_weather_term_where_data_is_sufficient(model_db: Path, tmp_path: Path):
    out = tmp_path / "publish"
    report = fit_run(model_db, out)

    assert report["species_with_weather"] == 1  # Cantharellus only (Boletus too thin)
    assert report["current_conditions"]["cells"] == 1
    assert (out / "model" / "current.json").exists()

    manifest = json.loads((out / "model" / "manifest.json").read_text("utf-8"))
    assert manifest["terms"] == ["habitat", "seasonality", "weather", "host_tree"]
    assert manifest["current_conditions"] == "model/current.json"

    kantarel = json.loads((out / "model" / "cantharellus-cibarius.json").read_text("utf-8"))
    assert kantarel["fit"]["weather_fitted"] is True
    feats = kantarel["weather"]["features"]
    assert set(feats) == set(manifest["weather_features"])
    assert feats["precip_14d_mm"]["sd"] > 0

    boletus = json.loads((out / "model" / "boletus-edulis.json").read_text("utf-8"))
    assert boletus["fit"]["weather_fitted"] is False
    assert boletus["weather"]["features"] is None


def test_fit_run_without_observation_weather_leaves_weather_unfitted(
    observations_db: Path, tmp_path: Path
):
    out = tmp_path / "publish"
    report = fit_run(observations_db, out)
    assert report["species_with_weather"] == 0
    assert report["current_conditions"] is None
    kantarel = json.loads((out / "model" / "cantharellus-cibarius.json").read_text("utf-8"))
    assert kantarel["weather"] is None  # no weather infrastructure in this build at all


@pytest.fixture
def biotope_db(observations_db: Path) -> Path:
    """`observations_db` plus a `biotope_grid` table classifying every
    Cantharellus point (and none of Boletus's) as coniferous/ES -- enough to
    fit Cantharellus's biotope term while leaving Boletus's unfitted."""
    con = duckdb.connect(str(observations_db))
    try:
        cantharellus_points = con.execute(
            "SELECT DISTINCT lon, lat FROM observations WHERE scientific_name = ?",
            ["Cantharellus cibarius"],
        ).fetchall()
        con.execute(
            "CREATE TABLE biotope_grid (lon DOUBLE, lat DOUBLE, forest_type TEXT, soil_tsym TEXT)"
        )
        con.executemany(
            "INSERT INTO biotope_grid VALUES (?, ?, 'coniferous', 'ES')", cantharellus_points
        )
    finally:
        con.close()
    return observations_db


def test_fit_run_fits_the_biotope_term_where_data_is_sufficient(biotope_db: Path, tmp_path: Path):
    out = tmp_path / "publish"
    report = fit_run(biotope_db, out)

    assert report["species_with_biotope"] == 1  # Cantharellus only -- Boletus has no grid coverage
    assert (out / "model" / "biotope_grid.json").exists()

    manifest = json.loads((out / "model" / "manifest.json").read_text("utf-8"))
    assert manifest["biotope_grid"] == "model/biotope_grid.json"

    kantarel = json.loads((out / "model" / "cantharellus-cibarius.json").read_text("utf-8"))
    assert kantarel["fit"]["biotope_fitted"] is True
    assert set(kantarel["biotope"]) == {"forest", "soil"}
    assert kantarel["biotope"]["forest"]["coniferous"] == pytest.approx(1.0)
    assert kantarel["biotope"]["soil"]["ES"] == pytest.approx(1.0)

    boletus = json.loads((out / "model" / "boletus-edulis.json").read_text("utf-8"))
    assert boletus["fit"]["biotope_fitted"] is False
    assert boletus["biotope"] == {"forest": {}, "soil": {}}


@pytest.fixture
def effort_db(observations_db: Path) -> Path:
    """`observations_db` plus a `recording_effort_grid` table covering every
    Cantharellus point (and not Boletus's) with plenty of background records --
    enough to effort-correct Cantharellus's habitat term while leaving
    Boletus's uncorrected."""
    con = duckdb.connect(str(observations_db))
    try:
        cantharellus_points = con.execute(
            "SELECT DISTINCT lon, lat FROM observations WHERE scientific_name = ?",
            ["Cantharellus cibarius"],
        ).fetchall()
        con.execute("CREATE TABLE recording_effort_grid (lon DOUBLE, lat DOUBLE, n BIGINT)")
        con.executemany("INSERT INTO recording_effort_grid VALUES (?, ?, 50)", cantharellus_points)
    finally:
        con.close()
    return observations_db


def test_fit_run_effort_corrects_the_habitat_term_where_data_is_sufficient(
    effort_db: Path, tmp_path: Path
):
    out = tmp_path / "publish"
    report = fit_run(effort_db, out)

    assert report["species_effort_corrected"] == 1  # Cantharellus only
    assert (out / "model" / "recording_effort_grid.json").exists()

    manifest = json.loads((out / "model" / "manifest.json").read_text("utf-8"))
    assert manifest["recording_effort_grid"] == "model/recording_effort_grid.json"

    kantarel = json.loads((out / "model" / "cantharellus-cibarius.json").read_text("utf-8"))
    assert kantarel["fit"]["effort_corrected"] is True
    assert kantarel["habitat"]["ratio_ref"] is not None

    boletus = json.loads((out / "model" / "boletus-edulis.json").read_text("utf-8"))
    assert boletus["fit"]["effort_corrected"] is False
    assert boletus["habitat"]["ratio_ref"] is None


@pytest.fixture
def host_tree_db(observations_db: Path) -> Path:
    """`observations_db` plus a `host_tree_grid` table classifying every
    Cantharellus point (and not Boletus's) as high pine probability -- enough
    to fit Cantharellus's host-tree term while leaving Boletus's unfitted.
    Also adds an equal number of background-only cells, well away from any
    real find, at a *lower* value -- so the background mean (0.6) differs
    from the raw mean at finds (0.9), giving the enrichment-ratio fit
    (ADR-0019) something real to divide by instead of trivially 1.0."""
    con = duckdb.connect(str(observations_db))
    try:
        cantharellus_points = con.execute(
            "SELECT DISTINCT lon, lat FROM observations WHERE scientific_name = ?",
            ["Cantharellus cibarius"],
        ).fetchall()
        cols = ", ".join(f"{t} DOUBLE" for t in HOST_TREE_SPECIES)
        con.execute(f"CREATE TABLE host_tree_grid (lon DOUBLE, lat DOUBLE, {cols})")
        placeholders = ", ".join(["?"] * (2 + len(HOST_TREE_SPECIES)))
        rows = [
            (lon, lat, *([0.9] + [None] * (len(HOST_TREE_SPECIES) - 1)))
            for lon, lat in cantharellus_points
        ]
        background_rows = [
            (lon + 1.0, lat + 1.0, *([0.3] + [None] * (len(HOST_TREE_SPECIES) - 1)))
            for lon, lat in cantharellus_points
        ]
        con.executemany(
            f"INSERT INTO host_tree_grid VALUES ({placeholders})", rows + background_rows
        )
    finally:
        con.close()
    return observations_db


def test_fit_run_fits_the_host_tree_term_where_data_is_sufficient(
    host_tree_db: Path, tmp_path: Path
):
    out = tmp_path / "publish"
    report = fit_run(host_tree_db, out)

    assert report["species_with_host_tree"] == 1  # Cantharellus only
    assert (out / "model" / "host_tree_grid.json").exists()

    manifest = json.loads((out / "model" / "manifest.json").read_text("utf-8"))
    assert manifest["host_tree_grid"] == "model/host_tree_grid.json"
    assert manifest["terms"] == ["habitat", "seasonality", "weather", "host_tree"]

    kantarel = json.loads((out / "model" / "cantharellus-cibarius.json").read_text("utf-8"))
    assert kantarel["fit"]["host_tree_fitted"] is True
    # enrichment ratio (ADR-0019): raw mean at finds (0.9) / background mean
    # across the whole grid (0.6, from the fixture's added background cells)
    assert kantarel["host_tree"][HOST_TREE_SPECIES[0]] == pytest.approx(0.9 / 0.6)
    # fitted (real data, kept for future re-validation) but not in
    # HOST_TREE_SCORED_SPECIES -- Cantharellus never reaches the ranked score
    assert kantarel["fit"]["host_tree_scored"] is False
    assert kantarel["host_tree_scored"] is False

    boletus = json.loads((out / "model" / "boletus-edulis.json").read_text("utf-8"))
    assert boletus["fit"]["host_tree_fitted"] is False
    assert boletus["host_tree"] == {}
