"""Isotonic (monotone) map from a raw score to a rescaled [0, 1] value.

Fit ``P(outcome | raw)`` by binning the sorted pairs, averaging the outcome per
bin, enforcing monotonicity with pool-adjacent-violators, then linearly
rescaling so the fitted range spans [0, 1]. Pure stdlib; the result is a small
piecewise-linear lookup that serialises to two short arrays.

The backtest fits one of these per species as a *candidate* calibrator
(``candidate_calibration`` in ``backtest.json``); the model does not apply it.
Three calibration routes were measured against the temporal backtest and none
adopted -- per-axis isotonic (loses habitat resolution, drops the most
site-faithful species below their habitat-only baseline, ADR-0008), isotonic vs
backtest labels, and percentile-among-finds (both ADR-0009). ``SpeciesModel``
keeps this as an identity slot; the 0..100 spread comes from the geometric-mean
combine in ``species_model.py``.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Sequence
from dataclasses import dataclass

DEFAULT_BINS = 40
MIN_POINTS = 40  # below this the map is left as the identity


@dataclass(frozen=True)
class IsotonicCalibrator:
    xs: tuple[float, ...]  # strictly increasing
    ys: tuple[float, ...]  # non-decreasing, same length, >= 2 points

    @classmethod
    def identity(cls) -> IsotonicCalibrator:
        return cls((0.0, 1.0), (0.0, 1.0))

    @classmethod
    def fit(
        cls, raw: Sequence[float], outcome: Sequence[float], *, bins: int = DEFAULT_BINS
    ) -> IsotonicCalibrator:
        pairs = sorted(zip(raw, outcome, strict=True))
        n = len(pairs)
        if n < MIN_POINTS:
            return cls.identity()

        xs = [float(x) for x, _ in pairs]
        ys = [float(y) for _, y in pairs]
        edges = [round(k * n / bins) for k in range(bins + 1)]

        bin_x: list[float] = []
        bin_y: list[float] = []
        bin_w: list[float] = []
        for lo, hi in zip(edges[:-1], edges[1:], strict=True):
            if hi <= lo:
                continue
            bin_x.append(sum(xs[lo:hi]) / (hi - lo))
            bin_y.append(sum(ys[lo:hi]) / (hi - lo))
            bin_w.append(float(hi - lo))

        pooled = _pava(bin_y, bin_w)
        cx, cy = _merge_equal_x(bin_x, pooled)
        if len(cx) < 2:
            return cls.identity()
        return cls(tuple(cx), tuple(_rescale_unit(cy)))

    def predict(self, value: float) -> float:
        xs, ys = self.xs, self.ys
        if value <= xs[0]:
            return ys[0]
        if value >= xs[-1]:
            return ys[-1]
        i = bisect_right(xs, value)
        x0, x1, y0, y1 = xs[i - 1], xs[i], ys[i - 1], ys[i]
        return y0 + (y1 - y0) * (value - x0) / (x1 - x0)

    @property
    def is_identity(self) -> bool:
        return self.xs == (0.0, 1.0) and self.ys == (0.0, 1.0)

    def to_dict(self) -> dict:
        return {"x": [round(v, 6) for v in self.xs], "y": [round(v, 6) for v in self.ys]}

    @classmethod
    def from_dict(cls, data: dict | None) -> IsotonicCalibrator:
        if not data:
            return cls.identity()
        xs, ys = data.get("x"), data.get("y")
        if not xs or not ys or len(xs) != len(ys) or len(xs) < 2:
            return cls.identity()
        return cls(tuple(float(v) for v in xs), tuple(float(v) for v in ys))


def _pava(values: Sequence[float], weights: Sequence[float]) -> list[float]:
    """Pool adjacent violators: nearest non-decreasing fit under weighted L2.
    Returns one pooled value per input (bin)."""
    blocks: list[list[float]] = []  # [weighted_sum, weight, mean, count]
    for v, w in zip(values, weights, strict=True):
        blocks.append([v * w, w, v, 1])
        while len(blocks) >= 2 and blocks[-2][2] >= blocks[-1][2]:
            s2, w2, _, c2 = blocks.pop()
            s1, w1, _, c1 = blocks.pop()
            total_w = w1 + w2
            blocks.append([s1 + s2, total_w, (s1 + s2) / total_w, c1 + c2])
    out: list[float] = []
    for _, _, mean, count in blocks:
        out.extend([mean] * count)
    return out


def _rescale_unit(ys: Sequence[float]) -> list[float]:
    """Linearly stretch a non-decreasing sequence so it starts at 0 and ends at
    1. Degenerate (flat) input is left as-is."""
    lo, hi = ys[0], ys[-1]
    if hi <= lo:
        return list(ys)
    return [(y - lo) / (hi - lo) for y in ys]


def _merge_equal_x(xs: Sequence[float], ys: Sequence[float]) -> tuple[list[float], list[float]]:
    """Collapse points that share an x (ties from many identical raw scores),
    averaging their y, so the breakpoints are strictly increasing in x."""
    merged_x: list[float] = []
    merged_y: list[float] = []
    run_y: list[float] = []
    for x, y in zip(xs, ys, strict=True):
        if merged_x and x <= merged_x[-1]:
            run_y.append(y)
            merged_y[-1] = sum(run_y) / len(run_y)
            continue
        merged_x.append(x)
        merged_y.append(y)
        run_y = [y]
    return merged_x, merged_y
