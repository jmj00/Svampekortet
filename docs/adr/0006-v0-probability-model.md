# 6. The v0 "conditions score" model

Date: 2026-09-01

## Status

Accepted. The "Backtesting — the ship gate" section is superseded by
[ADR-0007](0007-backtest-gate-two-negative-regimes.md): the full model does not
beat the habitat-only baseline against week-matched negatives, so the gate now
uses two negative-sampling regimes and the isotonic calibration is deferred.
The "Score" section's *product, then calibrate* is superseded by
[ADR-0008](0008-geometric-mean-score-combine.md): the value is the **geometric
mean** of the axes (monotone in the product, so the gate is unaffected) and
calibration stays off — a per-axis calibrator was measured and rejected there.
[ADR-0009](0009-calibration-measured-and-not-adopted.md) measured the two
remaining calibration routes on the combined score and adopted neither. The
habitat term's KDE now runs over ~660 m localities, not raw observations
([ADR-0011](0011-effort-debias-habitat-density.md)).

## Context

The MVP needs to answer: *given a place and today's date, how favourable is it
for finding species X?* The data is **presence-only** — Svampeatlas records where
someone found a mushroom, never where one was absent — so a plain discriminative
classifier would need fabricated absences.

What we have after Phase 1:

- `observations` — 11,843 georeferenced, dated finds of the 6 species in Jutland
  (coordinate uncertainty p50 50 m / p90 250 m).
- `weather_daily` — the DMI 10 km grid, `mean_temp` + `acc_precip`, daily,
  **2011–present** (the grid's history does not go earlier).
- `observation_weather` — per observation: nearest cell, and antecedent weather
  (`precip_{7,14,30}d_mm`, `mean_temp_{7,14,30}d_c`, `dry_days_30d`). 8,044
  observations have a full 30-day window; the rest predate 2011.

The literature approach is species-distribution models (MaxEnt, boosted trees) for
habitat plus weather-driven phenology models for timing. v0 is a deliberately
transparent stand-in that sidesteps the presence-only problem by scoring rather
than classifying.

## Decision

### Output

A **"conditions score" 0–100**, not a probability of finding a mushroom — the app
must not over-claim (see the safety framing). It ranks places/times by how
typical current conditions are for this species fruiting there. Shown with a
**confidence** level and *"based on N finds within X km"*.

### Score = habitat × seasonality × weather

Each term is in `[0, 1]`. *(ADR-0008: the displayed 0–100 value is the geometric
mean of the axes, not their bare product; calibration stays off.)*

1. **Habitat** — a Gaussian kernel-density surface over that species' past
   observation points. Bandwidth per species = `1.5 ×` the median distance from a
   *locality* (finds thinned to a ~330 m grid, so revisited spots don't collapse
   the spacing) to its 3rd-nearest locality, clamped to `[1.5, 8]` km. On the
   real data this gives ~2–4 km, ordered by how patchy the species is (the
   pine-plantation *Suillus* widest). The `1.5` factor was tuned on the backtest
   (ADR-0007). Continuous in space; evaluated at the query point. Coordinate
   uncertainty is ignored in v0 (noted as a refinement).

2. **Seasonality** — a circular kernel density (wrapped Gaussian) over the
   day-of-year of that species' finds, normalised to peak = 1. Month-level
   fallback where dates are imprecise.

3. **Weather** — for the query cell and date, compute the same antecedent
   features as `observation_weather`. Score how typical they are for this
   species' historic fruitings: a per-feature Gaussian likelihood under the
   historic mean/sd from `observation_weather`, combined across features. Missing
   weather (pre-2011, or cell/date gap) → weather term = neutral (1), confidence
   lowered. `dry_days_30d` is the drought proxy (ADR direction).

### Confidence

Driven by the count of observations within the habitat bandwidth and whether
weather was available. Low count → "få fund her".

### Backtesting — the ship gate

- **Temporal split:** fit on observations up to 2021; evaluate on the 2022–2025
  fruiting seasons.
- **Positives:** held-out observations. **Negatives:** background points sampled
  in space (Jutland) and matched weeks in time.
- **Metrics:** ROC-AUC, precision@k (of the top-k grid cells, how many had a
  real find), and a calibration curve.
- **Baseline:** the habitat term alone (observation density, no season, no
  weather). **The full model must beat this baseline on the held-out seasons or
  it does not ship.**
- **Property tests (CI):** score rises with more nearby observations; drops
  off-season; drops when 30-day precipitation is near zero for these
  moisture-dependent species.
- **Golden locations:** a few known chanterelle/bolete spots with expected
  qualitative output.

### Where it runs

`pipeline/model/` produces per-species artifacts — habitat kernel parameters and a
rasterised habitat grid, the seasonality curve, and the historic weather-feature
distributions. These are published alongside the payload (ADR-0002,
static-precompute), so the score for an arbitrary pin is a small lookup +
combination done client-side or in a thin function. "Current conditions" per cell
come from keeping `weather_daily` fresh in the scheduled build.

## Consequences

- No fabricated absences; every term is interpretable and independently testable.
- Spatial resolution of the weather term is the 10 km grid; the habitat term is
  continuous. Acceptable for "which forest, roughly when".
- Calling it a conditions score, not a probability, keeps the claim honest and
  matches the safety posture.
- **Deferred to a stronger model (Phase 3):** environmental covariates (soil,
  forest type, host tree, topography), per-species MaxEnt / gradient-boosted
  models, spatial autocorrelation, proper uncertainty quantification, and
  pre-2011 weather from a reanalysis product if pre-2011 observations matter.

  > **Soil/forest-type covariates tried in
  > [ADR-0016](0016-biotope-advisory-not-scored.md).** Real per-species signal
  > (confirmed against CORINE + GEUS), but folding it into the scored product
  > regressed the ADR-0007 gate for half the core species without a
  > compensating gain elsewhere. It ships as advisory context on the
  > conditions card instead, not as a fourth scored term.
