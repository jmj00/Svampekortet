"""Shape contracts for the external APIs the pipeline and web app depend on.

Each `assert_*` raises AssertionError naming the field that is missing or changed
shape. Used two ways:

- `pipeline/tests/test_contracts.py` runs them on recorded fixtures (in CI, offline)
- `python -m pipeline.contracts` fetches a tiny live response from each API and
  runs them — the scheduled drift check; exits non-zero if anything changed.
"""

from __future__ import annotations

import os
from collections.abc import Callable

from pipeline.http import get_json

# Datafordeler's Adressevælgeren (ADR-0015) needs an API-Key on every request,
# unlike DAWA which it replaced. Reuses the same key the web app ships
# client-side (VITE_DATAFORDELER_API_KEY) -- safe to pass through here too,
# since it's already a public, client-exposed credential, not the pipeline's
# own OAuth Shared Secret.
_DATAFORDELER_API_KEY = os.environ.get("DATAFORDELER_API_KEY")


def _require(condition: object, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def assert_dmi_grid_items(payload: dict) -> None:
    features = payload.get("features")
    _require(isinstance(features, list) and features, "DMI: features[] missing or empty")
    geometry = features[0].get("geometry") or {}
    _require(geometry.get("type") == "Polygon", f"DMI: geometry.type is {geometry.get('type')!r}")
    _require(
        isinstance(geometry.get("coordinates"), list) and geometry["coordinates"],
        "DMI: geometry.coordinates missing",
    )
    props = features[0].get("properties") or {}
    for key in ("cellId", "from", "parameterId", "value"):
        _require(key in props, f"DMI: properties.{key} missing")
    _require(
        isinstance(props["cellId"], str) and props["cellId"].startswith("10km_"),
        f"DMI: cellId shape changed ({props['cellId']!r})",
    )
    _require(len(str(props["from"])) >= 10, "DMI: properties.from is not a date/time string")


def assert_redlist_assessments(payload: dict) -> None:
    for key in ("pages", "page", "total", "data"):
        _require(key in payload, f"RedList: payload.{key} missing")
    records = payload["data"]
    _require(isinstance(records, list) and records, "RedList: data[] missing or empty")
    for key in ("scientificName", "redlistCategory", "overallSpeciesGroup", "taxonId", "arterDkId"):
        _require(key in records[0], f"RedList: record.{key} missing")
    _require(
        isinstance(records[0]["scientificName"], str) and records[0]["scientificName"],
        "RedList: scientificName empty",
    )


def assert_gbif_occurrence_search(payload: dict) -> None:
    _require(isinstance(payload.get("count"), int), "GBIF occ: count missing or not an int")
    facets = payload.get("facets")
    _require(isinstance(facets, list), "GBIF occ: facets is not a list")
    if facets:
        _require(
            "field" in facets[0] and isinstance(facets[0].get("counts"), list),
            "GBIF occ: facet shape changed",
        )
        if facets[0]["counts"]:
            entry = facets[0]["counts"][0]
            _require("name" in entry and "count" in entry, "GBIF occ: facet count shape changed")


def assert_gbif_species_match(payload: dict) -> None:
    for key in ("usageKey", "scientificName", "rank", "matchType"):
        _require(key in payload, f"GBIF match: {key} missing")
    _require(isinstance(payload["usageKey"], int), "GBIF match: usageKey is not an int")


def assert_adressevaelger_search(payload: dict) -> None:
    """`GET adressevaelger.dk/soeg` -- the phonetic search step (ADR-0015),
    DAWA's `adgangsadresser/autocomplete` replacement. Returns candidate ids
    with no coordinates; `assert_adressevaelger_lookup` covers the
    coordinate-bearing follow-up call."""
    _require(
        payload.get("status") == "ok", f"Adressevælger search: status is {payload.get('status')!r}"
    )
    fund = payload.get("fund")
    _require(isinstance(fund, list) and fund, "Adressevælger search: fund[] missing or empty")
    first = fund[0]
    for key in ("type", "id"):
        _require(key in first, f"Adressevælger search: fund[0].{key} missing")


def assert_adressevaelger_lookup(payload: dict) -> None:
    """`GET adressevaelger.dk/husnumre/{id}` -- the per-candidate coordinate
    lookup. Coordinates arrive in EPSG:25832 (UTM32N), not WGS84 --
    `web/src/addresses.ts`'s `utm32nToWgs84` converts them; this only checks
    the fields are present and numeric, not the projection itself."""
    _require(
        payload.get("status") == "ok", f"Adressevælger lookup: status is {payload.get('status')!r}"
    )
    husnummer = payload.get("husnummer") or {}
    for key in ("husnummertekst", "adgangsadressebetegnelse", "vejnavn"):
        _require(key in husnummer, f"Adressevælger lookup: husnummer.{key} missing")
    postnummer = husnummer.get("postnummer") or {}
    for key in ("navn", "postnr"):
        _require(key in postnummer, f"Adressevælger lookup: husnummer.postnummer.{key} missing")
    koordinater = (husnummer.get("adgangspunkt") or {}).get("koordinater") or {}
    for key in ("x", "y"):
        _require(
            key in koordinater, f"Adressevælger lookup: adgangspunkt.koordinater.{key} missing"
        )
    _require(
        isinstance(koordinater.get("x"), (int, float))
        and isinstance(koordinater.get("y"), (int, float)),
        "Adressevælger lookup: adgangspunkt.koordinater.x/y not numeric",
    )


# fixture filename -> assertion (used by the recorded-response tests)
FIXTURE_CONTRACTS: dict[str, Callable[[object], None]] = {
    "dmi_10km_grid_items.json": assert_dmi_grid_items,
    "redlist_assessments.json": assert_redlist_assessments,
    "gbif_occurrence_search.json": assert_gbif_occurrence_search,
    "gbif_species_match.json": assert_gbif_species_match,
    "adressevaelger_search.json": assert_adressevaelger_search,
    "adressevaelger_lookup.json": assert_adressevaelger_lookup,
}

# name -> (fetch a tiny live response, assertion) for the drift check
_LIVE: dict[str, tuple[Callable[[], object], Callable[[object], None]]] = {
    "dmi": (
        lambda: get_json(
            "https://opendataapi.dmi.dk/v2/climateData/collections/10kmGridValue/items",
            {
                "parameterId": "mean_temp",
                "timeResolution": "day",
                "datetime": "2023-08-01T00:00:00Z/2023-08-03T00:00:00Z",
                "bbox": "9.4,56.1,9.6,56.3",
                "limit": 2,
            },
        ),
        assert_dmi_grid_items,
    ),
    "redlist": (
        lambda: get_json(
            "https://api.redlist.au.dk/public/v1/summary/assessments/",
            {"vurderingsrunde": "2019", "speciesGroup": "Svampe", "per_page": 2},
        ),
        assert_redlist_assessments,
    ),
    "gbif_occurrence": (
        lambda: get_json(
            "https://api.gbif.org/v1/occurrence/search",
            {"taxonKey": 5249504, "country": "DK", "limit": 0, "facet": "year", "facetLimit": 3},
        ),
        assert_gbif_occurrence_search,
    ),
    "gbif_species_match": (
        lambda: get_json("https://api.gbif.org/v1/species/match", {"name": "Boletus edulis"}),
        assert_gbif_species_match,
    ),
    "adressevaelger_search": (
        lambda: get_json(
            "https://adressevaelger.dk/soeg",
            {"tekst": "rådhuspladsen 1 københavn", "token": _require_datafordeler_key()},
        ),
        assert_adressevaelger_search,
    ),
    "adressevaelger_lookup": (
        # Rådhuspladsen 1, 1550 København V -- a stable real id, same as the
        # recorded fixture.
        lambda: get_json(
            "https://adressevaelger.dk/husnumre/0a3f507a-ec01-32b8-e044-0003ba298018",
            {"token": _require_datafordeler_key()},
        ),
        assert_adressevaelger_lookup,
    ),
}


def _require_datafordeler_key() -> str:
    if not _DATAFORDELER_API_KEY:
        raise RuntimeError("DATAFORDELER_API_KEY not set -- can't probe Adressevælgeren live")
    return _DATAFORDELER_API_KEY


def check_all() -> dict[str, str]:
    results: dict[str, str] = {}
    for name, (fetch, assertion) in _LIVE.items():
        try:
            assertion(fetch())
            results[name] = "ok"
        except Exception as err:  # noqa: BLE001
            results[name] = f"FAIL: {err}"
    return results


def main() -> None:
    results = check_all()
    for name, status in results.items():
        print(f"{name:<20} {status}")
    if any(status != "ok" for status in results.values()):
        raise SystemExit("external API contract drift detected")


if __name__ == "__main__":
    main()
