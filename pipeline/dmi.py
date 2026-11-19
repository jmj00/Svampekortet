"""Client for the DMI Open Data Climate Data API (no key required).

Only what the pipeline needs: daily values from the 10 km climate grid, by
parameter and year, over a bounding box. Responses are GeoJSON in WGS84.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date

from pipeline.http import get_json

BASE = "https://opendataapi.dmi.dk/v2/climateData"
COLLECTION = "10kmGridValue"
PAGE_LIMIT = 5000

# Parameters the model uses; see docs/data-sources.md.
DAILY_PARAMETERS = ("mean_temp", "acc_precip")


def polygon_centroid(geometry: dict) -> tuple[float, float]:
    """Mean of a GeoJSON Polygon's exterior ring (drops the closing duplicate)."""
    ring = geometry["coordinates"][0]
    points = ring[:-1] if ring and ring[0] == ring[-1] else ring
    n = len(points)
    return (sum(p[0] for p in points) / n, sum(p[1] for p in points) / n)


def feature_to_row(feature: dict) -> dict:
    props = feature["properties"]
    lon, lat = polygon_centroid(feature["geometry"])
    raw_value = props.get("value")
    return {
        "cell_id": props["cellId"],
        "date": date.fromisoformat(props["from"][:10]),
        "parameter": props["parameterId"],
        "value": None if raw_value is None else float(raw_value),
        "cell_lon": lon,
        "cell_lat": lat,
    }


Bbox = tuple[float, float, float, float]


def iter_daily(parameter_id: str, year: int, bbox: Bbox) -> Iterator[dict]:
    """Yield normalised rows for `year`, one parameter.

    The requested range is bracketed a day either side (DMI stamps daily values at
    local midnight, which can fall just outside a UTC bound) and rows are then
    filtered back to `year`, so consecutive years' pulls tile with no gaps.
    """
    datetime_range = f"{year - 1}-12-31T00:00:00Z/{year + 1}-01-02T00:00:00Z"
    bbox_str = ",".join(str(v) for v in bbox)
    offset = 0
    while True:
        payload = get_json(
            f"{BASE}/collections/{COLLECTION}/items",
            {
                "parameterId": parameter_id,
                "timeResolution": "day",
                "datetime": datetime_range,
                "bbox": bbox_str,
                "limit": PAGE_LIMIT,
                "offset": offset,
            },
        )
        features = payload.get("features", [])
        if not features:
            return
        for feature in features:
            row = feature_to_row(feature)
            if row["date"].year == year:
                yield row
        offset += len(features)  # advance by the actual page size, not the request limit
