# 9. Calibrating the combined score: measured, not adopted

Date: 2026-09-03

## Status

Accepted. Closes the "calibration deferred / a future spatially resolved
calibrator" thread left open in
[ADR-0006](0006-v0-probability-model.md),
[ADR-0007](0007-backtest-gate-two-negative-regimes.md) and
[ADR-0008](0008-geometric-mean-score-combine.md). `fit.ATTACH_CALIBRATION` stays
`False`; the `calibration` slot on `SpeciesModel` stays the identity.

## Context

ADR-0006 asked for the raw score to be isotonically calibrated against backtest
outcomes. ADR-0007 deferred it: calibrating `habitat × seasonality × weather`
conflates the spatial and temporal axes. ADR-0008 measured **per-axis**
calibration and rejected it (it degrades the site-faithful species below their
habitat-only baseline), fixed the scale problem with a geometric-mean combine
instead, and noted the slot "stays open for a future spatially resolved
calibrator" on the single combined `[0, 1]` favourability.

This ADR measures that remaining option. Two calibrators, fit on the temporal
backtest split (fit ≤ 2021, score 2022–2025), each a monotone map applied to the
combined favourability `g = geometric_mean(axes)`:

- **I — isotonic vs backtest labels.** `IsotonicCalibrator.fit(g, label)` on the
  `calendar_random` evaluation (test finds as positives, 5 random Jutland
  grid-cell/date draws each as negatives). Scored two-fold so no point is
  evaluated by a calibrator fit on it.
- **P — percentile among historical finds.** The empirical CDF of `g` over the
  species' own training finds (those with a full 30-day weather window): a query
  scores `100 × fraction of past find-conditions at least this favourable`.
  Fit on training data only, so there is no held-out concern. Stored in the
  existing `IsotonicCalibrator` format (a knot per training-find percentile).

Measured per species: ROC-AUC in both negative regimes, Brier score and
expected calibration error (ECE) on `{test finds + calendar_random negatives}`,
the spread of the displayed value over held-out finds, the read at a golden
forest at its seasonal peak vs mid-January, and the golden-location gate.

## What the numbers said

Representative figures (six core species, dataset through 2026-09-01):

| treatment | `calendar_random` AUC vs current | Brier / ECE | held-out find p10/50/90 | golden gate |
| --- | --- | --- | --- | --- |
| **current** (geometric mean, no calibration) | — | 0.08 / 0.06 | ≈ 15 / 38 / 67 | passes |
| **I** (isotonic vs labels) | unchanged | **0.06 / 0.02** | ≈ 12 / 75 / 100, piled at 0 and 100 | passes |
| **P** (percentile among finds) | **±0.0000** (exact) | 0.08 / 0.07 | ≈ 3 / 40 / 88 | passes |

- **Neither calibrator changes any ranking the backtest measures.** Both are
  monotone in `g`, which is monotone in the raw product, so every
  `week_matched` / `calendar_random` AUC is identical to four decimals (P: byte
  identical). The ship gate is untouched — exactly as for the geometric mean in
  ADR-0008.
- **I only improves the label-fit metrics, and only by learning an artefact.**
  Brier and ECE drop because I is fit to reproduce `P(find)` at the backtest's
  **5:1 negative:positive sampling ratio** — a knob in `backtest.py`
  (`NEGATIVES_PER_POSITIVE`), not a real prior. The improvement is "I learned
  that ~17 % of these eval points are finds", which says nothing to a user. I
  also collapses the distribution onto its endpoints (half of all held-out finds
  land at 60–100, a large tie sits at 0), so the number stops being a smooth
  favourability.
- **P is a lateral move.** AUC identical, Brier/ECE slightly worse than the
  status quo, median find still ≈ 40. It widens the top end (excellent finds
  ≈ 85–93 instead of ≈ 65–76) and gives the value a clean reading — "better
  conditions than X % of this species' recorded finds" — and it is comparable
  across species by construction. But it also slams the bottom decile of genuine
  finds from ≈ 15 to ≈ 2, i.e. ~10 % of real finds would read near zero, and it
  adds a per-species artefact that is thin for the sparsest species
  (*Suillus variegatus*: 250 full-window training finds).

## Decision

**Ship neither. Keep the geometric-mean value with the calibration slot as the
identity.**

- I optimises a metric that is not meaningful for a score the product
  deliberately frames as *relative favourability, not a probability*
  (ADR-0006, the safety posture), and it makes the scale worse.
- P is defensible but the backtest shows no accuracy or ranking gain to pay for
  a live change to the user-facing number, a harsher low end, a TypeScript port
  of the isotonic map in `score.ts`, a payload change, and golden-threshold
  retuning.
- The geometric-mean combine (ADR-0008) already solved the only concrete problem
  calibration was meant to solve — a scale pinned near zero.

The `calibration` slot, `IsotonicCalibrator`, and the backtest's
`candidate_calibration` record stay in place: they cost nothing at
`ATTACH_CALIBRATION = False` and keep the door open if a later model (richer
habitat covariates, more species, a non-Jutland corpus) gives calibration
something to correct that a monotone rescale of today's three axes cannot.

## Consequences

- No code change: `ATTACH_CALIBRATION` was already `False`. This ADR replaces the
  "deferred / TODO" language about calibration in `docs/model-backtest.md`,
  `pipeline/model/README.md`, `backtest.py`, `species_model.py` and
  `calibration.py` with "measured, not adopted — see ADR-0009".
- The next lever for the model is a term, not a rescale: per-species seasonality
  width (currently a fixed `DEFAULT_SIGMA_DAYS = 15`), coordinate-uncertainty in
  the habitat kernel, or environmental covariates (ADR-0006's Phase-3 list).
- If the backtest's negative-sampling ratio or regimes change, the I result
  above is not portable; the P result (which uses no negatives) is.
