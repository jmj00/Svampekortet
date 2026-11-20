"""One-off: pick a few CC-licensed photos per MVP species and write data/images/<slug>.json.

Source: iNaturalist Research-Grade observations via the GBIF occurrence API,
filtered to CC0 / CC BY images whose accepted taxon is the species. Danish photos
are preferred; species with fewer than PER_SPECIES CC records in Denmark fall
back to worldwide (same species across northern Europe). Selection is
deterministic (lowest GBIF occurrence keys) so re-runs are stable and a later
review can diff. Every image is written with `reviewed: false`.

    python scripts/pull_species_images.py            # all core species
    python scripts/pull_species_images.py boletus-edulis

This is a content-authoring tool, not part of the pipeline. Re-run only to seed or
extend the shortlist; edits after review stay in git.
"""

from __future__ import annotations

import json
import sys

from pipeline.config import DESCRIPTIONS_DIR
from pipeline.http import get_json
from pipeline.species import Species, published_species

INAT_RG_DATASET = "50c9509d-22c7-4a22-a47d-8c48425ef4a7"
CC_LICENSES = ["CC0_1_0", "CC_BY_4_0"]
PER_SPECIES = 3
POOL = 60

IMAGES_DIR = DESCRIPTIONS_DIR.parent / "images"
LICENCE_LABEL = {
    "http://creativecommons.org/licenses/by/4.0/": "CC BY 4.0",
    "http://creativecommons.org/publicdomain/zero/1.0/": "CC0 1.0",
}


def _slug(species: Species) -> str:
    return species["scientific_name"].lower().replace(" ", "-")


def _search(
    species: Species, *, country: str | None, verbatim_name: str | None = None
) -> list[dict]:
    params = {
        "datasetKey": INAT_RG_DATASET,
        "mediaType": "StillImage",
        "license": CC_LICENSES,
        "limit": POOL,
    }
    if verbatim_name:
        params["verbatimScientificName"] = verbatim_name
    else:
        params["taxonKey"] = species["gbif_usage_key"]
    if country:
        params["country"] = country
    results = get_json("https://api.gbif.org/v1/occurrence/search", params).get("results", [])
    results.sort(key=lambda r: r.get("key", 0))

    picked: list[dict] = []
    for occ in results:
        image = next(
            (
                m
                for m in occ.get("media", [])
                if m.get("type") == "StillImage" and m.get("license") in LICENCE_LABEL
            ),
            None,
        )
        if image is None:
            continue
        picked.append(
            {
                "url": image["identifier"].replace("/original.", "/large."),
                "credit": image.get("creator") or image.get("rightsHolder") or "ukendt",
                "license": LICENCE_LABEL[image["license"]],
                "photo_url": image.get("references"),
                "observation_url": occ.get("references"),
                "source": "iNaturalist (Research Grade)",
                "reviewed": False,
            }
        )
    return picked


def candidate_images(species: Species) -> list[dict]:
    """Prefer Danish photos; fall back to worldwide for species with too few CC0 /
    CC BY iNaturalist records in Denmark. These are the same species across
    northern Europe, and every image is `reviewed: false` for a later check.

    When the GBIF key finds too few, search by the name iNaturalist wrote on the
    record (the species name, then each synonym). iNaturalist files the Lepista
    species under Collybia, and GBIF's backbone matches "Collybia nuda" only to
    the genus and "Collybia personata" to an unrelated species, so the key alone
    finds none of their photos."""
    searches: list[dict] = [{}]
    searches += [
        {"verbatim_name": name} for name in [species["scientific_name"], *species["synonyms"]]
    ]
    picked: list[dict] = []
    seen: set[str] = set()
    for search in searches:
        for country in ("DK", None):
            for img in _search(species, country=country, **search):
                if img["url"] not in seen:
                    seen.add(img["url"])
                    picked.append(img)
            if len(picked) >= PER_SPECIES:
                return picked[:PER_SPECIES]
    return picked[:PER_SPECIES]


def main() -> None:
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    wanted = set(sys.argv[1:])
    for species in published_species():
        slug = _slug(species)
        if wanted and slug not in wanted:
            continue
        images = candidate_images(species)
        path = IMAGES_DIR / f"{slug}.json"
        path.write_text(json.dumps(images, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"{slug}: {len(images)} images -> {path}")


if __name__ == "__main__":
    main()
