# pipeline/model

The v0 "conditions score" model. Design and rationale:
[`docs/adr/0006-v0-probability-model.md`](../../docs/adr/0006-v0-probability-model.md),
[`0007`](../../docs/adr/0007-backtest-gate-two-negative-regimes.md),
[`0008`](../../docs/adr/0008-geometric-mean-score-combine.md) and
[`0009`](../../docs/adr/0009-calibration-measured-and-not-adopted.md).

```
raw   = habitat x seasonality x weather                     each term in [0, 1]
axes  = (habitat, seasonality) + (weather,) if available
value = round(100 x calibrate(geometric_mean(axes)))        0..100, + a confidence band
```

`calibrate` is the identity in v0; the geometric mean (not the bare product)
is what spreads the 0..100 scale — see "Status".

## Modules

| file               | what                                                             |
| ------------------ | --------------------------------------------------------------- |
| `kernels.py`       | pure-stdlib maths: haversine, Gaussian weight, circular day gap, quantile, subsample |
| `habitat.py`       | `HabitatModel` — KDE closeness to past finds, run over finds thinned to a ~660m grid so recording effort does not set `raw_ref` (ADR-0011); per-species bandwidth = 1.5x the k-NN spacing between ~330m localities, clamped to [1.5, 8] km |
| `seasonality.py`   | `SeasonalityModel` — wrapped-Gaussian day-of-year curve, peak normalised to 1 |
| `weather.py`       | `WeatherModel` — per-feature Gaussian typicality of antecedent weather vs the species' historic fruitings; geometric-mean combine; neutral when unfitted |
| `current.py`       | build sub-step: antecedent weather per DMI cell as of the latest day → `current.json` |
| `metrics.py`       | ROC-AUC, precision@k, calibration curve (pure stdlib) |
| `calibration.py`   | `IsotonicCalibrator` — monotone PAVA map, rescaled to [0, 1] |
| `backtest.py`      | the two-regime temporal backtest — the ship gate; fits candidate calibrators |
| `golden.py`        | golden-location gate — named forests with expected seasonal scores; fails the build on a combine/curve regression |
| `species_model.py` | `SpeciesModel` — combines the terms into a `ConditionsScore` with a confidence band |
| `fit.py`           | build step: fit each core species from the DuckDB, run the backtest, write `build/publish/model/` |

## Status

Delivered: the **habitat**, **seasonality** and **weather** terms, plus the
**two-regime backtest** ship gate (ADR-0007) — fails the build if the full model
stops beating the habitat-only baseline when the query date is free, or drops
materially below it when the week is fixed. All six core species pass; see
[`docs/model-backtest.md`](../../docs/model-backtest.md).

**Not calibrated.** `fit.ATTACH_CALIBRATION` is `False`; the `calibration` slot
is the identity. The 0..100 spread comes from the **geometric-mean** combine: the
bare product pinned held-out finds at a median of ~5/100, the geometric mean
lifts that to ~37 while staying monotone in the product, so every backtest AUC
(and the gate) is unchanged. `backtest.json` records `positive_score_percentiles`
per species. Three calibration routes have been measured against the backtest and
none adopted — per-axis isotonic (ADR-0008), isotonic vs backtest labels, and
percentile-among-finds (both ADR-0009). The backtest still fits and records the
label calibrator (`candidate_calibration`) for inspection.

## Fit cost

`habitat.py` needs O(n^2) statistics (locality spacing, the density
reference). For v0 these run on a deterministic evenly-spaced subsample of at
most `FIT_SAMPLE` points rather than through a spatial index — fine for a few
thousand records per species, noted here so it is a conscious tradeoff.

## Run

```
python -m pipeline.model.fit             # fit + artifacts, against build/svampekortet.duckdb
python -m pipeline.model.current          # just current.json
python -m pipeline.build --archive ...    # step 5 of the full rebuild
```
