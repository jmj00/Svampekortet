"""Weather term: how typical current antecedent weather is for this species.

For the query cell and date the pipeline computes the same antecedent features
as ``observation_weather`` (rolling precipitation and temperature, dry-day
count, a longer precipitation window, and a prior-year legacy signal -- see
below). This term asks how well that vector matches the weather that preceded
the species' historic fruitings:

    L_f          = exp(-0.5 * ((x_f - mean_f) / sd_f)^2)   per feature, peak 1
    weather      = geometric_mean(L_f over the features that have a value)

``mean_f`` / ``sd_f`` come from ``observation_weather`` restricted to that
species' finds with a full window *for that feature* (see
``coverage_column_and_threshold`` below). A geometric mean (not a bare
product) so several slightly-off features degrade the term gently rather than
collapsing it. A feature missing entirely -- too few full-window finds to fit
it, or no coverage for the query cell/date -- drops out of the geometric mean
rather than disabling the whole term; if none of them fit, the term is a
neutral 1.0 and is surfaced as lowered confidence by the combiner.

``precip_60d_mm`` (ADR-0017) widens the antecedent-precipitation window past
the original 30 days: several field studies find a 60-day cumulative window
carries signal the most recent month alone doesn't. ``prior_summer_precip_mm``
(ADR-0017) is a different kind of feature -- not an antecedent window before
the fruiting date at all, but the *previous* year's meteorological summer
(Jun-Aug) at the same cell, the literature's best-reported predictor of a
species' fruiting the following autumn (a wet prior summer builds the
mycelium's carbohydrate reserve). Both need more antecedent history than the
rest of the features, and at a different, non-uniform threshold -- hence the
per-feature coverage machinery below, where the original design gated every
feature by one shared ``precip_days_covered >= FULL_WINDOW_DAYS`` cutoff.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

# The features scored, chosen to be ecologically meaningful and not too
# collinear. Revisited in the backtest/tuning step (ADR-0006, ADR-0017).
WEATHER_FEATURES = (
    "precip_14d_mm",
    "precip_30d_mm",
    "mean_temp_14d_c",
    "dry_days_30d",
    "precip_60d_mm",
    "prior_summer_precip_mm",
)

# Below this many full-window (the *default* window -- see
# coverage_column_and_threshold) finds, the per-feature mean/sd is too shaky
# to fit at all.
MIN_WEATHER_OBSERVATIONS = 30

# Each feature's own "how many of its antecedent days are actually present"
# column in observation_weather / current.json / the backtest's negative-weather
# query, and the count that counts as "enough to trust" (~93% coverage,
# matching the original 28-of-30 ratio). precip_60d_mm needs a wider window and
# prior_summer_precip_mm an entirely different, earlier one, so both are gated
# by their own column/threshold instead of the shared default.
_COVERAGE_OVERRIDES: dict[str, tuple[str, int]] = {
    "precip_60d_mm": ("precip_60d_days_covered", 56),
    "prior_summer_precip_mm": ("prior_summer_days_covered", 85),
}
_DEFAULT_COVERAGE: tuple[str, int] = ("precip_days_covered", 28)


def coverage_column_and_threshold(feature: str) -> tuple[str, int]:
    return _COVERAGE_OVERRIDES.get(feature, _DEFAULT_COVERAGE)


def build_feature_dict(
    values: Sequence[float | None], coverages: Sequence[float | None]
) -> dict[str, float | None]:
    """Zip ``WEATHER_FEATURES`` with parallel ``(value, coverage)`` sequences
    from a query (one entry per feature, in ``WEATHER_FEATURES`` order) into a
    caller-ready feature dict -- nulling out a feature whose own antecedent
    window isn't fully covered rather than dropping the whole row, since
    ``WeatherModel.score`` already treats a missing feature as neutral."""
    out: dict[str, float | None] = {}
    for name, value, covered in zip(WEATHER_FEATURES, values, coverages, strict=True):
        _, threshold = coverage_column_and_threshold(name)
        out[name] = value if value is not None and (covered or 0) >= threshold else None
    return out


_MIN_SD = 1e-6
_SD_FLOOR_FRAC = 0.05  # sd is treated as >= 5% of |mean|, so a near-constant
#                        feature cannot dominate the product
_MIN_LIKELIHOOD = 1e-12  # keeps the log in the geometric mean finite


@dataclass(frozen=True)
class FeatureStats:
    mean: float
    sd: float


@dataclass(frozen=True)
class WeatherModel:
    n_observations: int
    features: dict[str, FeatureStats]  # empty when the term is not fitted

    @property
    def is_fitted(self) -> bool:
        return bool(self.features)

    @classmethod
    def from_stats(
        cls, n_observations: int, stats: Mapping[str, tuple[float | None, float | None]] | None
    ) -> WeatherModel:
        """Build from ``{feature: (mean, sd)}``. Neutral (no features) when
        there are too few finds overall; a feature that's individually missing
        or degenerate (not enough finds with *its own* full window -- see
        ``coverage_column_and_threshold``) is skipped rather than disabling
        every other feature that did fit."""
        if not stats or n_observations < MIN_WEATHER_OBSERVATIONS:
            return cls(n_observations, {})
        features: dict[str, FeatureStats] = {}
        for name, (mean, sd) in stats.items():
            if mean is None or sd is None or sd <= 0:
                continue
            features[name] = FeatureStats(float(mean), float(sd))
        return cls(n_observations, features)

    def score(self, features: Mapping[str, float | None] | None) -> float:
        if not self.is_fitted or not features:
            return 1.0
        likelihoods: list[float] = []
        for name, stats in self.features.items():
            x = features.get(name)
            if x is None:
                continue
            sd = max(stats.sd, _SD_FLOOR_FRAC * abs(stats.mean), _MIN_SD)
            z = (float(x) - stats.mean) / sd
            likelihoods.append(max(math.exp(-0.5 * z * z), _MIN_LIKELIHOOD))
        if not likelihoods:
            return 1.0
        log_mean = sum(math.log(v) for v in likelihoods) / len(likelihoods)
        return math.exp(log_mean)

    def to_dict(self) -> dict:
        return {
            "n_observations": self.n_observations,
            "features": (
                {
                    name: {"mean": round(s.mean, 4), "sd": round(s.sd, 4)}
                    for name, s in self.features.items()
                }
                if self.is_fitted
                else None
            ),
        }

    @classmethod
    def from_dict(cls, data: Mapping) -> WeatherModel:
        features = data.get("features")
        if not features:
            return cls(int(data.get("n_observations", 0)), {})
        return cls(
            int(data["n_observations"]),
            {name: FeatureStats(v["mean"], v["sd"]) for name, v in features.items()},
        )
