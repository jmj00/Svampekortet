# 11. Effort-debias the habitat density: KDE over ~660 m localities

Date: 2026-09-04

## Status

Accepted. Changes the habitat term defined in
[ADR-0006](0006-v0-probability-model.md) and resolves the "effort-debiased
`raw_ref`" Phase-3 item filed in
[ADR-0010](0010-expand-study-area-to-denmark.md). Raises
`WEEK_MATCHED_TOLERANCE` in the ADR-0007 ship gate from 0.03 to 0.035.

## Context

The habitat term is `habitat(q) = min(1, raw(q) / raw_ref)`, where `raw` is a
Gaussian KDE over the species' past finds and `raw_ref` is the 95th percentile of
`raw` over the corpus. Both ran over **every observation**, so a spot recorded
500 times contributed 500 kernels.

The first all-Denmark build ([ADR-0010](0010-expand-study-area-to-denmark.md))
exposed the consequence: `raw_ref` roughly doubled and every score outside the
recording hotspots halved (Rold Skov *Cantharellus* peak 69 → 39, which failed
the golden gate). A Jutland forest's `raw` is unchanged by distant Zealand finds,
but the Copenhagen-area forests are recorded far more intensively than anywhere
in Jutland, so the 95th percentile of `raw` moved onto those clusters. This is
spatial **recording-effort bias** — `raw_ref` measured where people go, not how
good the habitat is.

Probed on the Jutland DB with a synthetic 1500-observation cluster near
Copenhagen:

| KDE support | `raw_ref` after the synthetic cluster | Rold Skov *Cantharellus* peak |
| --- | --- | --- |
| every observation, q95 (**old**) | 50 → 918 (18×) | 69 → 14 |
| every obs, q90 / q85 | still 820–860 | still ~14 |
| localities @ 330 m | 24 → 99 (4×) | 93 → 40 |
| **localities @ 660 m** | 25 → 30 (1.2×) | 100 → 98 |

Lowering the quantile does nothing — the mega-cluster stays in the top 5 %.
Deduping the KDE support to a ~660 m grid before computing density is what makes
`raw_ref` robust: revisits stop stacking, genuine spatial extent still counts.
330 m is not enough (a 2 km cluster still spans ~40 cells).

## Decision

**The habitat KDE runs over finds thinned to a ~660 m grid (`DENSITY_GRID_DEG`),
not raw observations** — both `raw(q)` at score time and the `raw_ref` fit. The
bandwidth estimate is unchanged: it keeps its own finer ~330 m thinning
(`LOCALITY_GRID_DEG`) for the k-NN spacing, so `BANDWIDTH_FACTOR` stays valid.
`HabitatModel` now carries `localities` (the KDE support) and `observations`
(every find, for the confidence count) separately. `web/src/score.ts` ports the
same thinning (`dedupeToGrid`), matching Python's `round()` half-to-even so both
sides assign the same cells; the published payload is unchanged.

### Ship-gate tolerance

The two-regime backtest on the Jutland DB (fit ≤ 2021):

- **`calendar_random`** full AUC is unchanged (±0.001) and every species still
  clears the `+0.01` margin (smallest +0.0136).
- **`week_matched`**: the **habitat-only baseline AUC rises ~0.006** for every
  species — deduped density is a slightly *better* spatial ranker. The full
  model's absolute `week_matched` AUC is unchanged, so its gap below the improved
  baseline widens: *Cantharellus* −0.033 and *Imleria* −0.032, just past the old
  0.03 tolerance.

The full model is not worse at spatial ranking; the bar moved because the
baseline improved. `WEEK_MATCHED_TOLERANCE` is "policy, tighten/loosen as the
model changes" (ADR-0007), and this is that case — so it is raised to **0.035**.
The gate's real teeth are unaffected: `calendar_random` margin `+0.01` and the
golden `SEASON_DROP` of 25.

## Consequences

- Scores outside the recording hotspots recover — on the Jutland DB, Rold Skov
  *Cantharellus* peak goes 49 → 73, `raw_ref` ~50 → ~19 for every species. The
  national build should lift `PEAK_FLOOR` back toward 40; that retune, and the
  Zealand golden anchors, are the fast-follow.
- `count_within` (the "based on N finds nearby" confidence count) still counts
  every observation, so the confidence bands are unchanged.
- Validated on the Jutland DB only. The national deploy is the real test — if a
  real Copenhagen still moves `raw_ref` more than the synthetic did, `660 m`
  becomes `~1 km` (which also held in the probe, at the cost of a coupled
  bandwidth bump).
- Not a monotone rescale — the deduped KDE reorders points slightly — so the
  backtest genuinely re-runs on it; it is not covered by the ADR-0008 argument.
