from datetime import date

import pipeline.dmi as dmi
from pipeline.dmi import feature_to_row, iter_daily, polygon_centroid

_FEATURE = {
    "type": "Feature",
    "geometry": {
        "type": "Polygon",
        "coordinates": [
            [
                [9.321, 56.0348],
                [9.4814, 56.0343],
                [9.4826, 56.1241],
                [9.3217, 56.1247],
                [9.321, 56.0348],
            ]
        ],
    },
    "properties": {
        "parameterId": "mean_temp",
        "timeResolution": "day",
        "from": "2023-08-03T00:00:00.001000+02:00",
        "to": "2023-08-04T00:00:00+02:00",
        "cellId": "10km_621_52",
        "value": 16.2,
    },
}


def test_polygon_centroid_is_inside_the_cell():
    lon, lat = polygon_centroid(_FEATURE["geometry"])
    assert 9.32 < lon < 9.49
    assert 56.03 < lat < 56.13


def test_feature_to_row():
    row = feature_to_row(_FEATURE)
    assert row["cell_id"] == "10km_621_52"
    assert row["date"] == date(2023, 8, 3)
    assert row["parameter"] == "mean_temp"
    assert row["value"] == 16.2
    assert isinstance(row["cell_lon"], float)


def test_feature_to_row_handles_missing_value():
    feature = {**_FEATURE, "properties": {**_FEATURE["properties"], "value": None}}
    assert feature_to_row(feature)["value"] is None


def _feature_on(day: str) -> dict:
    return {
        "geometry": _FEATURE["geometry"],
        "properties": {**_FEATURE["properties"], "from": f"{day}T00:00:00+01:00"},
    }


def test_iter_daily_filters_boundary_days_and_pages(monkeypatch):
    pages = [
        {"features": [_feature_on("2022-12-31"), _feature_on("2023-06-01")]},
        {"features": [_feature_on("2023-12-31"), _feature_on("2024-01-01")]},
        {"features": []},
    ]
    calls = iter(pages)
    monkeypatch.setattr(dmi, "get_json", lambda *a, **k: next(calls))

    rows = list(iter_daily("mean_temp", 2023, (7.7, 54.7, 11.3, 57.9)))

    assert [r["date"] for r in rows] == [date(2023, 6, 1), date(2023, 12, 31)]
