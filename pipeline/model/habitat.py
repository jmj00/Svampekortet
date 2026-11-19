"""Habitat term: closeness of a query point to where the species has fruited.

A Gaussian kernel-density surface over the species' past find *localities*, read
as a relative "how like a known spot is this" score rather than a normalised
density. A point sitting on a dense cluster of finds scores ~1; open ground far
from any find scores ~0.

    raw(q)      = sum_i exp(-dist(q, locality_i)^2 / (2 h^2))
    habitat(q)  = min(1, raw(q) / raw_ref)

The kernel runs over finds thinned to a ~``DENSITY_GRID_DEG`` grid, not raw
observations: a spot recorded 500 times and a spot recorded once then count the
same. Without that, ``raw_ref`` -- a high percentile of ``raw`` over the corpus
-- is set by wherever recording effort is heaviest (for an all-Denmark corpus,
the Copenhagen forests), which deflates the score everywhere else. See
docs/adr/0011-effort-debias-habitat-density.md.

``h`` (the bandwidth) is ``BANDWIDTH_FACTOR`` times the median distance from a
locality (a *separate*, finer ~``LOCALITY_GRID_DEG`` thinning, so the spacing
estimate is unchanged) to its ``KNN_SEED``-th nearest, clamped to a sane range.
On the real data this gives 2-4 km, ordered by how patchy each species is (the
pine-plantation *Suillus* widest). Coordinate uncertainty is ignored in v0.

ADR-0011's grid-thinning corrects for the same *spot* being reported over and
over; it does nothing about one *area* simply getting far more fungi-recording
of any kind than another (a popular, accessible forest vs. a rarely-visited
one) -- exactly the "good spots get kept secret" bias this project set out to
counter, just arriving via accessibility rather than deliberate secrecy
(see ``pipeline.model.recording_effort`` for the evidence). ADR-0018 adds a
*second*, effort-corrected reference, ``ratio_ref``, calibrated the same way as
``raw_ref`` but against ``raw(locality) / recording_effort(locality)`` instead
of ``raw(locality)`` alone:

    ratio(q)    = raw(q) / max(effort(q), MIN_EFFORT_TO_CORRECT)
    habitat(q)  = min(1, ratio(q) / ratio_ref)      -- when effort is supplied
                = min(1, raw(q) / raw_ref)           -- otherwise (unchanged)

``raw_ref`` and the uncorrected path stay exactly as before: a caller that
doesn't look up and pass ``effort`` (``golden.py``'s minimal-argument checks,
in particular) gets precisely today's score, unaffected by whether the model
was fit with an effort grid. ``MIN_EFFORT_TO_CORRECT`` floors the divisor
rather than letting a barely-recorded cell (or one Svampeatlas has never
touched at all, ``effort(q) = 0``) blow the ratio up.

ADR-0018 measured this against the real backtest and **rejected** it: at
every correction strength tried (including a heavily dampened one) it made
ranking worse, catastrophically so at full strength -- recording effort and
genuine habitat quality turn out to be too confounded in this corpus for a
naive ratio to separate. Nothing in this pipeline runs
``pipeline.ingest.recording_effort`` against a production database, so every
species ships with ``ratio_ref = None`` and this whole path is dormant; it
stays in the codebase only because it's fully backward compatible and the
two-reference pattern may suit some other optional refinement later.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from pipeline.model.kernels import gaussian, haversine_km, quantile, subsample
from pipeline.model.recording_effort import MIN_EFFORT_TO_CORRECT, EffortGrid

Point = tuple[float, float]  # (lon, lat)

DEFAULT_BANDWIDTH_KM = 3.0  # too few distinct localities to estimate a spacing
MIN_BANDWIDTH_KM = 1.5
MAX_BANDWIDTH_KM = 8.0
BANDWIDTH_FACTOR = 1.5  # bandwidth = factor x locality spacing; tuned on the backtest
KNN_SEED = 3  # spacing = distance to the k-th nearest locality (robust vs 1-NN)
LOCALITY_GRID_DEG = 0.003  # ~330 m; thinning for the k-NN spacing / bandwidth
DENSITY_GRID_DEG = 0.006  # ~660 m; thinning for the KDE support -- debiases raw_ref (ADR-0011)
RAW_REF_QUANTILE = 0.95
FIT_SAMPLE = 800  # cap on points used for the O(n^2) fit statistics


@dataclass(frozen=True)
class HabitatModel:
    bandwidth_km: float
    raw_ref: float
    ratio_ref: float | None  # effort-corrected reference (ADR-0018); None if no effort grid at fit
    localities: tuple[Point, ...]  # KDE support: finds thinned to ~DENSITY_GRID_DEG
    observations: tuple[Point, ...]  # every training find, for the confidence count
    spacing_km: float | None  # diagnostic: the k-NN locality spacing; None if unestimated

    @classmethod
    def fit(cls, points: Sequence[Point], effort_grid: EffortGrid | None = None) -> HabitatModel:
        pts = tuple((float(lon), float(lat)) for lon, lat in points)
        if len(pts) < 2:
            return cls(DEFAULT_BANDWIDTH_KM, 1.0 if pts else 0.0, None, pts, pts, None)

        band_localities = _dedupe(pts, LOCALITY_GRID_DEG)
        if len(band_localities) <= KNN_SEED:
            spacing = None
            bandwidth = DEFAULT_BANDWIDTH_KM
        else:
            sample_idx = _sample_indices(len(band_localities), FIT_SAMPLE)
            spacing = quantile(
                [_kth_nearest_other_km(i, band_localities, KNN_SEED) for i in sample_idx], 0.5
            )
            bandwidth = min(MAX_BANDWIDTH_KM, max(MIN_BANDWIDTH_KM, BANDWIDTH_FACTOR * spacing))

        localities = tuple(_dedupe(pts, DENSITY_GRID_DEG))
        loc_sample = _sample_indices(len(localities), FIT_SAMPLE)
        raw_ref = quantile(
            [_raw(localities[i][0], localities[i][1], localities, bandwidth) for i in loc_sample],
            RAW_REF_QUANTILE,
        )
        ratio_ref = None
        if effort_grid is not None:
            sampled = [localities[i] for i in loc_sample]
            # Only worth correcting if at least one of this species' own
            # localities has *real* (non-floored) background coverage --
            # otherwise every ratio is raw(loc)/MIN_EFFORT_TO_CORRECT, a
            # uniform rescale of raw_ref that "corrects" nothing.
            has_real_coverage = any(
                effort_grid.at(lon, lat) >= MIN_EFFORT_TO_CORRECT for lon, lat in sampled
            )
            if has_real_coverage:
                ratios = [
                    _raw(lon, lat, localities, bandwidth)
                    / _effort_denominator(effort_grid, lon, lat)
                    for lon, lat in sampled
                ]
                ratio_ref = quantile(ratios, RAW_REF_QUANTILE) if ratios else None
        return cls(bandwidth, raw_ref, ratio_ref, localities, pts, spacing)

    def raw(self, lon: float, lat: float) -> float:
        return _raw(lon, lat, self.localities, self.bandwidth_km)

    def score(self, lon: float, lat: float, effort: int | None = None) -> float:
        raw = self.raw(lon, lat)
        if effort is not None and self.ratio_ref is not None and self.ratio_ref > 0:
            ratio = raw / max(effort, MIN_EFFORT_TO_CORRECT)
            return min(1.0, ratio / self.ratio_ref)
        if self.raw_ref <= 0:
            return 0.0
        return min(1.0, raw / self.raw_ref)

    def count_within(self, lon: float, lat: float, radius_km: float | None = None) -> int:
        r = radius_km if radius_km is not None else self.bandwidth_km
        return sum(1 for plon, plat in self.observations if haversine_km(lat, lon, plat, plon) <= r)

    def to_dict(self) -> dict:
        """Serialised for the static artifact. The points are *not* included --
        the web app thins the species payload to the same grid at score time."""
        return {
            "bandwidth_km": round(self.bandwidth_km, 3),
            "raw_ref": round(self.raw_ref, 6),
            "ratio_ref": round(self.ratio_ref, 6) if self.ratio_ref is not None else None,
        }


def _sample_indices(n: int, limit: int) -> list[int]:
    return list(subsample(range(n), limit))


def _dedupe(points: Sequence[Point], grid_deg: float) -> list[Point]:
    """One point per ~``grid_deg`` cell, so heavily revisited spots count once.
    Keeps the first point seen per cell; callers pass points in a stable order
    (``ORDER BY observed_on, lon, lat``) so the web mirror picks the same one."""
    seen: set[tuple[int, int]] = set()
    out: list[Point] = []
    for lon, lat in points:
        key = (round(lon / grid_deg), round(lat / grid_deg))
        if key not in seen:
            seen.add(key)
            out.append((lon, lat))
    return out


def _raw(lon: float, lat: float, points: Sequence[Point], bandwidth: float) -> float:
    return sum(gaussian(haversine_km(lat, lon, plat, plon), bandwidth) for plon, plat in points)


def _effort_denominator(effort_grid: EffortGrid, lon: float, lat: float) -> float:
    return max(effort_grid.at(lon, lat), MIN_EFFORT_TO_CORRECT)


def _kth_nearest_other_km(i: int, points: Sequence[Point], k: int) -> float:
    lon, lat = points[i]
    dists = sorted(
        haversine_km(lat, lon, plat, plon) for j, (plon, plat) in enumerate(points) if j != i
    )
    if not dists:
        return 0.0
    return dists[min(k, len(dists)) - 1]
