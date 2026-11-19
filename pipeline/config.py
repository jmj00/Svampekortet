"""Shared pipeline configuration: paths, the study area, and filter thresholds."""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
DESCRIPTIONS_DIR = DATA_DIR / "descriptions"  # hand-written species text
IMAGES_DIR = DATA_DIR / "images"  # curated per-species photo lists
RAW_DIR = DATA_DIR / "raw"  # downloaded archives (git-ignored)
BUILD_DIR = REPO_ROOT / "build"  # generated artifacts (git-ignored)
DUCKDB_PATH = BUILD_DIR / "svampekortet.duckdb"
PUBLISH_DIR = BUILD_DIR / "publish"  # static payload for the web app

# Study area: a rectangle covering all of Denmark (WGS84 lon/lat), from
# Blaavandshuk in the west to Bornholm/Ertholmene in the east, Gedser in the
# south to Skagen in the north. Includes some sea and a sliver of Skaane and
# northern Germany at the corners; the per-record coordinate checks and the
# observation data itself keep those effectively empty. Superseded the
# Jutland-only MVP box -- see docs/adr/0010-expand-study-area-to-denmark.md.
DENMARK_BBOX = (8.0, 54.5, 15.3, 57.9)  # (min_lon, min_lat, max_lon, max_lat)

# Records with a coordinate uncertainty above this are unusable for local
# prediction (Svampeatlas p99 is ~2.5 km; there are junk values up to 25000 km).
MAX_COORDINATE_UNCERTAINTY_M = 5000.0

# Red List categories (DCE/AU, 2019) that hide a species from the app. See
# docs/adr/0005-red-list-source-and-exclusion.md. DD is deliberately not here.
REDLIST_HIDDEN_CATEGORIES = frozenset({"RE", "CR", "EN", "VU", "NT"})

SVAMPEATLAS_DWCA_URL = "https://svampe.databasen.org/dwc/dwcarchive.zip"


def in_denmark(lon: float, lat: float) -> bool:
    min_lon, min_lat, max_lon, max_lat = DENMARK_BBOX
    return min_lon <= lon <= max_lon and min_lat <= lat <= max_lat
