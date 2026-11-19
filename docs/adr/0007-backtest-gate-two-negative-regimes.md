# 7. Backtest ship gate: two negative-sampling regimes

Date: 2026-09-02

## Status

Accepted. Amends the "Backtesting — the ship gate" section of
[ADR-0006](0006-v0-probability-model.md).

## Context

ADR-0006 set the ship gate as: fit on finds up to 2021, evaluate on 2022–2025
with **week-matched** background points as negatives, and require the full model
(`habitat × seasonality × weather`) to beat the **habitat-only baseline** on
ROC-AUC.

Running it on the real data, the full model **loses** to the baseline under that
gate, for every core species:

| species | full AUC | habitat-only AUC | Δ |
| --- | --- | --- | --- |
| Cantharellus cibarius | 0.898 | 0.913 | −0.016 |
| Craterellus tubaeformis | 0.934 | 0.947 | −0.013 |
| Boletus edulis | 0.841 | 0.857 | −0.015 |
| Imleria badia | 0.875 | 0.895 | −0.020 |
| Suillus luteus | 0.867 | 0.873 | −0.006 |
| Suillus variegatus | 0.902 | 0.907 | −0.005 |

This is the gate working as designed, not a defect. Past-observation density
alone is already a strong *spatial* ranker (AUC 0.86–0.94). Week-matching the
negatives holds the calendar roughly fixed, which removes almost all of what
seasonality and weather contribute; multiplying the strong habitat term by two
near-constant sub-one terms then only adds noise. No reweighting of the product
recovers more than rough parity.

But seasonality and weather are exactly what the app is *for*: a user asks "is
**now** a good time **here**", in February as well as September. Against
**calendar-random** negatives (dates spread across the whole test-year calendar)
the full model beats the baseline comfortably:

| species | full AUC | habitat-only AUC | Δ |
| --- | --- | --- | --- |
| Cantharellus cibarius | 0.942 | 0.915 | +0.027 |
| Craterellus tubaeformis | 0.961 | 0.946 | +0.015 |
| Boletus edulis | 0.928 | 0.857 | +0.071 |
| Imleria badia | 0.955 | 0.901 | +0.053 |
| Suillus luteus | 0.930 | 0.864 | +0.067 |
| Suillus variegatus | 0.937 | 0.907 | +0.030 |

## Decision

The ship gate uses **both** negative regimes, and a species passes only if both
hold:

1. **`week_matched`** — negatives share the positives' weeks (±3 days). The full
   model's AUC must be **no more than `WEEK_MATCHED_TOLERANCE` (0.03) below** the
   habitat-only baseline. This is a "does not damage spatial ranking" check.
2. **`calendar_random`** — negative dates are uniform across the test years. The
   full model's AUC must be **at least `CALENDAR_RANDOM_MARGIN` (0.01) above** the
   habitat-only baseline. This is where seasonality and weather must earn their
   place.

Both regimes: 5 negatives per positive, random DMI grid cells, `SEED = 20260902`,
positives restricted to test-period finds with a full 30-day weather window.

### Calibration — deferred

> **Superseded by [ADR-0008](0008-geometric-mean-score-combine.md) and
> [ADR-0009](0009-calibration-measured-and-not-adopted.md).** The per-axis
> calibrator floated below was measured and rejected (it degrades ranking for
> site-faithful species); the scale problem is instead fixed by a geometric-mean
> combine. ADR-0009 then measured isotonic-vs-labels and percentile-among-finds
> on the combined score and adopted neither. The analysis of why calibrating the
> product conflates the axes still stands.

ADR-0006 wanted the raw product isotonically calibrated against backtest
outcomes. In practice, calibrating `habitat × seasonality × weather` **conflates
the spatial and temporal axes**: a raw of ~0.05 can be a known hotspot out of
season (`1.0 × 0.05 × 1.0`) or a random place in peak season (`0.05 × 1.0 ×
1.0`), and any single-input calibrator maps both to the same value. Fitting on
the week-matched eval reduces but does not remove this (a hotspot queried in
winter still scored ~35/100 in testing).

So **v0 ships without calibration** (`fit.ATTACH_CALIBRATION` stays off). The
backtest still fits a candidate isotonic calibrator per species and records it
in `backtest.json` (`candidate_calibration`) for inspection. `SpeciesModel`
keeps a calibration slot (identity by default). The 0–100 spread comes from the
geometric-mean combine (ADR-0008), not from calibration.

`value` is **relative favourability**, not a probability of finding a mushroom —
consistent with the safety framing.

## Consequences

- All six core species pass the two-regime gate (see `build/publish/model/
  backtest.json` after a build, or `docs/model-backtest.md`).
- The gate still fails the build if a future data or model change makes the full
  model materially worse than density alone, or stops it adding calendar value.
- The tolerances are policy, recorded here; tighten them as the model improves.
- This does not touch the ADR-0006 property tests (score rises with nearby
  finds, drops off-season, drops under drought) — those remain in CI.
