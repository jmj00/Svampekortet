# pipeline/publish

Writes the static payload the web app fetches, from the built DuckDB. Read-only,
no network. Output goes to `build/publish/` (git-ignored); the deploy step uploads it.

```sh
python -m pipeline.publish.site
```

- **`manifest.json`** — build `version`, `bbox`, `attribution` (the "Om data"
  strings), and a `species` index (slug, names, group, observation count, file).
- **`species/<slug>.json`** — per species: names, `group`, `edible`,
  `lookalike_risk`, `gbif_usage_key`, `redlist_category`, `description` (null until
  the hand-curated text exists), `observation_count`, `season_by_month` (12 ints),
  and `observations` as `[lon, lat, month]` triples (coordinates rounded to 4 dp).

- **`forests.json`** — `{name, lon, lat, area_m2}` per named forest (Danske
  Stednavne), listed west to east; `lon`/`lat` is a point inside the forest.
  Only written when the `named_forests` table exists (`manifest.forests` is
  null otherwise).
- **`forest-outlines-<n>.json`** — the same forests' simplified outlines, in
  the same order, split into files of at most 400 kB that each cover a band of
  the country. `manifest.forest_outlines` lists them as `{file, start, count,
  bbox}`; it is null when the `named_forest_outlines` table is missing, and the
  web app then decides "which forest is the pin in" from the points alone. The
  ring encoding is described in `forest_outlines_payload` and
  [ADR-0020](../../docs/adr/0020-forest-outlines-for-the-pin.md).

Only the MVP core species are published (see `pipeline/species.py`).

To refresh only the forest files (for the snapshot under `web/public/data`),
from a database that holds just the Stednavne pull:

```sh
python -m pipeline.ingest.stednavne --db build/forests.duckdb --raw-dir data/raw/stednavne
python -m pipeline.publish.site --forests-only --db build/forests.duckdb --out web/public/data
```
