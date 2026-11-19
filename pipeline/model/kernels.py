"""Pure-stdlib kernel maths for the v0 model.

No third-party dependency on purpose: the per-species fit runs over a few
thousand points once per build, and the per-pin score the web app mirrors is a
single O(n) pass over one species' observations. Everything here is a plain
function so it can be checked in isolation and re-implemented in TypeScript.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence

EARTH_RADIUS_KM = 6371.0088
DAYS_IN_YEAR = 366  # day-of-year runs 1..366; the circular maths wraps at 366


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two WGS84 points, in kilometres."""
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = rlat2 - rlat1
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return EARTH_RADIUS_KM * 2 * math.asin(math.sqrt(a))


def gaussian(distance: float, bandwidth: float) -> float:
    """Unnormalised Gaussian weight ``exp(-d^2 / (2 h^2))`` in ``(0, 1]``.

    Unnormalised because every use here divides by a reference value or a peak,
    so the ``1 / (h * sqrt(2 pi))`` factor would cancel.
    """
    if bandwidth <= 0:
        raise ValueError("bandwidth must be positive")
    z = distance / bandwidth
    return math.exp(-0.5 * z * z)


def circular_delta_days(a: float, b: float) -> float:
    """Smallest wrapped gap between two days-of-year, in ``[0, DAYS_IN_YEAR / 2]``."""
    d = abs(a - b) % DAYS_IN_YEAR
    return min(d, DAYS_IN_YEAR - d)


def quantile(values: Iterable[float], q: float) -> float:
    """Linear-interpolated quantile. ``values`` need not be sorted; ``q`` in ``[0, 1]``."""
    data = sorted(values)
    if not data:
        raise ValueError("cannot take a quantile of no values")
    if len(data) == 1:
        return data[0]
    pos = q * (len(data) - 1)
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return data[lo]
    return data[lo] + (data[hi] - data[lo]) * (pos - lo)


def subsample(seq: Sequence, limit: int) -> Sequence:
    """A deterministic, evenly-spaced subsample of at most ``limit`` items.

    Used to keep the O(n^2) fit statistics (nearest-neighbour spacing, the
    density reference) cheap without pulling in a spatial index for v0.
    """
    if limit <= 0:
        raise ValueError("limit must be positive")
    if len(seq) <= limit:
        return seq
    stride = len(seq) / limit
    return [seq[math.floor(i * stride)] for i in range(limit)]
