"""Apply the review tool's include/exclude choices to the curated species scope.

    py scripts/apply_review_scope.py                 # read the live review state
    py scripts/apply_review_scope.py --state x.json  # read a saved copy instead
    py scripts/apply_review_scope.py --dry-run       # show the changes, write nothing

The review page (`scripts/build_photo_review.py`) stores a `scope` entry for
every species whose "Included in the app" switch differs from what the app has
today. This script folds those choices into `data/species_scope.json`, which
`pipeline.species.published_species()` reads, so the next deploy fits and
publishes exactly the curated set.

It only rewrites the scope file. Commit the result, redeploy the review page
(so its switches start from the new baseline) and clear the applied `scope`
entries from the live state, the same way description edits are graduated.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

from pipeline.species import (
    SCOPE_FILE,
    candidate_species,
    excluded_slugs,
    resolve_scope,
    species_slug,
)

LIVE_STATE_URL = "https://svampekortet-review.pages.dev/api/review-state"


def _load_state(path: Path | None) -> dict:
    if path is not None:
        return json.loads(path.read_text(encoding="utf-8"))
    request = urllib.request.Request(LIVE_STATE_URL, headers={"cache-control": "no-store"})
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 (fixed https URL)
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--state", type=Path, help="saved review state (default: fetch live)")
    parser.add_argument("--dry-run", action="store_true", help="print the changes, write nothing")
    args = parser.parse_args()

    candidates = candidate_species()
    names = {species_slug(s): s["danish_name"] for s in candidates}
    tiers = {species_slug(s): s["tier"] for s in candidates}
    current = excluded_slugs()
    choices = _load_state(args.state).get("scope") or {}
    excluded = resolve_scope(current, choices, set(names))

    for slug in sorted(excluded - current):
        print(f"  exclude  {names[slug]} ({slug}, {tiers[slug]})")
    for slug in sorted(current - excluded):
        print(f"  include  {names[slug]} ({slug}, {tiers[slug]})")
    if excluded == set(current):
        print("No scope changes to apply.")

    included = [slug for slug in names if slug not in excluded]
    n_core = sum(1 for slug in included if tiers[slug] == "core")
    print(f"In the app: {len(included)} of {len(names)} species ({n_core} core).")
    if not included:
        print("Refusing to write a scope that excludes every species.", file=sys.stderr)
        return 1

    if not args.dry_run and excluded != set(current):
        SCOPE_FILE.write_text(
            json.dumps({"excluded": sorted(excluded)}, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        print(f"Wrote {SCOPE_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
