"""Client for the Danish Red List (DCE / Aarhus University), fungi only.

The 2019 assessment round is the one that covered fungi. Categories that hide a
species from the app are in `pipeline.config.REDLIST_HIDDEN_CATEGORIES` (ADR-0005).
"""

from __future__ import annotations

from collections.abc import Iterator

from pipeline.config import REDLIST_HIDDEN_CATEGORIES
from pipeline.http import get_json

BASE = "https://api.redlist.au.dk/public/v1/summary/assessments/"
ROUND = "2019"
SPECIES_GROUP = "Svampe"  # server-side filter; still narrowed client-side below
PAGE_SIZE = 300


def _as_str(value: object) -> str | None:
    """The API mixes UUID strings and numbers for the id fields; keep them opaque."""
    return None if value is None or value == "" else str(value)


def normalise(raw: dict) -> dict:
    return {
        "scientific_name": (raw.get("scientificName") or "").strip(),
        "vernacular_name": raw.get("vernacularName") or None,
        "category": (raw.get("redlistCategory") or "").upper(),
        "overall_group": raw.get("overallSpeciesGroup"),
        "taxon_id": _as_str(raw.get("taxonId")),
        "arter_dk_id": _as_str(raw.get("arterDkId")),
    }


def is_hidden(category: str) -> bool:
    return category.upper() in REDLIST_HIDDEN_CATEGORIES


def iter_assessments(round_: str = ROUND) -> Iterator[dict]:
    """Yield normalised fungal assessments (`overallSpeciesGroup == "Svampe"`)."""
    page, pages = 1, 1
    while page <= pages:
        payload = get_json(
            BASE,
            {
                "vurderingsrunde": round_,
                "speciesGroup": SPECIES_GROUP,
                "page": page,
                "per_page": PAGE_SIZE,
            },
        )
        for raw in payload.get("data", []):
            record = normalise(raw)
            if record["overall_group"] == SPECIES_GROUP and record["scientific_name"]:
                yield record
        pages = int(payload.get("pages", page))
        page += 1


def hidden_scientific_names(assessments: list[dict]) -> set[str]:
    """Lower-cased scientific names whose category is in the hide-set."""
    return {a["scientific_name"].lower() for a in assessments if is_hidden(a["category"])}
