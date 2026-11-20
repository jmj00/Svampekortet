# 23. The week-matched gate compares against habitat × seasonality

Date: 2026-11-20

## Status

Accepted. Amends the `week_matched` half of
[ADR-0007](0007-backtest-gate-two-negative-regimes.md); `calendar_random` is
unchanged.

## Context

After the backtest was made deterministic (PR #3) and its noise cut with 20
negatives per find and a bootstrap SE (PR #4), every one of the 50 species
still had a `week_matched` AUC *below* the habitat-only baseline. The worst
core species, *Suillus grevillei*, sat at −0.035 (SE 0.008), on the tolerance
line, so deploys were close to blocking on a small but real effect.

A decomposition on a CI-equivalent database (609 weather cells, same seed and
negatives as the gate) scored each held-out point with each combination of
terms. Medians over the 50 species, AUC change against habitat alone:

| term combination | `week_matched` | `calendar_random` |
|---|---|---|
| habitat × seasonality | −0.010 | +0.057 |
| habitat × weather | −0.003 | +0.024 |
| full model | −0.0175 | +0.055 |
| seasonality alone (AUC) | 0.496 | 0.871 |
| weather alone (AUC) | 0.576 | 0.806 |

Host tree adds nothing in either regime (full = habitat × seasonality ×
weather).

Seasonality alone ranks `week_matched` points at chance (0.496). That is by
construction: negatives take a find's day of year ±3 days, so the seasonality
term only adds the jitter as noise. It accounts for most of the gap. On the
map this noise does not exist. Every place is scored for the same day, so
seasonality multiplies them all by the same factor and cannot change their
order.

## Decision

The `week_matched` baseline is **habitat × seasonality**
(`BASELINE_HABITAT_SEASONALITY`); the tolerance stays at 0.035. The regime
then asks only what it was meant to ask: do weather and host tree damage
spatial ranking? `calendar_random` keeps the habitat-only baseline and its
+0.005 margin, so seasonality and weather must still earn their place there.
Each regime's report records which baseline it used (`"baseline"`).

## Consequences

- Against the new baseline the median gap is −0.005 and *S. grevillei* is
  about −0.002. The worst core species is *Pleurotus ostreatus* at −0.025
  (SE 0.004): a real, small weather cost, inside the tolerance. The worst are
  `extra` species (*Morchella esculenta* −0.041, *Bovista plumbea* −0.040,
  *Hortiboletus rubellus* −0.038, all with SE ≈ 0.016–0.02), which stay
  advisory.
- The tolerance is no longer spent on a test artifact, so a future change that
  makes weather hurt spatial ranking shows up directly.
- Measured, not adopted: down-weighting weather (weather^0.5) makes its
  `week_matched` cost neutral (+0.0002) but cuts its `calendar_random` gain
  from +0.024 to +0.018, and would flatten the displayed weather axis. Lower
  exponents just interpolate between the two regimes; there is no free gain.
- The 14-day mean temperature ranks below chance within the week for 15
  species (it mostly tracks the season) but is the strongest weather feature
  across the calendar (0.757). It is a candidate for a background-contrasted
  weather model, not for removal.
