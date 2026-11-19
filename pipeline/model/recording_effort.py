"""Recording-effort background grid: how much fungal recording (of *any*
species) happens near a point -- built to correct the habitat term for
observer/accessibility bias, the standard "target-group background" technique.
**ADR-0018 measured this against the real backtest and rejected it**: at every
correction strength tried, it made the habitat term's ranking worse, badly so
at full strength. This module and its correction machinery in
``pipeline.model.habitat`` stay in the repo, but nothing runs
``pipeline.ingest.recording_effort`` against a production database -- see
ADR-0018 for the numbers and the reason (recording effort and genuine habitat
quality are too confounded in this corpus for a naive ratio to separate).

Citizen-science fungal records are well documented to cluster near paths and
accessible ground far more than the underlying species distribution would
predict -- a different, better-evidenced angle on this project's original
"good spots get kept secret" concern than a site-characteristic covariate
(ADR-0016) turned out to be: this doesn't require foragers to be deliberately
hiding anything, plain accessibility bias produces the same symptom. Svampeatlas
records *every* fungal species, not just the ~50 Svampekortet publishes, so
"how much fungi-recording happens here at all" is a ready-made effort proxy
already sitting in the same archive `pipeline.ingest.svampeatlas` reads.

    effort(q) = count of Svampeatlas records (any species) in q's grid cell

A plain per-cell count, not a smoothed density surface: this is the
literature's own target-group-background method (a spatial histogram of
background/"target-group" records), and it is also the only form of this
computation that stays tractable to precompute nationally without the kind of
join blow-up `pipeline.ingest.biotope` hit (see its R-tree fix) -- a KDE
summed live over every one of Denmark's ~1M+ qualifying records per output
cell is not.

`pipeline.model.habitat.HabitatModel` uses this grid at both fit time (to
calibrate an effort-corrected reference alongside the uncorrected one) and
query time (to correct a live score) -- see its docstring for the two-reference
design and why an uncorrected fallback matters. A cell with too little
background data to trust (below ``MIN_EFFORT_TO_CORRECT``) does not get
divided down toward zero; see ``HabitatModel`` for how the floor is applied.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

# ~2 km, matching pipeline.model.biotope.GRID_DEG's scale for a background
# surface published at "advisory grid" resolution -- coarser than the
# continuous habitat KDE, deliberately: an effort surface this fine is mostly
# noise given how unevenly fungi get reported even along a single stretch of
# forest, and a coarser cell keeps the published grid a reasonable size.
GRID_DEG = 0.018

# Below this many background records in a cell, the local effort estimate is
# too thin to trust as a divisor -- HabitatModel floors the denominator here
# rather than dividing by a near-zero (or zero) count.
MIN_EFFORT_TO_CORRECT = 5


def _grid_key(lon: float, lat: float) -> tuple[int, int]:
    return round(lon / GRID_DEG), round(lat / GRID_DEG)


@dataclass(frozen=True)
class EffortGrid:
    """Denmark-wide recording-effort lookup, built by
    `pipeline.ingest.recording_effort` and published as
    `model/recording_effort_grid.json`."""

    cells: Mapping[tuple[int, int], int] = field(default_factory=dict)

    @classmethod
    def from_rows(cls, rows: Sequence[tuple[float, float, int]]) -> EffortGrid:
        return cls(cells={_grid_key(lon, lat): int(n) for lon, lat, n in rows})

    def at(self, lon: float, lat: float) -> int:
        """Background record count at ``q``'s cell, 0 if never recorded at all
        (open water, farmland, anywhere Svampeatlas simply has nothing)."""
        return self.cells.get(_grid_key(lon, lat), 0)

    def to_list(self) -> list[dict]:
        """Published shape: one row per non-empty cell, cell centre lon/lat
        recovered from its key (not any original point)."""
        return [
            {"lon": round(key[0] * GRID_DEG, 5), "lat": round(key[1] * GRID_DEG, 5), "n": n}
            for key, n in self.cells.items()
        ]
