"""Host-tree term: how likely this species' known host trees are to actually
be present at a query point, from real per-species probability-of-occurrence
maps (Bonannella et al. 2022, 30m resolution) -- not a coarse forest-type
category. See docs/adr/0019 for the full investigation this module's design
comes from.

    affinity(tree)   = mean(P(tree) over this species' own finds) / background(tree)
    host_tree(q)     = sum_tree(affinity(tree) x P(tree, q)) / sum_tree(affinity(tree))

``affinity`` is an *enrichment ratio*, not a raw mean: the raw mean alone was
measured to be dominated by whichever tree has the highest background
prevalence across Denmark generally (oak, in this dataset) regardless of a
species' real ecology -- oak came out as every core species' top "affinity",
including both Suillus pine specialists, simply because oak's probability is
high almost everywhere there's any forest at all. Dividing by each tree's own
background mean (``HostTreeGrid.background_means``) corrects for that: pine
is then correctly the top-enriched tree for every species, Suillus included.

``host_tree(q)`` is a weighted average of the *raw* per-tree probabilities at
q (not the enrichment ratios themselves), weighted by that enrichment -- not
rescaled to peak at 1.0 the way ``biotope.CategoryAffinity`` is, since the
underlying value is already a real probability. A tree this species has never
shown any association with (``affinity`` too thin to fit, or absent from the
grid entirely) contributes nothing, positively or negatively -- same "missing
data is neutral" convention as every other term.

Fixing the enrichment attribution did **not** change which species benefit
from this term in the real backtest: it was a real correctness bug (worth
fixing on its own), but not the cause of the Suillus regression measured
below. Every core species gets ``HostTreeModel`` *fitted* here regardless --
real, useful data, and a species not currently scored may clear the bar in
the future -- but ``HOST_TREE_SCORED_SPECIES`` gates which of them actually
join the ranked score (``SpeciesModel.host_tree_scored``, ADR-0019). Decided
empirically per species, not by literature/botanical host-specificity, after
a pilot -> full-model A/B -> weight sweep -> 8-seed robustness check found the
two most host-specific species in this corpus (the Suillus pair -- obligate
pine partners) were the ones *most* harmed at every weight tried, while a
broader generalist (craterellus-tubaeformis) was the one clean, seed-robust
win:

    craterellus-tubaeformis  -- scored: robust week_matched gain (~+0.014),
                                 calendar_random unaffected (~0)
    boletus-edulis            -- not scored: week_matched gain offset by a
    imleria-badia                 calendar_random cost at every weight tried,
                                   no weight helps both regimes
    cantharellus-cibarius     -- not scored: net negative on calendar_random
    suillus-luteus             -- not scored: harmful on *both* regimes at
    suillus-variegatus            every weight tried, most likely because
                                   their habitat term already saturates the
                                   spatial signal this term would otherwise add

The grid (``HostTreeGrid``) is the shared, published artifact: the same
~1 km grid (``GRID_DEG``, still finer than ``biotope``'s 2 km) classifies both
a species' training observations here and a query point in the web app
(``web/src/hostTree.ts``, a direct port) -- unaffected by which species are in
``HOST_TREE_SCORED_SPECIES``, since it's shared, per-tree infrastructure.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

# ~1 km -- a real backtest resolution sweep (ADR-0019) found the ingest's
# nearest-neighbour sampling (not the true area-average the sweep first used)
# measurably noisier than averaging at 2 km, but recovers a clean margin over
# the habitat-only baseline at ~1 km, at a fraction of the published-grid size
# a finer/averaged grid would need (most of non-forest Denmark is excluded
# entirely regardless -- see MIN_PROBABILITY_TO_INCLUDE in the ingest step).
GRID_DEG = 0.01

# Species native/common in Danish forests with a published 30m probability
# map (Bonannella et al.'s 16-species set) -- notably missing birch/aspen, so
# Leccinum gets no signal from this term at all.
HOST_TREE_SPECIES = (
    "fagus_sylvatica",
    "picea_abies",
    "pinus_sylvestris",
    "prunus_avium",
    "quercus_robur",
    "salix_caprea",
)

# Below this many classified training finds, a tree's mean-probability
# affinity is too shaky to use.
MIN_OBSERVATIONS_TO_FIT = 20

# Scientific names of the core species that actually use host_tree in the
# ranked score (ADR-0019) -- see the module docstring for the full per-species
# backtest results this list is built from. Every other core species still
# gets HostTreeModel *fitted* (SpeciesModel.host_tree, "host_tree_fitted");
# it's just never consulted by terms()/score() unless its scientific name is
# here. Add a species only after it clears the same bar: a real, seed-robust
# gain on at least one backtest regime with no offsetting cost on the other --
# not by assumed host specificity, which this investigation found to point the
# wrong way (the two most host-specific species measured were the two most
# harmed).
HOST_TREE_SCORED_SPECIES = frozenset({"Craterellus tubaeformis"})

Site = Mapping[str, float | None]  # host tree name -> probability 0..1, or None (no data there)


def _grid_key(lon: float, lat: float) -> tuple[int, int]:
    return round(lon / GRID_DEG), round(lat / GRID_DEG)


@dataclass(frozen=True)
class HostTreeGrid:
    """Denmark-wide per-species probability-of-occurrence lookup, built by
    `pipeline.ingest.host_tree` and published as `model/host_tree_grid.json`."""

    cells: Mapping[tuple[int, int], Site] = field(default_factory=dict)

    @classmethod
    def from_rows(cls, rows: Sequence[Sequence[float | None]]) -> HostTreeGrid:
        cells: dict[tuple[int, int], Site] = {}
        for row in rows:
            lon, lat, *values = row
            cells[_grid_key(lon, lat)] = dict(zip(HOST_TREE_SPECIES, values, strict=True))
        return cls(cells=cells)

    def classify(self, lon: float, lat: float) -> Site | None:
        return self.cells.get(_grid_key(lon, lat))

    def background_means(self) -> dict[str, float]:
        """Mean P(tree) across every classified cell -- how common each
        tree's probability is across Denmark generally, independent of any
        one mushroom species. ``HostTreeModel.fit`` divides by this so a
        widespread tree (oak, in this dataset) doesn't dominate every
        species' affinity just by being common everywhere (ADR-0019)."""
        sums = dict.fromkeys(HOST_TREE_SPECIES, 0.0)
        counts = dict.fromkeys(HOST_TREE_SPECIES, 0)
        for site in self.cells.values():
            for tree in HOST_TREE_SPECIES:
                value = site.get(tree)
                if value is not None:
                    sums[tree] += value
                    counts[tree] += 1
        return {tree: sums[tree] / counts[tree] for tree in HOST_TREE_SPECIES if counts[tree] > 0}

    def to_list(self) -> list[dict]:
        """Published shape: one row per classified cell, cell centre lon/lat
        recovered from its key (not the original sample point)."""
        out = []
        for key, site in self.cells.items():
            row = {"lon": round(key[0] * GRID_DEG, 5), "lat": round(key[1] * GRID_DEG, 5)}
            row.update(site)
            out.append(row)
        return out


@dataclass(frozen=True)
class HostTreeModel:
    affinity: Mapping[str, float] = field(default_factory=dict)  # tree -> enrichment ratio

    @classmethod
    def fit(
        cls, sites: Sequence[Site | None], background: Mapping[str, float] | None = None
    ) -> HostTreeModel:
        """``sites`` is one classified site (or None) per training
        observation, already looked up via `HostTreeGrid.classify`.
        ``background`` (`HostTreeGrid.background_means`) turns each tree's
        raw mean probability at these finds into an enrichment ratio over its
        general prevalence -- omit it (or pass a mapping missing a tree) to
        fall back to the raw mean for that tree, e.g. for callers without a
        grid loaded."""
        sums = dict.fromkeys(HOST_TREE_SPECIES, 0.0)
        counts = dict.fromkeys(HOST_TREE_SPECIES, 0)
        for site in sites:
            if site is None:
                continue
            for tree in HOST_TREE_SPECIES:
                value = site.get(tree)
                if value is not None:
                    sums[tree] += value
                    counts[tree] += 1
        affinity = {}
        for tree in HOST_TREE_SPECIES:
            if counts[tree] < MIN_OBSERVATIONS_TO_FIT:
                continue
            mean_at_finds = sums[tree] / counts[tree]
            base = background.get(tree) if background else None
            affinity[tree] = mean_at_finds / base if base else mean_at_finds
        return cls(affinity=affinity)

    def score(self, site: Site | None) -> tuple[float, bool]:
        """Returns ``(score, available)``. Unavailable (neutral 1.0) when
        there's no classification at the query point, or this species has no
        tree with enough training data to have a fitted affinity for."""
        if not self.affinity or site is None:
            return 1.0, False
        numerator = 0.0
        denominator = 0.0
        for tree, weight in self.affinity.items():
            value = site.get(tree)
            if value is None:
                continue
            numerator += weight * value
            denominator += weight
        if denominator <= 0:
            return 1.0, False
        return min(1.0, numerator / denominator), True

    def to_dict(self) -> dict:
        return {tree: round(v, 4) for tree, v in self.affinity.items()}

    @classmethod
    def from_dict(cls, data: Mapping[str, float]) -> HostTreeModel:
        return cls(affinity=dict(data))
