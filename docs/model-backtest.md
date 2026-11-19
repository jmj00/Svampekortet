# Model backtest

Living record of the v0 conditions-model backtest — the ship gate. Method:
[ADR-0006](adr/0006-v0-probability-model.md) as amended by
[ADR-0007](adr/0007-backtest-gate-two-negative-regimes.md); the displayed 0–100
value is the geometric mean of the axes ([ADR-0008](adr/0008-geometric-mean-score-combine.md)),
which is monotone in the raw product the gate measures. Run it with:

```
python -m pipeline.model.backtest            # against build/svampekortet.duckdb
```

It also runs as step 5 of `python -m pipeline.build` and **fails the build** if
any `core`-tier species does not pass. `extra`-tier species
([ADR-0012](adr/0012-species-tiers-core-and-extra.md)) are backtested too, but a
failure only lands in the report's `advisory_failures` list — it does not block
the build, and the UI flags their conditions score as not validated. Each build
publishes the full report to `model/backtest.json` in the data payload — refresh
the table below from
`https://svampekortet.pages.dev/data/model/backtest.json` (per-species `bw` is in
the `model/<slug>.json` files).

## Method

- **Split:** fit each species on finds up to **2021**; evaluate on **2022–2025**.
- **Positives:** held-out finds in the test years with a full 30-day antecedent
  weather window.
- **Negatives:** random DMI grid cells, 5 per positive, under two date regimes:
  - **`week_matched`** — negative dates within ±3 days of a positive's day.
    Isolates spatial skill (the calendar is held ~fixed).
  - **`calendar_random`** — negative dates uniform across the test years. Matches
    how the app is actually queried (any place, any month).
- **Baseline:** the habitat term alone (past-observation density).
- **Metrics:** ROC-AUC and precision@k (k = number of test positives).
- **Gate (both must hold):**
  - `week_matched`: full AUC ≥ baseline − 0.035 (does not damage spatial ranking;
    raised from 0.03 in [ADR-0011](adr/0011-effort-debias-habitat-density.md)).
  - `calendar_random`: full AUC ≥ baseline + 0.005 (season + weather add value);
    lowered from 0.01 on the all-Denmark corpus — see
    [ADR-0010](adr/0010-expand-study-area-to-denmark.md).
- **`pos p10/p50/p90/max`:** the displayed 0–100 value over the held-out finds —
  the check that the geometric-mean scale (ADR-0008) is a usable favourability.

Seed `20260902`; positives/negatives and the fit are deterministic.

## Latest run — 2026-09-08, all-Denmark corpus, 48 species

Payload `2026-09-08T05:39:48Z`. Fit ≤ 2021, test 2022–2025, seed `20260902`,
5 negatives per positive. Gate unchanged since
[ADR-0010](adr/0010-expand-study-area-to-denmark.md) /
[ADR-0011](adr/0011-effort-debias-habitat-density.md): `week_matched` tolerance
**0.035**, `calendar_random` margin **0.005**.

- **All 15 `core` species pass** — `failures: []`, `passed_all: true`.
- **33 `extra` species** ([ADR-0012](adr/0012-species-tiers-core-and-extra.md))
  are backtested advisory-only: **19 clear the gate** (promotion candidates) and
  **14 land in `advisory_failures`**. Neither blocks the build.

`wk` = `week_matched`, `cal` = `calendar_random`; Δ is full − baseline. `bw` is
the fitted habitat bandwidth (km, clamped to `[1.5, 8]`). AUC is on the raw
product; `pos` percentiles are the geometric-mean 0–100 value over held-out finds.

### Core (gated)

| species | train n | test n | bw | `wk` full | `wk` base | Δ | `cal` full | `cal` base | Δ | `pos` p10/50/90/max |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| *Cantharellus cibarius* | 3526 | 638 | 1.5 | 0.891 | 0.912 | −0.020 | **0.926** | 0.906 | **+0.020** | 13 / 43 / 73 / 97 |
| *Craterellus tubaeformis* | 2078 | 518 | 1.5 | 0.927 | 0.944 | −0.016 | **0.955** | 0.943 | **+0.011** | 18 / 42 / 78 / 99 |
| *Craterellus cornucopioides* | 1354 | 222 | 1.70 | 0.929 | 0.943 | −0.014 | **0.956** | 0.938 | **+0.018** | 13 / 48 / 81 / 94 |
| *Boletus edulis* | 4030 | 1222 | 1.5 | 0.832 | 0.863 | −0.031 | **0.923** | 0.859 | **+0.064** | 14 / 40 / 73 / 98 |
| *Imleria badia* | 4146 | 876 | 1.5 | 0.882 | 0.907 | −0.025 | **0.952** | 0.905 | **+0.046** | 19 / 46 / 78 / 99 |
| *Suillus luteus* | 1430 | 324 | 2.59 | 0.837 | 0.858 | −0.022 | **0.929** | 0.848 | **+0.081** | 16 / 42 / 67 / 98 |
| *Suillus variegatus* | 716 | 175 | 2.44 | 0.842 | 0.855 | −0.013 | **0.901** | 0.862 | **+0.039** | 4 / 36 / 66 / 94 |
| *Suillus bovinus* | 892 | 215 | 2.66 | 0.859 | 0.870 | −0.010 | **0.943** | 0.871 | **+0.072** | 10 / 43 / 77 / 97 |
| *Suillus granulatus* | 512 | 187 | 3.82 | 0.897 | 0.914 | −0.017 | **0.948** | 0.922 | **+0.026** | 14 / 42 / 80 / 91 |
| *Leccinum scabrum* | 1484 | 548 | 2.69 | 0.814 | 0.832 | −0.017 | **0.911** | 0.832 | **+0.079** | 10 / 42 / 79 / 99 |
| *Leccinum versipelle* | 638 | 120 | 3.11 | 0.815 | 0.830 | −0.016 | **0.871** | 0.824 | **+0.047** | 2 / 39 / 85 / 94 |
| *Pleurotus ostreatus* | 2486 | 737 | 1.95 | 0.838 | 0.862 | −0.023 | **0.903** | 0.854 | **+0.049** | 14 / 40 / 69 / 97 |
| *Auricularia auricula-judae* | 4249 | 1155 | 2.12 | 0.798 | 0.815 | −0.017 | **0.834** | 0.820 | **+0.014** | 18 / 38 / 73 / 98 |
| *Laetiporus sulphureus* | 1274 | 480 | 2.51 | 0.882 | 0.905 | −0.023 | **0.921** | 0.908 | **+0.014** | 18 / 40 / 78 / 94 |
| *Fistulina hepatica* | 1022 | 251 | 2.87 | 0.891 | 0.910 | −0.020 | **0.957** | 0.913 | **+0.044** | 18 / 42 / 70 / 95 |

*Boletus edulis* is tightest on the `week_matched` tolerance (−0.031 of −0.035).
*Craterellus tubaeformis* is tightest on the `calendar_random` margin (+0.011 of
+0.005), then *Auricularia* and *Laetiporus* (+0.014) — a year-round jelly fungus
and two irregular wood-rotters, the thinnest seasonal signals in the core set.
Every core species still gains clearly on `calendar_random`, the regime the app
runs in (+0.011 to +0.081).

The `pos` columns are the point of ADR-0008: under the bare product the held-out
finds scored p10/p50/p90 ≈ 0 / 5 / 28; the geometric mean spreads that to
≈ 12 / 42 / 74 without touching any AUC (it is monotone in the product).

### Extra (advisory) — clears the gate

These 19 would pass as `core` and are promotion candidates. Several sit right at
the `week_matched` limit — *Leccinum albostipitatum* −0.034, *Leccinellum
pseudoscabrum* / *Xerocomellus cisalpinus* / *Xerocomellus pruinatus* −0.030 —
so promote after a look, not blindly.

| species | train n | test n | bw | `wk` full | `wk` base | Δ | `cal` full | `cal` base | Δ | `pos` p10/50/90/max |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| *Suillus grevillei* | 462 | 376 | 4.84 | 0.774 | 0.798 | −0.025 | 0.916 | 0.795 | +0.121 | 15 / 39 / 72 / 99 |
| *Suillus flavidus* | 139 | 42 | 3.10 | 0.904 | 0.908 | −0.004 | 0.941 | 0.923 | +0.018 | 23 / 44 / 80 / 93 |
| *Suillus viscidus* | 246 | 75 | 2.71 | 0.954 | 0.961 | −0.007 | 0.972 | 0.957 | +0.015 | 19 / 46 / 75 / 95 |
| *Xerocomellus chrysenteron* | 1516 | 380 | 2.04 | 0.890 | 0.908 | −0.018 | 0.947 | 0.905 | +0.042 | 17 / 44 / 69 / 93 |
| *Xerocomellus pruinatus* | 1301 | 406 | 2.17 | 0.870 | 0.900 | −0.030 | 0.950 | 0.896 | +0.055 | 15 / 47 / 80 / 98 |
| *Xerocomellus cisalpinus* | 316 | 165 | 8 | 0.780 | 0.811 | −0.031 | 0.905 | 0.792 | +0.113 | 13 / 38 / 62 / 91 |
| *Xerocomus ferrugineus* | 550 | 153 | 4.51 | 0.810 | 0.826 | −0.015 | 0.918 | 0.824 | +0.094 | 15 / 39 / 72 / 97 |
| *Leccinum aurantiacum* | 265 | 95 | 8 | 0.677 | 0.701 | −0.024 | 0.842 | 0.704 | +0.138 | 5 / 49 / 70 / 88 |
| *Leccinum albostipitatum* | 237 | 105 | 8 | 0.694 | 0.728 | −0.034 | 0.883 | 0.738 | +0.145 | 25 / 45 / 70 / 81 |
| *Leccinum variicolor* | 438 | 79 | 4.46 | 0.820 | 0.843 | −0.023 | 0.947 | 0.832 | +0.116 | 14 / 47 / 82 / 95 |
| *Leccinellum pseudoscabrum* | 173 | 37 | 5.13 | 0.891 | 0.922 | −0.030 | 0.944 | 0.910 | +0.034 | 4 / 40 / 70 / 75 |
| *Boletus reticulatus* | 1299 | 304 | 1.86 | 0.883 | 0.906 | −0.023 | 0.936 | 0.911 | +0.025 | 8 / 42 / 73 / 88 |
| *Boletus pinophilus* | 192 | 67 | 3.92 | 0.836 | 0.841 | −0.005 | 0.851 | 0.834 | +0.017 | 0 / 67 / 87 / 94 |
| *Butyriboletus appendiculatus* | 582 | 146 | 2.11 | 0.898 | 0.919 | −0.021 | 0.935 | 0.926 | +0.009 | 5 / 39 / 75 / 92 |
| *Cantharellus pallens* | 1247 | 237 | 1.60 | 0.914 | 0.922 | −0.009 | 0.959 | 0.927 | +0.031 | 5 / 42 / 78 / 96 |
| *Pleurotus pulmonarius* | 627 | 410 | 1.63 | 0.897 | 0.900 | −0.003 | 0.917 | 0.891 | +0.026 | 1 / 33 / 71 / 98 |
| *Cerioporus squamosus* | 1901 | 484 | 3.12 | 0.825 | 0.851 | −0.026 | 0.900 | 0.852 | +0.048 | 15 / 38 / 67 / 94 |
| *Meripilus giganteus* | 2511 | 823 | 1.52 | 0.895 | 0.914 | −0.019 | 0.948 | 0.915 | +0.033 | 14 / 42 / 75 / 96 |
| *Apioperdon pyriforme* | 2927 | 548 | 1.56 | 0.909 | 0.934 | −0.025 | 0.951 | 0.938 | +0.013 | 16 / 46 / 79 / 95 |

### Extra (advisory) — fails the gate

All 14 miss on `week_matched`: for these scattered corpora the habitat term alone
is already a strong spatial ranker, and adding the season axis costs more than
the 0.035 tolerance (*Morchella esculenta* −0.097, *Bovista plumbea* −0.092,
*Lycoperdon excipuliforme* −0.072). Every one still clears `calendar_random`
comfortably (+0.02 to +0.10), so the score answers "is it worth looking now"
directionally — it just isn't gate-validated, and the UI flags it.

| species | train n | test n | bw | `wk` full | `wk` base | Δ | `cal` full | `cal` base | Δ | `pos` p10/50/90/max |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| *Hydnum repandum* | 1294 | 212 | 3.00 | 0.826 | 0.880 | −0.054 | 0.927 | 0.892 | +0.035 | 19 / 44 / 70 / 91 |
| *Coprinus comatus* | 2562 | 774 | 2.51 | 0.819 | 0.859 | −0.040 | 0.949 | 0.858 | +0.091 | 18 / 45 / 79 / 99 |
| *Sparassis crispa* | 840 | 247 | 3.66 | 0.793 | 0.836 | −0.043 | 0.905 | 0.828 | +0.077 | 14 / 42 / 70 / 90 |
| *Xerocomus subtomentosus* | 443 | 53 | 6.91 | 0.856 | 0.899 | −0.043 | 0.933 | 0.908 | +0.025 | 22 / 47 / 63 / 85 |
| *Leccinum holopus* | 256 | 57 | 8 | 0.779 | 0.817 | −0.038 | 0.907 | 0.821 | +0.086 | 14 / 43 / 79 / 87 |
| *Hortiboletus rubellus* | 616 | 124 | 4.50 | 0.834 | 0.883 | −0.049 | 0.915 | 0.890 | +0.024 | 10 / 37 / 66 / 81 |
| *Tricholomopsis rutilans* | 1902 | 419 | 3.28 | 0.787 | 0.825 | −0.038 | 0.929 | 0.830 | +0.100 | 23 / 43 / 72 / 98 |
| *Lycoperdon perlatum* | 3614 | 825 | 1.76 | 0.819 | 0.874 | −0.055 | 0.921 | 0.876 | +0.045 | 13 / 45 / 80 / 99 |
| *Lycoperdon excipuliforme* | 847 | 208 | 5.22 | 0.726 | 0.798 | −0.072 | 0.900 | 0.797 | +0.103 | 18 / 43 / 79 / 92 |
| *Lycoperdon utriforme* | 754 | 258 | 4.81 | 0.746 | 0.810 | −0.064 | 0.846 | 0.800 | +0.045 | 18 / 45 / 73 / 99 |
| *Calvatia gigantea* | 865 | 265 | 4.58 | 0.810 | 0.874 | −0.064 | 0.898 | 0.868 | +0.031 | 16 / 35 / 69 / 90 |
| *Bovista nigrescens* | 317 | 33 | 8 | 0.685 | 0.739 | −0.054 | 0.783 | 0.761 | +0.022 | 14 / 41 / 73 / 85 |
| *Bovista plumbea* | 410 | 59 | 8 | 0.697 | 0.789 | −0.092 | 0.834 | 0.802 | +0.032 | 21 / 46 / 78 / 93 |
| *Morchella esculenta* | 418 | 43 | 6.39 | 0.730 | 0.827 | −0.097 | 0.929 | 0.836 | +0.094 | 7 / 45 / 78 / 98 |

### Habitat bandwidth

Bandwidth is `1.5 ×` the median distance from a locality (finds thinned to a
~330 m grid) to its 3rd-nearest locality, clamped to `[1.5, 8]` km. The
densely-recorded broadleaf species sit at the 1.5 km floor; pine-plantation
*Suillus* land at 2.4–3.8 km. Six sparse, scattered corpora hit the 8 km ceiling
(*Leccinum aurantiacum* / *albostipitatum* / *holopus*, *Xerocomellus
cisalpinus*, *Bovista nigrescens* / *plumbea*) — for these the habitat term is
near-flat and the model leans almost entirely on season + weather, which is why
several of them post the largest `calendar_random` gains in the whole table
(+0.11 to +0.15) while missing `week_matched`. The `1.5` factor was swept against
the Jutland backtest: larger bandwidth trades `week_matched` AUC for
`calendar_random` gain, and `1.5` kept every *core* species inside tolerance.

### Density reference

The KDE for `raw` and `raw_ref` runs over finds thinned to a **~660 m grid**
(`DENSITY_GRID_DEG`), not raw observations
([ADR-0011](adr/0011-effort-debias-habitat-density.md)). Without it, `raw_ref`
(the 95th-percentile density) is set by wherever recording effort is heaviest —
on the all-Denmark corpus, the Copenhagen forests — which halves the score
everywhere else. A synthetic 1500-observation cluster near Copenhagen moves
`raw_ref` 18× on the old KDE and 1.2× on the 660 m one; lowering the percentile
does nothing (the cluster stays in the top 5 %). The dedup lifts the
habitat-only baseline in both regimes while the full model's absolute AUC holds
— a baseline improvement, not a full-model regression — and that is why the
`week_matched` tolerance was set at 0.035 and the `calendar_random` margin at
0.005 (see ADR-0010 / ADR-0011).

### Seasonality width

`sigma` for the wrapped-Gaussian day-of-year curve is a **fixed 15 days** for
every species (`DEFAULT_SIGMA_DAYS`). Swept per species over `[6, 28]` days
against the Jutland-era backtest (not re-run on the national corpus — the
conclusion is structural, not threshold-sensitive):

- `sigma = 15` sits at the `calendar_random` optimum for the two largest corpora
  — *Boletus edulis* (0.941 at 15, falling either side) and *Imleria badia*
  (flat 0.952 across 8–18) — and within 0.001 of best for *Cantharellus*.
- *Craterellus*, *Suillus luteus* and *Suillus variegatus* score ≈ 0.002–0.005
  higher on `calendar_random` at `sigma ≈ 6–8`, but that direction pulls
  `week_matched` AUC down toward the −0.03 tolerance, the effect is largest on
  the thinnest corpus (*Suillus variegatus*, 474/147 — within seed noise), and
  **no find-day width statistic separates those three from the rest**: circular
  SD is 26–42 d with the sharp-preferring species mid-pack, and the central-50 %
  half-width and the fraction of finds within ±21 / ±35 d of the peak give the
  same non-ordering. There is nothing to key a per-species `sigma` off.
- Golden peak/winter reads are unchanged across `sigma` 10–17.

So `sigma = 15` is kept; per-species `sigma` was measured and not adopted. Like
the geometric mean and the calibration routes, the simple choice is already near
the achievable frontier for this axis — further gain needs a new signal, not a
re-tuned one.

### Reading it

- Habitat density alone is already a strong **spatial** ranker (`week_matched`
  baseline AUC ≈ 0.83–0.94 for the core set). Once the query week is fixed,
  seasonality and weather can't improve on it and cost a little — within the
  0.035 tolerance for every core species, past it for 14 sparse-corpus `extra`
  species.
- When the date is free (`calendar_random`), the full model clearly wins for
  everything: it correctly says "not now" out of season. This is the regime the
  app runs in, and the only one where all 48 species clear their margin.
- The broad-range species (*Boletus edulis*, *Suillus luteus*, *Leccinum
  scabrum*) and the sparse-corpus `extra` boletes gain most on
  `calendar_random` (+0.08 to +0.15) — weak habitat signal, so the seasonal axis
  carries the model.

## Not calibrated

The 0–100 value is `round(100 × geometric_mean(habitat, seasonality, weather))` —
weather dropped from the mean when unavailable — with the calibration slot left
as the identity. Three calibration routes have now been measured against this
backtest and none adopted:

- **per-axis isotonic** — loses habitat resolution, drops Craterellus below its
  habitat-only baseline ([ADR-0008](adr/0008-geometric-mean-score-combine.md));
- **isotonic vs backtest labels on the combined score** — improves Brier/ECE only
  by learning the arbitrary 5:1 negative:positive sampling ratio, and collapses
  the scale onto its endpoints ([ADR-0009](adr/0009-calibration-measured-and-not-adopted.md));
- **percentile among a species' historical finds** — exactly AUC-neutral and
  cleaner to read, but no accuracy or ranking gain to pay for a live scale change
  and a harsher low end (ADR-0009).

The backtest still fits the label calibrator per species and records it in
`backtest.json` (`candidate_calibration`) for inspection.
