"""Advisory site-characteristic term: how typical the query point's forest
type and soil type are for this species, relative to its *own* observations.

Complements the distance-based habitat term (ADR-0006, ADR-0011) in spirit --
habitat asks "is this near a known find"; biotope asks "does this place *look
like* where this species is usually found" -- but, unlike habitat/seasonality/
weather, it does **not** feed `species_model.combine()` or the ranked score.
Measured against the real backtest, folding it into the ranked product
regressed the week_matched ship gate (ADR-0007) for half the core species: the
categorical signal is real (the ADR-0016 feasibility checks found genuine
per-species differentiation), but the ~2 km grid is coarser than the habitat
term's own spatial precision, so multiplying it in added ranking noise at
week-matched's fine scale without a compensating gain elsewhere -- and the
backtest has no way to measure this term's actual goal (surfacing a plausible
but unreported spot) at all, since that spot has no historical record to
test against. See ADR-0016.

    forest_affinity(type) = freq(type | species) / max freq(:, | species)
    soil_affinity(tsym)   = freq(tsym | species) / max freq(:, | species)
    biotope(q)             = sqrt(forest_affinity x soil_affinity)

A category never seen among a species' own (classified) observations scores
UNSEEN_CATEGORY_SCORE, not zero -- swept against the real backtest this had no
measurable effect on the week_matched regression (ruling out "the floor is too
harsh" as the cause), but a hard zero would still make an unusual real site
look like an error rather than a mild "this isn't the typical spot" signal in
the advisory display. Either sub-term -- or the whole biotope term -- is
neutral (1.0, `available=False`) when there is nothing to compare: no
classification at the query point, or too few classified training
observations to trust a distribution (`MIN_OBSERVATIONS_TO_FIT`). Same
"missing data is neutral, not penalised" convention `pipeline.model.weather`
uses.

The grid lookup (`BiotopeGrid`) is the shared, published artifact: the same
~2 km grid (`GRID_DEG`) classifies both a species' training observations here
and a query point in the web app (`web/src/biotope.ts`, a direct port), so
both sides of the fit/serve gap read the same classification for the same
place.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

# ~2 km, applied uniformly to both lon and lat degrees -- same simplification
# pipeline.model.habitat's DENSITY_GRID_DEG makes (non-square cells at Danish
# latitudes, accepted there for simplicity; same trade-off here).
GRID_DEG = 0.018

MIN_OBSERVATIONS_TO_FIT = 20
UNSEEN_CATEGORY_SCORE = 0.15

Site = tuple[str | None, str | None]  # (forest_type, soil_tsym)


def _grid_key(lon: float, lat: float) -> tuple[int, int]:
    return round(lon / GRID_DEG), round(lat / GRID_DEG)


@dataclass(frozen=True)
class BiotopeGrid:
    """Denmark-wide forest-type/soil-type lookup, built by
    `pipeline.ingest.biotope` and published as `model/biotope_grid.json`."""

    cells: Mapping[tuple[int, int], Site] = field(default_factory=dict)

    @classmethod
    def from_rows(cls, rows: Sequence[tuple[float, float, str | None, str | None]]) -> BiotopeGrid:
        return cls(cells={_grid_key(lon, lat): (forest, soil) for lon, lat, forest, soil in rows})

    def classify(self, lon: float, lat: float) -> Site:
        return self.cells.get(_grid_key(lon, lat), (None, None))

    def to_list(self) -> list[dict]:
        """Published shape: one row per classified cell, cell centre lon/lat
        recovered from its key (not the original point) -- the grid is the
        source of truth for both fit and serve, so this is deliberately
        exact, not the original observation/query coordinate."""
        return [
            {
                "lon": round(key[0] * GRID_DEG, 5),
                "lat": round(key[1] * GRID_DEG, 5),
                "forest_type": forest,
                "soil_tsym": soil,
            }
            for key, (forest, soil) in self.cells.items()
        ]


@dataclass(frozen=True)
class CategoryAffinity:
    scores: Mapping[str, float] = field(default_factory=dict)  # category -> [0,1], peak = 1.0

    @classmethod
    def fit(cls, categories: Sequence[str | None]) -> CategoryAffinity:
        seen = [c for c in categories if c is not None]
        if len(seen) < MIN_OBSERVATIONS_TO_FIT:
            return cls(scores={})
        counts = Counter(seen)
        peak = max(counts.values())
        return cls(scores={cat: n / peak for cat, n in counts.items()})

    def score(self, category: str | None) -> float:
        if category is None or not self.scores:
            return 1.0  # no classification, or too few observations to trust one: neutral
        return self.scores.get(category, UNSEEN_CATEGORY_SCORE)

    def to_dict(self) -> dict:
        return {cat: round(v, 4) for cat, v in self.scores.items()}

    @classmethod
    def from_dict(cls, data: Mapping[str, float]) -> CategoryAffinity:
        return cls(scores=dict(data))


@dataclass(frozen=True)
class BiotopeModel:
    forest: CategoryAffinity
    soil: CategoryAffinity

    @classmethod
    def fit(cls, sites: Sequence[Site]) -> BiotopeModel:
        """``sites`` is one (forest_type, soil_tsym) pair per training
        observation, already classified via `BiotopeGrid.classify`."""
        return cls(
            forest=CategoryAffinity.fit([f for f, _ in sites]),
            soil=CategoryAffinity.fit([s for _, s in sites]),
        )

    def score(self, forest_type: str | None, soil_tsym: str | None) -> tuple[float, bool]:
        """Returns ``(score, available)``. ``available`` is False (score
        pinned to the neutral 1.0) only when *neither* sub-term has anything
        to compare -- mirrors `pipeline.model.weather`'s "join only when
        available" convention in `species_model.combine`."""
        forest_known = forest_type is not None and bool(self.forest.scores)
        soil_known = soil_tsym is not None and bool(self.soil.scores)
        if not forest_known and not soil_known:
            return 1.0, False
        return math.sqrt(self.forest.score(forest_type) * self.soil.score(soil_tsym)), True

    def to_dict(self) -> dict:
        return {"forest": self.forest.to_dict(), "soil": self.soil.to_dict()}

    @classmethod
    def from_dict(cls, data: Mapping[str, Mapping[str, float]]) -> BiotopeModel:
        return cls(
            forest=CategoryAffinity.from_dict(data["forest"]),
            soil=CategoryAffinity.from_dict(data["soil"]),
        )
