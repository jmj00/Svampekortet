"""Regenerate the committed SAMPLE model payload under web/public/data/model/.

The frontend needs a model payload for local development. This takes the real
artifacts from a `python -m pipeline.model.fit` run and shrinks them:

- each species' habitat kernel is re-fitted against the ~10 downsampled points in
  web/public/data/species/<slug>.json, so a dev score is meaningful;
- the seasonality curve and weather distribution are copied from the real fit
  (they barely depend on record count);
- current.json is thinned to a coarse grid of cells.

    python -m pipeline.model.fit --db build/svampekortet.duckdb --out build/publish
    python scripts/gen_sample_model.py

Run from the repo root. Commit the regenerated JSON.
"""

from __future__ import annotations

import json
from pathlib import Path

from pipeline.model.habitat import HabitatModel


def _write_json(path: Path, obj: object, *, indent: int | None = None) -> None:
    text = json.dumps(obj, ensure_ascii=False, indent=indent) + "\n"
    path.write_text(text, encoding="utf-8", newline="\n")


REPO = Path(__file__).resolve().parent.parent
REAL = REPO / "build" / "publish" / "model"
SAMPLE_SPECIES = REPO / "web" / "public" / "data" / "species"
OUT = REPO / "web" / "public" / "data" / "model"
CELL_STRIDE = 12  # keep every Nth current-conditions cell

_NOTE = "SAMPLE model payload for frontend dev. Replaced at deploy by pipeline/model output."


def main() -> None:
    if not (REAL / "manifest.json").exists():
        raise SystemExit("run `python -m pipeline.model.fit --out build/publish` first")
    real_manifest = json.loads((REAL / "manifest.json").read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)

    species_index = []
    for entry in real_manifest["species"]:
        slug = entry["slug"]
        real = json.loads((REAL / f"{slug}.json").read_text(encoding="utf-8"))
        sample_doc = json.loads((SAMPLE_SPECIES / f"{slug}.json").read_text(encoding="utf-8"))
        points = [(lon, lat) for lon, lat, _ in sample_doc["observations"]]
        habitat = HabitatModel.fit(points)

        doc = {
            "_note": _NOTE,
            "slug": slug,
            "habitat": habitat.to_dict(),
            "seasonality": real["seasonality"],
            "weather": real["weather"],
            "calibration": None,
            "fit": {
                "n_observations": len(points),
                "locality_spacing_km": (
                    round(habitat.spacing_km, 3) if habitat.spacing_km is not None else None
                ),
            },
        }
        _write_json(OUT / f"{slug}.json", doc)
        species_index.append(
            {
                "slug": slug,
                "scientific_name": entry["scientific_name"],
                "file": f"model/{slug}.json",
                "n_observations": len(points),
                "bandwidth_km": round(habitat.bandwidth_km, 3),
                "weather_fitted": entry["weather_fitted"],
                "calibrated": False,
            }
        )

    real_current = json.loads((REAL / "current.json").read_text(encoding="utf-8"))
    current = {
        "_note": _NOTE,
        "as_of": real_current["as_of"],
        "window_days": real_current["window_days"],
        "features": real_current["features"],
        "cells": real_current["cells"][::CELL_STRIDE],
    }
    _write_json(OUT / "current.json", current)

    manifest = {
        "_note": _NOTE,
        "version": real_manifest["version"],
        "terms": real_manifest["terms"],
        "seasonality_sigma_days": real_manifest["seasonality_sigma_days"],
        "weather_features": real_manifest["weather_features"],
        "current_conditions": "model/current.json",
        "backtest": real_manifest["backtest"],
        "species": species_index,
    }
    _write_json(OUT / "manifest.json", manifest, indent=2)

    n_cells = len(current["cells"])
    print(f"wrote {len(species_index)} species + manifest + current ({n_cells} cells)")


if __name__ == "__main__":
    main()
