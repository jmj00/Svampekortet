"""Ingest Denmark-wide host-tree probability-of-occurrence for the species
this project's mushrooms are known to associate with, from Bonannella et
al.'s 30m-resolution European forest tree-species distribution maps
(Copernicus/OpenGeoHub, published on Zenodo as one Cloud-Optimized GeoTIFF
per species) -- see docs/adr/0019.

    python -m pipeline.ingest.host_tree

For each species, windowed-reads *only* the Denmark bbox directly from the
published COG over HTTP (GDAL's `/vsicurl/`, via ``rasterio``) -- a real
partial fetch, not a multi-gigabyte full download, but still a genuinely
large read (native 30m resolution over the whole Denmark bbox, ~200M pixels)
that can take minutes and is prone to a transient tile-fetch failure over a
public host; ``--cache-dir`` saves each species' *raw windowed array* (before
any resampling) so a re-run -- after a network hiccup, or to change
``GRID_DEG`` -- doesn't re-fetch species that already succeeded.

Resamples the native 30m data to a coarser, publishable grid (``GRID_DEG``,
nearest-neighbour) -- ADR-0019 measured nearest-neighbour at ~1 km against the
real backtest and found it kept a clear margin over the habitat-only
baseline; finer resolutions measured better still but cost a much larger
published grid for a modest gain.

Species chosen are the ones native/common in Danish forests and known hosts
for this project's core species (Suillus -> pine; Boletus/Cantharellus/
Craterellus/Imleria -> broader oak/beech/spruce/pine associations). The
16-species dataset does not include birch or aspen, so Leccinum (a published
extra-tier genus) gets no signal from this term -- a known gap, not an
oversight.

This grid is shared, per-tree infrastructure: every core mushroom species
gets a real ``HostTreeModel`` fitted against it (``pipeline.model.fit``), but
whether that model actually reaches the ranked score is a *separate*,
per-species decision (``pipeline.model.host_tree.HOST_TREE_SCORED_SPECIES``,
ADR-0019) -- literature-known host specificity turned out to predict the
wrong species, so that decision is made against the real backtest, not here.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import duckdb
import numpy as np
import rasterio
from rasterio.warp import transform, transform_bounds

from pipeline.config import DENMARK_BBOX, DUCKDB_PATH
from pipeline.duckload import copy_rows
from pipeline.model.host_tree import GRID_DEG, HOST_TREE_SPECIES

# A windowed read over a multi-GB remote COG issues thousands of individual
# HTTP range requests (one per internal tile); a single flaky one otherwise
# aborts the whole read (observed against the real Zenodo-hosted files -- a
# transient truncated response mid-tile). These make GDAL retry the
# individual tile fetch instead of the caller having to redo the entire read.
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "5")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")
os.environ.setdefault("GDAL_HTTP_TIMEOUT", "60")

# Zenodo record id per species (Bonannella et al. 2022, DOI 10.5281/zenodo.5821865
# is the collection; each species is its own record under it).
_RECORD_ID = {
    "fagus_sylvatica": 6956944,
    "picea_abies": 6961187,
    "pinus_sylvestris": 6966804,
    "prunus_avium": 6966847,
    "quercus_robur": 6967309,
    "salix_caprea": 6967538,
}
_FILENAME = "veg_{species}_anv.eml_p_30m_0..0cm_2018..2020_eumap_epsg3035_v0.3.tif"

# Below this probability (0..1), a species' value at a cell isn't worth
# publishing -- most of Denmark's land area has a real-but-negligible value
# for at least one of these common species (their ranges are broad, not
# forest-only), so this filter mostly excludes water/sea, not farmland.
MIN_PROBABILITY_TO_INCLUDE = 0.02

RETRIES = 3


def _record_url(species: str) -> str:
    record_id = _RECORD_ID[species]
    # Filenames use "genus.species" (a dot); HOST_TREE_SPECIES/column names use
    # "genus_species" (a valid SQL/Python identifier) -- convert for the URL only.
    genus, _, rest = species.partition("_")
    filename = _FILENAME.format(species=f"{genus}.{rest}")
    return f"/vsicurl/https://zenodo.org/api/records/{record_id}/files/{filename}/content"


def _grid_points(bbox: tuple[float, float, float, float]) -> list[tuple[float, float]]:
    min_lon, min_lat, max_lon, max_lat = bbox
    points = []
    lat = min_lat
    while lat <= max_lat:
        lon = min_lon
        while lon <= max_lon:
            points.append((lon, lat))
            lon += GRID_DEG
        lat += GRID_DEG
    return points


def _read_window(url: str) -> tuple[np.ndarray, rasterio.Affine, object]:
    """Open + windowed-read, retrying the whole thing on a transient HTTP/tile
    read failure (observed against the real Zenodo-hosted files: a truncated
    range response mid-read, not a data or logic problem)."""
    last_error: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        try:
            with rasterio.open(url) as src:
                minx, miny, maxx, maxy = transform_bounds("EPSG:4326", src.crs, *DENMARK_BBOX)
                window = rasterio.windows.from_bounds(minx, miny, maxx, maxy, src.transform)
                window = window.round_offsets().round_lengths()
                data = src.read(1, window=window)
                return data, src.window_transform(window), src.crs
        except rasterio.errors.RasterioIOError as exc:
            last_error = exc
            print(f"  read failed (attempt {attempt}/{RETRIES}): {exc}")
            if attempt < RETRIES:
                time.sleep(10 * attempt)  # a possible rate limit -- back off before retrying
    raise last_error  # type: ignore[misc]


def _fetch_species_window(
    species: str, cache: Path | None
) -> tuple[np.ndarray, rasterio.Affine, str]:
    """The raw windowed read for one species (native 30m, Denmark bbox, not
    yet resampled to GRID_DEG) -- cached by raw fetch, not by output
    resolution, so changing GRID_DEG later never needs the network again."""
    data_file = cache / f"{species}_data.npy" if cache else None
    meta_file = cache / f"{species}_meta.json" if cache else None
    if data_file and meta_file and data_file.exists() and meta_file.exists():
        data = np.load(data_file)
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        return data, rasterio.Affine(*meta["transform"]), meta["crs"]

    data, win_transform, src_crs = _read_window(_record_url(species))
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
        np.save(data_file, data)
        meta_file.write_text(
            json.dumps({"transform": list(win_transform)[:6], "crs": str(src_crs)}),
            encoding="utf-8",
        )
    return data, win_transform, str(src_crs)


def _sample_species(
    data: np.ndarray,
    win_transform: rasterio.Affine,
    src_crs: str,
    grid: list[tuple[float, float]],
) -> np.ndarray:
    """Nearest-neighbour sample of one species' probability (0..1, NaN where
    the source has no data -- water, outside its native raster extent) at
    every point in `grid`, in the same order."""
    lons = [lon for lon, _ in grid]
    lats = [lat for _, lat in grid]
    xs, ys = transform("EPSG:4326", src_crs, lons, lats)
    inv = ~win_transform
    cols, rows = inv * (np.asarray(xs), np.asarray(ys))
    cols = cols.astype(np.int64)
    rows = rows.astype(np.int64)

    out = np.full(len(grid), np.nan, dtype=np.float64)
    in_bounds = (rows >= 0) & (rows < data.shape[0]) & (cols >= 0) & (cols < data.shape[1])
    values = data[rows[in_bounds], cols[in_bounds]]
    valid = values <= 100  # >100 are nodata/water sentinels in this product
    idx = np.flatnonzero(in_bounds)[valid]
    out[idx] = values[valid] / 100.0
    return out


def run(db_path: str | Path = DUCKDB_PATH, *, cache_dir: str | Path | None = None) -> dict:
    grid = _grid_points(DENMARK_BBOX)
    print(f"sampling {len(grid)} grid points x {len(HOST_TREE_SPECIES)} species...")

    cache = Path(cache_dir) if cache_dir else None

    per_species: dict[str, np.ndarray] = {}
    for i, species in enumerate(HOST_TREE_SPECIES):
        if i > 0:
            time.sleep(2)  # spread requests out a little in case of rate limiting
        data, win_transform, src_crs = _fetch_species_window(species, cache)
        per_species[species] = _sample_species(data, win_transform, src_crs, grid)
        print(f"  {species}: done")

    # Vectorised include-mask and row assembly: a per-point Python loop
    # calling np.isnan() on scalars (rather than once, on whole arrays)
    # measured as the dominant cost of this whole step -- worse than every
    # network fetch combined.
    stacked = np.stack([per_species[s] for s in HOST_TREE_SPECIES])  # (n_species, n_points)
    include_mask = np.any((stacked >= MIN_PROBABILITY_TO_INCLUDE) & ~np.isnan(stacked), axis=0)
    included = np.flatnonzero(include_mask)
    lons = np.array([lon for lon, _ in grid])
    lats = np.array([lat for _, lat in grid])

    rows = [
        (
            round(float(lons[i]), 5),
            round(float(lats[i]), 5),
            *(None if np.isnan(v) else round(float(v), 4) for v in stacked[:, i]),
        )
        for i in included
    ]

    cols_sql = ", ".join(f"{s} DOUBLE" for s in HOST_TREE_SPECIES)
    out_path = Path(db_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(out_path))
    try:
        con.execute("DROP TABLE IF EXISTS host_tree_grid")
        con.execute(f"CREATE TABLE host_tree_grid (lon DOUBLE, lat DOUBLE, {cols_sql})")
        copy_rows(con, "host_tree_grid", ("lon", "lat", *HOST_TREE_SPECIES), rows)
    finally:
        con.close()

    return {
        "step": "host_tree",
        "grid_points": len(grid),
        "species": list(HOST_TREE_SPECIES),
        "classified_cells": len(rows),
        "db_path": str(out_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest Denmark-wide host-tree probability-of-occurrence per species."
    )
    parser.add_argument("--db", type=Path, default=DUCKDB_PATH)
    parser.add_argument(
        "--cache-dir",
        type=Path,
        help="cache each species' raw windowed read here, so a re-run after a "
        "network failure (or a GRID_DEG change) doesn't re-fetch",
    )
    args = parser.parse_args()
    print(json.dumps(run(args.db, cache_dir=args.cache_dir), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
