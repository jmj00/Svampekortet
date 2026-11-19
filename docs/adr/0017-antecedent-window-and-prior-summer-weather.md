# 17. A 60-day precipitation window and a prior-summer legacy feature

Date: 2026-09-11

## Status

Accepted. `WEATHER_FEATURES` (`pipeline/model/weather.py`) gains
`precip_60d_mm` and `prior_summer_precip_mm`; the weather term's fit gate moves
from one shared coverage cutoff to a per-feature one.

## Context

The literature review this ADR follows from (see the project's research
notes, not a doc in this repo) flagged two gaps against the weather term
ADR-0006 shipped:

- **A longer antecedent window.** Several field studies find cumulative
  precipitation summed over a 30-to-60-day-prior window carries signal the
  most recent month alone doesn't; Svampekortet's `precip_14d_mm`/
  `precip_30d_mm` stop at 30 days.
- **A prior-year legacy signal.** Across multi-decade series, the *previous*
  year's growing-season conditions are repeatedly the single best predictor of
  the *current* year's fruiting -- a wet prior summer lets the mycelium build
  the carbohydrate reserve it spends on fruiting bodies the following autumn.
  Nothing in the model looked back further than the query date's own 30-day
  window at all.

Both are additions to the *existing* weather-term machinery (`WeatherModel`'s
per-feature Gaussian likelihood, geometric-mean combine), not a new axis --
unlike ADR-0016's biotope term, there was no reason to expect either would
behave differently in kind, only in degree.

### The coverage-gating problem

The original weather term gated all four features by one shared cutoff:
`precip_days_covered >= FULL_WINDOW_DAYS` (28 of the last 30 days present),
applied uniformly because every existing feature shared the same 30-day
window. `precip_60d_mm` needs a wider window (60 days) and
`prior_summer_precip_mm` an entirely different, earlier one (the *previous*
calendar year's June-August) -- neither fits that one shared gate.

Fixed by making the gate per-feature (`coverage_column_and_threshold`) and
relaxing `WeatherModel.from_stats` to skip a feature that's individually
missing or degenerate rather than disabling the whole term (previously: any
one unfittable feature zeroed out every feature). This is a strict robustness
improvement independent of the two new features -- a species with, say, three
of four features fittable now gets three-quarters of a term instead of none.

Deriving both required a schema change to `observation_weather`
(`pipeline/derive/sql/weather_features.sql`): `precip_60d_mm` needed the join
widened from 30 to 60 days, and `prior_summer_precip_mm` needed a *second*,
separately dated join (the previous year's Jun-Aug window never overlaps the
antecedent one). Aggregating both against the same observation in one query
without splitting them into separate CTEs first would fan out -- two
independent one-to-many joins on the same cell, summed together, multiply
each other's totals. The same split applies to `current_conditions.sql` (the
live per-cell vector) and `negative_weather.sql` (the backtest's synthetic
negatives).

## What the numbers said

Real backtest, both features added together, six core species, all covered
observations re-derived from the live DMI archive:

| species | week_matched AUC | calendar_random AUC |
| --- | --- | --- |
| cantharellus-cibarius | 0.876 -> **0.883** | 0.939 -> 0.938 (flat) |
| boletus-edulis | 0.815 -> **0.820** | 0.932 -> **0.939** |
| imleria-badia | 0.868 -> **0.870** | 0.953 -> **0.954** |

Modest, but consistently non-negative across both regimes and every core
species -- a materially different outcome than ADR-0016's biotope attempt,
which regressed `week_matched` outright for half the core species. All six
pass both gates with margin.

## Decision

**Ship both features as ordinary members of `WEATHER_FEATURES`.** No new axis,
no new combine logic -- they compete for weight in the same geometric-mean
term the existing four features already share, gated for coverage the same
way (just against their own window instead of the shared one).

## Consequences

- `observation_weather`, `current.json`'s per-cell vector, and the backtest's
  synthetic-negative query all carry two new columns each (value +
  coverage-count pair): `precip_60d_mm`/`precip_60d_days_covered` and
  `prior_summer_precip_mm`/`prior_summer_days_covered`.
- `WeatherModel.from_stats`'s per-feature (not all-or-nothing) fitting is now
  the general rule, not a special case for these two -- any future weather
  feature with its own coverage requirement follows the same
  `coverage_column_and_threshold` pattern.
- `web/src/score.ts`'s `conditionsScore` mirrors the per-feature coverage gate
  (`COVERAGE_OVERRIDES`) exactly; `weatherScore` itself needed no change since
  it was already generic over whatever feature names show up in both the
  model and the observed vector.
- No UI change: both features fold into the single "Vejr" bar the conditions
  card already shows.
