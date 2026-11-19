"""Spike: how many observations of each target species exist in Jutland?

Answers the decisive Phase 0 question: is there enough georeferenced data per
species (total, by year, by month) to model anything useful?

No API key required. Uses the GBIF `occurrence/search` faceting so it never has to
page through raw records.

    py -m pipeline.spikes.gbif_counts

Writes pipeline/spikes/out/gbif_counts.json plus a console summary.
"""

from __future__ import annotations

import json
from pathlib import Path

from pipeline.species import TARGET_SPECIES
from pipeline.spikes import use_utf8_stdout
from pipeline.spikes._http import get_json

GBIF = "https://api.gbif.org/v1"

# Counter-clockwise rectangle roughly covering Jutland (WGS84 lon/lat). Includes a
# little water and the western tip of Fyn; fine for a first count.
JUTLAND_WKT = "POLYGON((7.7 54.7, 11.3 54.7, 11.3 57.9, 7.7 57.9, 7.7 54.7))"

DATASETS = {
    "svampeatlas": "84d26682-f762-11e1-a439-00145eb45e9a",
    "arter.dk": "963a6b96-4d22-4428-86e4-afee52cf4a8e",
}

OUT = Path(__file__).parent / "out"
MIN_USABLE = 50  # georeferenced Jutland records over the last decade


def match_taxon(name: str) -> dict:
    return get_json(f"{GBIF}/species/match", {"name": name, "strict": "false"})


def occ_count(**params) -> int:
    params["limit"] = 0
    return get_json(f"{GBIF}/occurrence/search", params)["count"]


def facet_counts(field: str, **base) -> dict[str, int]:
    data = get_json(
        f"{GBIF}/occurrence/search",
        {**base, "limit": 0, "facet": field, "facetLimit": 1500},
    )
    out: dict[str, int] = {}
    for facet in data.get("facets", []):
        for entry in facet.get("counts", []):
            out[entry["name"]] = entry["count"]
    return out


def sample_records(taxon_key: int, n: int = 5) -> list[dict]:
    data = get_json(
        f"{GBIF}/occurrence/search",
        {
            "taxonKey": taxon_key,
            "country": "DK",
            "geometry": JUTLAND_WKT,
            "hasCoordinate": "true",
            "limit": n,
        },
    )
    return [
        {
            "year": r.get("year"),
            "license": r.get("license"),
            "coordinateUncertaintyInMeters": r.get("coordinateUncertaintyInMeters"),
            "datasetKey": r.get("datasetKey"),
            "issues": r.get("issues"),
            "hasMedia": bool(r.get("media")),
        }
        for r in data.get("results", [])
    ]


def main() -> None:
    OUT.mkdir(exist_ok=True)
    report: dict[str, dict] = {}
    verdicts: list[str] = []

    for sp in TARGET_SPECIES:
        name = sp["scientific_name"]
        match = match_taxon(name)
        key = match.get("usageKey")
        print(f"\n=== {sp['danish_name']}  ({name})  [{sp['tier']}]")
        print(
            f"    GBIF match: {match.get('scientificName')} "
            f"[{match.get('rank')}] usageKey={key} confidence={match.get('confidence')}"
        )
        if not key:
            print("    !! no GBIF backbone match -- check the spelling / synonym list")
            verdicts.append(f"{name}: NO MATCH")
            continue

        base = {
            "taxonKey": key,
            "country": "DK",
            "hasCoordinate": "true",
            "geometry": JUTLAND_WKT,
        }
        total = occ_count(**base)
        by_source = {label: occ_count(datasetKey=dk, **base) for label, dk in DATASETS.items()}
        by_year = facet_counts("year", **base)
        by_month = facet_counts("month", **base)

        last10 = {y: c for y, c in sorted(by_year.items()) if y.isdigit() and int(y) >= 2016}
        recent_total = sum(last10.values())
        month_line = {m: by_month.get(str(m), 0) for m in range(1, 13)}

        print(f"    Jutland georeferenced records (all years): {total}")
        print(f"    by source: {by_source}")
        print(f"    last 10 years: {last10}  (sum {recent_total})")
        print(f"    by month 1-12: {month_line}")

        verdict = "OK" if recent_total >= MIN_USABLE else "THIN -- consider dropping or widening"
        print(f"    verdict: {verdict}")
        verdicts.append(f"{name}: {recent_total} records since 2016 -> {verdict}")

        report[name] = {
            "danish_name": sp["danish_name"],
            "tier": sp["tier"],
            "gbif_usage_key": key,
            "gbif_scientific_name": match.get("scientificName"),
            "total_jutland": total,
            "by_source": by_source,
            "by_year": by_year,
            "by_month": by_month,
            "records_since_2016": recent_total,
            "verdict": verdict,
            "sample": sample_records(key),
        }

    out_path = OUT / "gbif_counts.json"
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print("\n" + "=" * 64)
    print("SUMMARY")
    for line in verdicts:
        print("  " + line)
    print(f"\nWrote {out_path}")
    print(
        f"\nRule of thumb: < ~{MIN_USABLE} georeferenced Jutland records since 2016 is "
        "too thin for a per-species model. Adjust the species list before building P1."
    )


if __name__ == "__main__":
    use_utf8_stdout()
    main()
