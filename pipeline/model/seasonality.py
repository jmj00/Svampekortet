"""Seasonality term: how well the query date matches the species' fruiting window.

A circular (wrapped-Gaussian) kernel density over the day-of-year of the
species' finds, normalised so the peak is 1. The wrap means late December and
early January are neighbours, so a species fruiting across the new year is not
split.

    curve[d]        = sum_i exp(-circular_delta(d, doy_i)^2 / (2 sigma^2))
    seasonality(d)  = curve[d] / max(curve)

``sigma`` is a fixed span in days (a few weeks), the same for every species;
every observation kept by the pipeline has a full date, so there is no
month-level fallback to make in v0. Per-species ``sigma`` was swept against the
backtest and not adopted -- see "Seasonality width" in docs/model-backtest.md.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from pipeline.model.kernels import DAYS_IN_YEAR, circular_delta_days, gaussian

DEFAULT_SIGMA_DAYS = 15.0  # fixed for all species; swept in docs/model-backtest.md


@dataclass(frozen=True)
class SeasonalityModel:
    sigma_days: float
    curve: tuple[float, ...]  # length DAYS_IN_YEAR, index = day_of_year - 1, peak == 1.0

    @classmethod
    def fit(
        cls, days_of_year: Sequence[int], *, sigma_days: float = DEFAULT_SIGMA_DAYS
    ) -> SeasonalityModel:
        doys = [_clamp_doy(d) for d in days_of_year]
        if not doys:
            return cls(sigma_days, tuple([0.0] * DAYS_IN_YEAR))

        raw = [
            sum(gaussian(circular_delta_days(d, doy), sigma_days) for doy in doys)
            for d in range(1, DAYS_IN_YEAR + 1)
        ]
        peak = max(raw) or 1.0
        return cls(sigma_days, tuple(v / peak for v in raw))

    def score(self, day_of_year: int) -> float:
        return self.curve[_clamp_doy(day_of_year) - 1]

    def to_dict(self) -> dict:
        return {
            "sigma_days": round(self.sigma_days, 2),
            "curve": [round(v, 4) for v in self.curve],
        }


def _clamp_doy(day_of_year: int) -> int:
    return max(1, min(DAYS_IN_YEAR, int(day_of_year)))
