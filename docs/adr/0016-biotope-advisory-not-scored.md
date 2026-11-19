# 16. Forest-/soil-type as advisory context, not a scored term

Date: 2026-09-11

## Status

Accepted. `pipeline/model/biotope.py` fits a per-species forest-/soil-type
affinity and `pipeline/ingest/biotope.py` publishes a Denmark-wide
classification grid, but neither joins `species_model.combine()` or the
backtest gate (ADR-0007). It ships as read-only context on the conditions
card (`web/src/biotope.ts`) instead.

## Context

The model's habitat term (ADR-0006, ADR-0011) ranks a query point by density of
*past reported finds*. That has a known bias this project wants to counter:
foragers under-report good spots to keep them secret, so the habitat term can
only ever be as good as the reporting behaviour that feeds it. The original
idea, floated alongside ADR-0006's "Phase 3" list (soil, forest type, host
tree, topography), was to add a site-characteristic term that could plausibly
surface a good spot *independent of whether anyone has ever reported a find
there* — using freely available forest-type and soil-type maps as a proxy for
habitat suitability.

### Feasibility, in three stages

Before building anything, three geodata sources were bulk-pulled with real
polygon geometry (not centroids) and spatial-joined in DuckDB (`spatial`
extension, R-tree indexed) against the real `observations` table, comparing
each species' category distribution against the true area-weighted baseline:

1. **Danske Stednavne `Naturareal` (all types, 12,483 polygons).** Real
   forest-vs-not enrichment (74.5 % of finds in `skovPlantage` vs. 59.2 % area
   share), but weak *per-species* differentiation — all six core species sat in
   a narrow 54–89 % `skovPlantage` band, barely distinguishable from each
   other. Not worth a term on its own.
2. **CORINE Land Cover 2018 forest type** (broadleaf/coniferous/mixed, 8,442
   polygons nationally). Strong, biologically plausible per-species signal:
   *Suillus variegatus* 63 % coniferous vs. 1 % broadleaf; *Craterellus
   tubaeformis* the highest broadleaf share of the six; *Boletus edulis*
   roughly balanced across all three types.
3. **GEUS Jordartskort 1:200,000 soil type** (`tsym`, 24,194 polygons
   nationally, a separate public ArcGIS REST service — no Datafordeler
   credentials, unlike the rest of this pipeline). Strong, *convergent* signal:
   both pine-associated *Suillus* species favour `ES` (flyvesand / aeolian
   sand) far more than every other species tested; *Boletus edulis* favours
   `ML` (moræneler / clay till) instead.

CORINE and GEUS corroborating each other independently — a pine-loving genus
reading as both "coniferous forest" and "sandy soil" from two unrelated
sources — was read as real ecological signal, and, critically, neither source
depends on observation history at all. That result is what "Build the model"
(this ADR) set out to turn into a shipped term.

### What the backtest said

`pipeline/ingest/biotope.py` bulk-pulls both sources once into a ~2 km grid
(`GRID_DEG`, the same "round to a grid, dict-key it" idiom as
`habitat.py`'s `DENSITY_GRID_DEG`) and publishes `model/biotope_grid.json`;
`pipeline/model/biotope.py` fits a per-species `CategoryAffinity` (peak-
normalised frequency, unseen categories floored at `UNSEEN_CATEGORY_SCORE =
0.15` rather than zero) for forest type and soil type, combined as
`sqrt(forest_affinity × soil_affinity)`.

Folded into the raw score exactly like weather — `raw = habitat × seasonality
× weather × biotope`, joining the geometric-mean combine only when a site is
classified — it **regressed the `week_matched` ship gate for three of six core
species** (`cantharellus-cibarius`, `boletus-edulis`, `imleria-badia`), each by
more than `WEEK_MATCHED_TOLERANCE` (0.035) below the habitat-only baseline.

A weight sweep (`raw = habitat × seasonality × weather × biotope^w`, real
backtest, real data) localised why:

| `w` | week_matched | calendar_random AUC (cantharellus) |
| --- | --- | --- |
| 1.0 (full, as designed) | fails for 3/6 core species | 0.933 |
| 0.25 | passes for all six | 0.938 |
| 0.0 (excluded entirely) | passes (trivially) | 0.939 |

Two findings, together, ruled out folding this term into the score at any
useful weight:

- Sweeping `UNSEEN_CATEGORY_SCORE` from 0.15 to 0.8 changed the week_matched
  shortfall by nothing measurable — the regression is not "the unseen-category
  floor is too harsh," it is the ordinary seen/unseen category *gradient*
  itself acting as spatial noise. The ~2 km grid is coarser than the habitat
  term's own spatial precision, so multiplying it into a product that is
  already well-separated by habitat alone (`week_matched`'s task, where dates
  are matched and only spatial signal remains) subtracts more ranking
  precision than it adds.
- `calendar_random` AUC is *highest with biotope excluded entirely*
  (`w = 0.0`). The seasonality term already accounts for nearly all of that
  regime's discrimination — negatives spread across the whole calendar are
  mostly off-season and separate from positives on that axis alone — so
  biotope's independently-real per-species differentiation does not survive
  contact with the AUC-ranking task on real historical finds. Habitat +
  seasonality + weather already captures most of what is learnable about
  *where people have actually found things*; biotope is largely redundant
  there.

There is also a structural limit the backtest cannot see past: it measures
"does this rank known historical finds well," which by construction cannot
measure this term's actual goal — surfacing a plausible spot with **no**
historical record. A term could be exactly right about that and the backtest
would have no way to reward it, only to penalise any ranking noise it adds
along the way.

## Decision

**Fit and publish the term; do not score with it.**

- `SpeciesModel.biotope: BiotopeModel | None` is fit in `fit.py` (from the
  species' own observations, classified through the published grid) and
  serialised in each species' JSON, but `species_model.combine()`,
  `SpeciesModel.terms()` and `.score()` take no `site`/`biotope` argument at
  all — the ADR-0007 gate never sees it, so there is nothing here for that
  gate to fail on a future run.
- `manifest["terms"]` stays `["habitat", "seasonality", "weather"]` — that key
  now specifically means "feeds the ranked score," not "published in the
  payload."
- The web app (`web/src/biotope.ts`) reads a species' `biotope` affinities and
  the published grid directly to describe a pin's site — forest type and soil
  type, each labelled in Danish (CORINE's three codes; GEUS's `tsym` labels
  taken verbatim from the layer's own ArcGIS renderer, since GEUS does not
  publish a separate legend document) and qualified `typical` / `seen` /
  `unusual` / `unknown` against the open species' affinity — on the conditions
  card. It never reaches `score.ts`.
- `pipeline/ingest/biotope.py` stays a manual, on-request step (deploy.yml's
  `biotope: refresh` input), like named forests (ADR-0014): land cover and
  surface geology change on a geological timescale, not weekly.

This keeps the one part of the original hypothesis that survived contact with
real data — the categorical signal is real, and it is independent of
observation history — while not letting an unvalidatable claim ("this helps
find secret spots") ship inside a number the backtest is supposed to gate.

## Consequences

- No change to the ranked score, golden-location checks, or the backtest gate
  itself; `golden.py`'s `model.score(lon, lat, peak_doy)` calls needed no
  changes since they never passed a `site` argument to begin with.
- New published artifacts: `model/biotope_grid.json` (Denmark-wide, ~2 km
  cells, `null` for both fields where the pipeline has run but a cell has no
  classification) and each species' `biotope` field, both optional — a build
  without `pipeline.ingest.biotope` having ever run publishes `biotope_grid:
  null` and every species' `biotope: null`, and the advisory card simply
  doesn't show. `test_payload_contract.py` covers both shapes.
- If a later model gives the categorical signal a fair test — finer-grained
  site classification closer to the habitat term's own spatial precision, or a
  fundamentally different way to fold in site characteristics than "another
  multiplicative axis" — this ADR's backtest numbers are the baseline to beat,
  and `BiotopeModel`/`BiotopeGrid` (Python) plus `biotope.ts` (web) are already
  in place to build on.
- The three feasibility datasets (Naturareal, CORINE, GEUS) were pulled as
  one-off scratch analysis, not committed; `pipeline/ingest/biotope.py` is the
  one path that reaches production data.
