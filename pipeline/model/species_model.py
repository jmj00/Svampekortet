"""Combine the per-term models into one species-level conditions score.

    raw   = habitat x seasonality x weather x host_tree   (each term in [0, 1])
    value = round(100 x calibrate(geometric_mean(axes)))   (0..100)

``axes`` is ``(habitat, seasonality)`` plus ``weather`` and/or ``host_tree``
when available. The displayed value is the *geometric mean* of those axes,
not the bare product: the product of several sub-1.0 terms pins real finds
near zero (test-period finds scored p50 ~ 5/100), which is not a usable
favourability. The geometric mean is monotone in the raw product, so it
leaves every backtest ranking (and the ship gate) untouched while spreading
the scale so a median find in season reads ~ 40 and an excellent one ~ 90 --
see ADR-0008.

``calibrate`` is the identity: three calibration routes were measured against
the temporal backtest and none adopted -- per-axis isotonic (loses habitat
resolution, ADR-0008), isotonic vs backtest labels, and percentile-among-finds
(both ADR-0009). The ``calibration`` slot maps the combined favourability (a
single [0, 1] axis) and stays available for a later model that gives calibration
something a monotone rescale of these axes cannot. When a term is unavailable
it is a neutral 1.0, it is dropped from the geometric mean, and the confidence
band is knocked down a notch.

``biotope`` (ADR-0016) is fit and published alongside the other terms but
deliberately does **not** join ``raw``/``combine`` here: measured against the
real backtest, folding it into the ranked score regressed the week_matched
gate for half the core species without a compensating gain elsewhere (see
ADR-0016) -- the categorical forest-/soil-type signal is real (the feasibility
checks showed genuine per-species differentiation) but too coarse-grained
relative to the habitat term's own spatial precision to help *rank* real
finds, and the backtest has no way to measure the original goal (surfacing a
plausible but unreported spot) at all. It ships as advisory context instead --
``web/src/biotope.ts`` reads a species' ``biotope`` field directly to describe
a pin's site, without touching the score.

``host_tree`` (ADR-0019) is a direct retest of exactly that hypothesis at a
resolution the habitat term's own precision can actually use: real per-species
host-tree probability-of-occurrence (30m native, published at ~1km -- both
far finer than biotope's CORINE-derived 2km/3-class scheme), instead of a
coarse land-cover category. Every core species gets a ``HostTreeModel``
*fitted* (real, useful data -- see ``pipeline.model.host_tree`` for the
enrichment-ratio affinity), but unlike ``biotope``'s all-or-nothing advisory
status, whether it's actually *scored* is decided **per species**: measured
against the real backtest (a pilot, a full-model A/B, a weight sweep, and an
8-seed robustness check -- see the module docstring on
``pipeline.model.host_tree``), only species in ``HOST_TREE_SCORED_SPECIES``
showed a genuine, seed-robust net win with no offsetting regime cost. A
species not in that set still has ``self.host_tree`` populated (for display
and for re-validating later) but ``self.host_tree_scored`` is ``False``, so
``terms()``/``score()`` treat it exactly like ``biotope`` -- present, never
consulted.

``effort`` is the opposite case from ``biotope``: it is not a term at all,
just an optional refinement of the *habitat* term's own formula -- see
``pipeline.model.habitat`` for the effort-corrected ``ratio_ref`` design. The
caller looks up a query point's recording-effort count the same way it looks
up ``weather_features`` and passes it straight through to
``HabitatModel.score``; a caller that doesn't (``golden.py``, in particular)
gets exactly the uncorrected habitat score, unchanged. **ADR-0018 measured the
correction itself against the real backtest and rejected it** -- this
parameter stays because it's what makes the rejected feature safely dormant
(nothing in production supplies an effort grid, so it's always ``None``), not
because the correction is recommended.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass

from pipeline.model.biotope import BiotopeModel
from pipeline.model.calibration import IsotonicCalibrator
from pipeline.model.habitat import HabitatModel
from pipeline.model.host_tree import HostTreeModel, Site
from pipeline.model.seasonality import SeasonalityModel
from pipeline.model.weather import WeatherModel

# Observation counts within the habitat bandwidth that separate the confidence
# bands. Below LOW_CONFIDENCE_MAX finds nearby, the score is barely evidenced.
LOW_CONFIDENCE_MAX = 5
MEDIUM_CONFIDENCE_MAX = 20

_LOWER_BAND = {"high": "medium", "medium": "low", "low": "low"}

# habitat, seasonality, weather, host_tree, raw product
Terms = tuple[float, float, float, float, float]


def confidence_band(n_nearby: int) -> str:
    if n_nearby < LOW_CONFIDENCE_MAX:
        return "low"
    if n_nearby < MEDIUM_CONFIDENCE_MAX:
        return "medium"
    return "high"


def combine(
    habitat: float,
    seasonality: float,
    weather: float,
    host_tree: float,
    *,
    weather_available: bool,
    host_tree_available: bool,
) -> float:
    """Geometric mean of the axes -- ``weather``/``host_tree`` join only when
    available.

    Monotone in ``habitat x seasonality x weather x host_tree``, so it does
    not change any ranking the backtest measures; it only reshapes the 0..1
    range so the score is a usable favourability rather than a value pinned
    near zero (ADR-0008).
    """
    axes = [
        habitat,
        seasonality,
        *([weather] if weather_available else []),
        *([host_tree] if host_tree_available else []),
    ]
    return math.prod(axes) ** (1.0 / len(axes))


@dataclass(frozen=True)
class ConditionsScore:
    value: int  # 0..100, round(100 x geometric_mean(axes)) -- ADR-0008
    raw: float  # habitat x seasonality x weather x host_tree (bare product, diagnostic)
    habitat: float
    seasonality: float
    weather: float
    host_tree: float
    n_nearby: int  # observations within the habitat bandwidth of the query
    weather_available: bool
    host_tree_available: bool
    confidence: str  # "low" | "medium" | "high"

    def as_dict(self) -> dict:
        return {
            "value": self.value,
            "raw": round(self.raw, 6),
            "habitat": round(self.habitat, 4),
            "seasonality": round(self.seasonality, 4),
            "weather": round(self.weather, 4),
            "host_tree": round(self.host_tree, 4),
            "n_nearby": self.n_nearby,
            "weather_available": self.weather_available,
            "host_tree_available": self.host_tree_available,
            "confidence": self.confidence,
        }


@dataclass(frozen=True)
class SpeciesModel:
    slug: str
    habitat: HabitatModel
    seasonality: SeasonalityModel
    weather: WeatherModel | None = None
    host_tree: HostTreeModel | None = None
    # Per-species opt-in (ADR-0019): terms()/score() only consult host_tree
    # when this is True, decided against the real backtest per species -- see
    # HOST_TREE_SCORED_SPECIES. False for a species still fits and publishes
    # host_tree above, exactly like biotope's always-advisory status below.
    host_tree_scored: bool = False
    # Advisory only (ADR-0016) -- never read by terms()/score(). Published so
    # the web app can describe a pin's site without it touching the score.
    biotope: BiotopeModel | None = None
    calibration: IsotonicCalibrator | None = None

    def terms(
        self,
        lon: float,
        lat: float,
        day_of_year: int,
        weather_features: Mapping[str, float | None] | None = None,
        effort: int | None = None,
        site: Site | None = None,
    ) -> Terms:
        """The four terms and their product, without the confidence
        machinery. Cheap enough to call for every point in the backtest."""
        habitat = self.habitat.score(lon, lat, effort)
        seasonality = self.seasonality.score(day_of_year)
        weather = self.weather.score(weather_features) if self.weather else 1.0
        host_tree, _ = (
            self.host_tree.score(site) if self.host_tree and self.host_tree_scored else (1.0, False)
        )
        return habitat, seasonality, weather, host_tree, habitat * seasonality * weather * host_tree

    def calibrated(self, favourability: float) -> float:
        """Map the combined [0, 1] favourability through the calibration slot
        (the identity in v0 -- ADR-0008)."""
        return self.calibration.predict(favourability) if self.calibration else favourability

    def score(
        self,
        lon: float,
        lat: float,
        day_of_year: int,
        weather_features: Mapping[str, float | None] | None = None,
        effort: int | None = None,
        site: Site | None = None,
    ) -> ConditionsScore:
        habitat = self.habitat.score(lon, lat, effort)
        seasonality = self.seasonality.score(day_of_year)
        weather = self.weather.score(weather_features) if self.weather else 1.0
        host_tree, host_tree_available = (
            self.host_tree.score(site) if self.host_tree and self.host_tree_scored else (1.0, False)
        )
        raw = habitat * seasonality * weather * host_tree

        weather_available = self._weather_available(weather_features)
        n_nearby = self.habitat.count_within(lon, lat)
        band = confidence_band(n_nearby)
        combined = combine(
            habitat,
            seasonality,
            weather,
            host_tree,
            weather_available=weather_available,
            host_tree_available=host_tree_available,
        )
        lowered = weather_available and host_tree_available
        return ConditionsScore(
            value=round(100 * self.calibrated(combined)),
            raw=raw,
            habitat=habitat,
            seasonality=seasonality,
            weather=weather,
            host_tree=host_tree,
            n_nearby=n_nearby,
            weather_available=weather_available,
            host_tree_available=host_tree_available,
            confidence=band if lowered else _LOWER_BAND[band],
        )

    def _weather_available(self, weather_features: Mapping[str, float | None] | None) -> bool:
        if self.weather is None or not self.weather.is_fitted or not weather_features:
            return False
        return any(weather_features.get(name) is not None for name in self.weather.features)

    def to_dict(self) -> dict:
        return {
            "slug": self.slug,
            "habitat": self.habitat.to_dict(),
            "seasonality": self.seasonality.to_dict(),
            "weather": self.weather.to_dict() if self.weather else None,
            "host_tree": self.host_tree.to_dict() if self.host_tree else None,
            "host_tree_scored": self.host_tree_scored,
            "biotope": self.biotope.to_dict() if self.biotope else None,
            "calibration": self.calibration.to_dict() if self.calibration else None,
        }
