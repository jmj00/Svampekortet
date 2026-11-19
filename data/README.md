# data

Small, hand-maintained reference files that belong in version control.

| File | Purpose |
|---|---|
| `keyword_map.json` | Seed for the curated guided-search: Danish free-text and chips → a filter over the target species. |
| `species_scope.json` | The curated scope: slugs of candidate species left out of the app. Set through the review tool's include/exclude switches and written by `scripts/apply_review_scope.py`; read by `pipeline.species.published_species()`. |

**Not here:** raw observation dumps, Darwin Core archives, DMI extracts, DuckDB
files. Those are downloaded or generated and are git-ignored (`data/raw/`).
The pipeline's *published* artifacts (grids, tiles) are build outputs, not source.
