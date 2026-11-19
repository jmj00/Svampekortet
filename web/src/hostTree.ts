// Host-tree term (ADR-0019): how likely this species' known host trees are to
// actually be present at a query point, from real per-species probability-of-
// occurrence maps -- ported from pipeline/model/host_tree.py. Unlike
// biotope.ts, this *does* feed the ranked score: see score.ts's hostTreeScore.

import { pyRound } from "./score";

// ~1 km, matches pipeline/model/host_tree.py's GRID_DEG exactly -- both sides
// of the fit/serve gap must round to the same cell for the same place.
const GRID_DEG = 0.01;

export interface HostTreeSiteRow {
  lon: number;
  lat: number;
  [species: string]: number | null;
}

/** Per-tree probability (0..1) at a classified cell; a tree absent from the
 * row (never included at that cell -- see MIN_PROBABILITY_TO_INCLUDE in the
 * ingest step) or null contributes nothing to hostTreeScore. */
export type Site = Record<string, number | null>;

export type HostTreeGridLookup = Map<string, Site>;

function gridKey(lon: number, lat: number): string {
  return `${pyRound(lon / GRID_DEG)},${pyRound(lat / GRID_DEG)}`;
}

export function buildHostTreeGrid(rows: readonly HostTreeSiteRow[]): HostTreeGridLookup {
  const grid: HostTreeGridLookup = new Map();
  for (const { lon, lat, ...site } of rows) grid.set(gridKey(lon, lat), site);
  return grid;
}

/** Classify a query point's site, or null if it falls outside any classified
 * cell (sea, farmland, or just too little of any of these six species). */
export function lookupHostTreeSite(
  grid: HostTreeGridLookup,
  lon: number,
  lat: number,
): Site | null {
  return grid.get(gridKey(lon, lat)) ?? null;
}

/** Port of HostTreeModel.score (ADR-0019): a weighted average of the raw
 * per-tree probabilities at `site`, weighted by `affinity` (how much this
 * species' own training observations favoured each tree). Neutral (1, not
 * available) when the species has no fitted affinity or the point falls
 * outside the classified grid -- same "missing data is neutral" convention as
 * every other term. */
export function hostTreeScore(
  affinity: Record<string, number> | null,
  site: Site | null,
): { value: number; available: boolean } {
  if (!affinity || Object.keys(affinity).length === 0 || !site) {
    return { value: 1, available: false };
  }
  let numerator = 0;
  let denominator = 0;
  for (const [tree, weight] of Object.entries(affinity)) {
    const value = site[tree];
    if (value === null || value === undefined) continue;
    numerator += weight * value;
    denominator += weight;
  }
  if (denominator <= 0) return { value: 1, available: false };
  return { value: Math.min(1, numerator / denominator), available: true };
}
