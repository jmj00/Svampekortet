"""Spike: pull daily precipitation and mean temperature for a Jutland area from DMI.

No API key required since 2025-12-02. Host must be opendataapi.dmi.dk
(the old dmigw.govcloud.dk still demands auth and retired 2026-06-30).

    py -m pipeline.spikes.dmi_climate_pull

Prints the available collections, pulls a summer 2021 slice for a small bbox over
central Jutland, and writes the raw GeoJSON to pipeline/spikes/out/.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from pipeline.spikes import use_utf8_stdout
from pipeline.spikes._http import get_json

BASE = "https://opendataapi.dmi.dk/v2/climateData"
OUT = Path(__file__).parent / "out"

# minLon,minLat,maxLon,maxLat -- a small box near Silkeborg / central Jutland.
BBOX = "9.35,56.05,9.85,56.35"
PERIOD = "2021-06-01T00:00:00Z/2021-09-30T23:59:59Z"
PARAMETERS = ["mean_temp", "acc_precip"]
COLLECTION = "10kmGridValue"


def pull(parameter_id: str, *, with_bbox: bool) -> dict:
    params = {
        "parameterId": parameter_id,
        "timeResolution": "day",
        "datetime": PERIOD,
        "limit": 3000,
    }
    if with_bbox:
        params["bbox"] = BBOX
    return get_json(f"{BASE}/collections/{COLLECTION}/items", params)


def main() -> None:
    OUT.mkdir(exist_ok=True)

    collections = get_json(f"{BASE}/collections")
    print("collections available:")
    for coll in collections.get("collections", []):
        print(f"  {coll.get('id'):<20} {coll.get('title', '')}")

    for parameter_id in PARAMETERS:
        data = pull(parameter_id, with_bbox=True)
        features = data.get("features", [])
        if not features:
            print(f"\n{parameter_id}: 0 features with bbox -- retrying without bbox to test reach")
            data = pull(parameter_id, with_bbox=False)
            data["features"] = data.get("features", [])[:20]
            features = data["features"]

        cells = Counter(f.get("properties", {}).get("cellId") for f in features)
        print(f"\nparameterId={parameter_id}: {len(features)} daily features")
        print(f"  cells seen: {dict(cells)}")
        for f in features[:5]:
            p = f.get("properties", {})
            print(
                f"  {p.get('from')} .. {p.get('to')}  "
                f"cell={p.get('cellId')}  value={p.get('value')}"
            )

        out_path = OUT / f"dmi_{parameter_id}.geojson"
        out_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        print(f"  wrote {out_path}")

    print(
        "\nNote the cellId format above -- that is how a 10 km grid cell is addressed "
        "in the real pipeline.\nDMI's standalone drought index is not in this API; "
        "acc_precip + mean_temp + a derived water-balance term will stand in for it."
    )


if __name__ == "__main__":
    use_utf8_stdout()
    main()
