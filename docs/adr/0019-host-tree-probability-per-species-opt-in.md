# 19. Host-tree probability, scored per species

Date: 2026-09-12

## Status

Accepted, per species. `pipeline.model.host_tree` fits a real host-tree
affinity for every core species whenever a `host_tree_grid` table exists, but
`SpeciesModel.host_tree_scored` -- and therefore whether it reaches
`terms()`/`score()`/the ranked score at all -- is `True` for only one of the
six core species today, `HOST_TREE_SCORED_SPECIES = frozenset({"Craterellus
tubaeformis"})`. The other five stay exactly like biotope (ADR-0016): fitted,
published, never consulted. Add a species to that set only after it clears
the same bar this ADR describes, not by assumed host specificity -- see
"What the numbers said."

## Context

ADR-0016 shelved biotope (CORINE forest-type + GEUS soil-type) as advisory
because it was too coarse (2 km, 3 forest categories) relative to the
habitat term's own spatial precision to help *rank* real finds, even though a
feasibility check showed real per-species differentiation. The literature
review that followed this project's biotope work suggested the underlying
idea -- host-tree association predicts fruiting -- was sound; what failed was
the resolution and the categorical representation, not the ecology. This ADR
is a direct retest of that hypothesis at a resolution and representation that
might actually work: real per-species probability-of-occurrence maps
(Bonannella et al. 2022, 30 m native resolution, EU-wide Cloud-Optimized
GeoTIFFs on Zenodo), not a coarse land-cover category.

### Data source

The commonly-cited DOI for this dataset (`10.5281/zenodo.5818021`) redirects
to the wrong product -- presence/absence training points, not the probability
maps. `8273144` is a trend/slope-analysis product, also wrong. The real maps
are one Zenodo record per species; Zenodo's search API (not a web search
summary) was needed to find the correct record IDs. Filenames use a dot
between genus and species (`veg_fagus.sylvatica_anv.eml_...tif`), not the
underscore `HOST_TREE_SPECIES` uses for column/dict keys -- a real 404 hit and
fixed during ingest development. Denmark-relevant species with a confirmed
record: `fagus_sylvatica`, `picea_abies`, `pinus_sylvestris`, `prunus_avium`,
`quercus_robur`, `salix_caprea`. The 16-species dataset does not include
birch or aspen, so Leccinum (an extra-tier genus) gets no signal from this
term at all -- a known, permanent gap, not an oversight.

### Ingest

`pipeline.ingest.host_tree` windowed-reads *only* the Denmark bbox from each
published COG over HTTP (`rasterio` + GDAL's `/vsicurl/`) -- confirmed a real
partial read against the live Zenodo-hosted files, not a multi-gigabyte full
download, though still large enough (native 30 m over the whole bbox) to take
minutes and hit transient tile-fetch failures on a public host
(`TIFFFillTile: got 0 bytes, expected N`). Fixed with GDAL-level HTTP retry
env vars (`GDAL_HTTP_MAX_RETRY`/`RETRY_DELAY`/`TIMEOUT`, since a windowed read
issues thousands of internal tile range-requests and one flaky tile otherwise
aborts the whole read) plus a whole-read retry wrapper, and `--cache-dir`
caches each species' *raw windowed array* (not the resampled grid) so a
resolution change or a retry after a network failure never needs Zenodo
again.

This is a materially heavier pipeline dependency than anything used before
(`rasterio`/GDAL, vs. stdlib `urllib` + `duckdb` everywhere else) -- added
deliberately, with the user's explicit sign-off, after DuckDB's spatial
extension segfaulted on `ST_Read_Meta` against a live raster URL and was
abandoned.

### Resolution

The original 500 m grid (`GRID_DEG = 0.0045`, matching biotope's design
intent of "an order of magnitude finer than biotope's 2 km") produced an
impractically large publishable grid: 23-29 % of all 1.23M grid points passed
`MIN_PROBABILITY_TO_INCLUDE` at *any* threshold from 0.02 to 0.5, because
common tree species have smoothly-decaying probability surfaces across most
of Denmark's land area, unlike biotope's sharp polygon-based categories --
the threshold barely prunes anything. A resolution sweep (average-pooling the
same continuous probability at 30 m/300 m/500 m/1 km/2 km) showed a continuous
probability clearly beats baseline even at biotope's exact 2 km scale (week
AUC ~0.926 vs ~0.90 baseline for Suillus variegatus) -- proving biotope's
original failure was about *both* coarse resolution and the lossy categorical
representation, not resolution alone.

But the ingest's nearest-neighbour sampling (one native pixel per output
cell) is measurably noisier than the sweep's average-pooling: at 2 km,
gridded nearest-neighbour gave week AUC 0.9134/0.8376 (variegatus/luteus) vs.
average-pooling's 0.9264 at the same resolution -- luteus barely above its
own baseline (~0.83). At ~1 km (`GRID_DEG = 0.01`), nearest-neighbour
recovers a clean margin (0.9324/0.8847), the resolution shipped. The real
ingest against production: 249,271 grid points, 71,817 classified cells --
close to biotope's ~30K order of magnitude, not the ~300K the 500 m grid
would have produced.

## What the numbers said

A pilot (direct point-sampling of the raw host-tree probability against real
backtest positives/negatives, reusing `backtest.py`'s own train/test split)
showed a strong, clean win in isolation for both Suillus species -- AUC
~0.93/0.88 for the host-tree signal alone. That result did **not** survive
integration into the full model. A full-model A/B (same real backtest,
`raw = habitat x seasonality x weather x host_tree`, all 6 core species) was
mixed-to-negative for most species; a weight sweep
(`host_tree**k` for `k` from 1.0 down to 0.0) followed by an 8-seed
robustness check (resampling only the negatives, holding the real positives
fixed, to separate a genuine effect from one lucky/unlucky draw) confirmed
the pattern was real, not noise -- the paired delta's standard deviation
across seeds was small relative to its mean for nearly every species/regime:

| species | week_matched Δ (full vs. off) | calendar_random Δ | verdict |
| --- | --- | --- | --- |
| craterellus-tubaeformis | +0.0122 (σ 0.0030) | +0.0002 (σ 0.0018) | **clean, seed-robust win** |
| boletus-edulis | +0.0129 (σ 0.0043) | −0.0116 (σ 0.0016) | split -- no weight helps both |
| imleria-badia | +0.0102 (σ 0.0032) | −0.0119 (σ 0.0025) | split -- no weight helps both |
| cantharellus-cibarius | −0.0047 (σ 0.0040) | −0.0142 (σ 0.0033) | net negative |
| suillus-luteus | −0.0142 (σ 0.0057) | **−0.0330 (σ 0.0019)** | harmful at every weight |
| suillus-variegatus | −0.0168 (σ 0.0039) | −0.0102 (σ 0.0024) | harmful at every weight |

The two species with the strongest, most textbook-specific host relationship
in this corpus -- Suillus luteus and S. variegatus, obligate pine partners,
exactly what the pilot validated -- were the two most harmed at every weight
tried, monotonically. Literature-known host specificity predicted the
*wrong* species.

### The oak-dominance bug (real, but not the cause)

Restricting each species' score to only its top-1 fitted-affinity tree
revealed why: `quercus_robur` (oak) was the single top-affinity tree for
*every* core species, including both Suillus pine specialists.
`HostTreeModel.fit`'s original formula -- the raw mean probability at a
species' own finds -- has no correction for how common a tree's probability
is across Denmark generally; oak's probability is high almost everywhere
there's any forest at all, so it swamps every species' affinity as a generic
"is this forest" signal regardless of real ecology. Dividing by each tree's
background mean across the whole grid (`HostTreeGrid.background_means`,
an enrichment ratio rather than a raw mean) fixed the attribution cleanly:
pine became the correctly top-enriched tree for every species, Suillus
included. It did **not** change the backtest verdict -- re-run with the
corrected affinity, Suillus's harm was essentially unchanged (luteus
calendar_random: −0.0304 vs. −0.0330 before). The bug was real and worth
fixing (better ecological attribution, kept regardless), but it was not why
host_tree hurts Suillus's ranking.

The likely actual cause: Suillus is a well-sampled, spatially concentrated
species, so its habitat KDE term (fit directly on its own real find
locations) already captures essentially all the useful spatial information a
coarser, ~1 km tree-probability grid could add. Layering a second, noisier
spatial signal on top of a term that's already saturated mostly adds sampling
noise, not new information -- the opposite of craterellus-tubaeformis, a
broader generalist whose habitat term has more room left for a genuinely new
signal to help.

## Decision

Fit `HostTreeModel` (with the enrichment-ratio affinity) for every core
species whenever `host_tree_grid` exists -- real, useful data, and a species
not currently scored may clear the bar in the future once re-validated the
same way. But gate whether it's actually *scored* per species via
`HOST_TREE_SCORED_SPECIES`, decided empirically against the real backtest
(pilot → full-model A/B → weight sweep → 8-seed robustness check), not by
assumed host specificity. Today that set contains only
`"Craterellus tubaeformis"`. `SpeciesModel.host_tree_scored: bool = False` is
the gate `terms()`/`score()` check; a species with it `False` behaves exactly
like biotope -- fitted and published, never consulted, `host_tree_available`
always `False`. The web port (`web/src/hostTree.ts`, `score.ts`) mirrors the
same gate via `model.host_tree_scored`.

## Consequences

- `pipeline.model.host_tree.HOST_TREE_SCORED_SPECIES` is the one place that
  needs editing to add another species later -- after it clears the same
  bar (a real, seed-robust gain on at least one backtest regime with no
  offsetting cost on the other), not before.
- `model/<slug>.json` publishes `host_tree` (the fitted affinity dict, an
  enrichment ratio per tree) and `host_tree_scored` for every core species,
  regardless of whether that species is in the scored set -- a future
  maintainer deciding whether to add a species can read its already-fitted
  affinity without re-running the ingest.
- `pipeline.ingest.host_tree` and its `rasterio`/GDAL dependency ship to
  production: the grid itself (`host_tree_grid.json`) is shared, per-tree
  infrastructure, independent of which mushroom species are scored against
  it.
- The ADR-0007 backtest gate passed for all 6 core species with the final
  design (`passed_all: true`); craterellus-tubaeformis's week_matched AUC
  rose from a 0.7356 habitat-only baseline to 0.7562 with host_tree scored,
  calendar_random from 0.7429 to 0.8781.
- If host_tree is revisited for another species, re-run the same
  pilot → A/B → weight sweep → multi-seed robustness pipeline against real
  data first -- a single-seed A/B, as this investigation's first pass showed,
  is not enough to trust a per-species decision on.
