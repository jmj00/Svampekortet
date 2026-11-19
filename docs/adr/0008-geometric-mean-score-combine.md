# 8. Score combine: geometric mean, and per-axis calibration rejected

Date: 2026-09-02

## Status

Accepted. Resolves the "Calibration — deferred" note in
[ADR-0007](0007-backtest-gate-two-negative-regimes.md) and changes the 0–100
value defined in [ADR-0006](0006-v0-probability-model.md).

## Context

ADR-0007 shipped the v0 value as the bare product,
`value = round(100 × habitat × seasonality × weather)`, and left "a per-axis
calibrator" as Phase 3 work.

Two problems with the bare product showed up once the model was live:

1. **The scale is unusable.** Each term is in `[0, 1]`, and a realistic query
   near a known area does not sit at `habitat ≈ 1`: the habitat term is
   `min(1, raw / raw_ref)` with `raw_ref` the 95th percentile over training
   points, so a *typical* past-find location scores `habitat ≈ 0.1–0.3`.
   Multiplying that by a seasonality curve value (~0.6–0.9 on a good day) and a
   weather typicality (~0.7) pins the result near zero. On the temporal backtest,
   the held-out real finds — the points that should score *well* — had a median
   displayed value of **5/100** (p90 ≈ 28, max ≈ 90). "Peak conditions land
   around 75–100" in ADR-0007 only held for the degenerate `habitat = 1` case.

2. **Per-axis isotonic calibration makes ranking worse.** The obvious fix —
   calibrate each axis separately so it can't conflate space and time — was
   measured on the backtest eval sets: fit `P(find | habitat)` and
   `P(find | weather)` on `week_matched`, `P(find | seasonality)` on
   `calendar_random`, recombine. Result: rescaling the already-continuous
   habitat term through a 40-bin isotonic + pool-adjacent-violators map **loses
   resolution in the high tail**, and for the most site-faithful species that
   costs more than seasonality calibration adds back:

   | species | `calendar_random` AUC, raw product | …with per-axis calibration | habitat-only baseline |
   | --- | --: | --: | --: |
   | Craterellus tubaeformis | 0.960 | 0.937 | **0.945** |
   | Imleria badia | 0.954 | 0.944 | 0.887 |
   | Cantharellus cibarius | 0.937 | 0.933 | 0.910 |

   Craterellus — a very site-loyal species, high baseline — drops **below** its
   habitat-only baseline. `week_matched` AUC fell 3–6 points for several species.
   This is the "conflates the axes" failure ADR-0007 predicted, now with numbers:
   there is no free lunch in reshaping a term that is already the strongest
   signal.

## Decision

**The displayed value is the geometric mean of the axes**, not their product:

    axes  = (habitat, seasonality)  + (weather,) when weather is available
    value = round(100 × calibrate(geometric_mean(axes)))

`calibrate` is still the identity in v0. The `calibration` slot now maps the
**combined** favourability — a single `[0, 1]` axis — and stays open for a
future spatially resolved calibrator. *([ADR-0009](0009-calibration-measured-and-not-adopted.md)
later measured isotonic-vs-labels and percentile-among-finds on that combined
axis and adopted neither: both are monotone so the gate is untouched, but
neither improves the model.)*

Why the geometric mean works where per-axis calibration did not:

- It is a **monotone transform of the raw product**, so it changes *no* ranking
  the backtest measures. Every `week_matched` / `calendar_random` AUC, and the
  ship gate, are byte-identical to the bare-product model. The gate is still
  computed on the raw product.
- It only reshapes the `[0, 1]` range. `(0.2 × 0.8 × 0.7)^(1/3) ≈ 0.52` where
  `0.2 × 0.8 × 0.7 = 0.11`. The held-out real finds now score p10/p50/p90 ≈
  **15 / 37 / 68** (max ≈ 95) — recorded per species as
  `positive_score_percentiles` in `backtest.json`.
- Dropping the neutral `weather = 1.0` from the mean when weather is unavailable
  keeps a missing-weather query from being silently inflated.

`value` remains **relative favourability**, not a probability — consistent with
the safety framing. `raw` (the bare product) is still carried in the score dict
as a diagnostic.

The UI's qualitative bands (`panel.ts`) were aspirational under the old scale
("Gode forhold" ≥ 60 was practically unreachable). They now line up with the
backtest: a median held-out find reads "Middel forhold", the top decile "Gode
forhold", the best few percent "Meget gode forhold".

## Consequences

- `web/src/score.ts` ports the geometric-mean combine; its header and the
  `species_model.py` / `calibration.py` docstrings point here.
- The published payload is unchanged — the combine happens at scoring time on
  both sides — so no re-fit or re-deploy of data is required to adopt it; a
  code-only deploy suffices.
- If a future change to a term makes the raw product worse, the two-regime gate
  still catches it; the geometric mean cannot hide it because it is monotone.
- A per-axis or spatially resolved calibrator is still possible later, now
  operating on the single combined favourability rather than the three-way
  product.
