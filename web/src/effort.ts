// Recording-effort background grid (ADR-0018): how much fungal recording (of
// *any* species) happens near a point, used inside score.ts to correct the
// habitat term for observer/accessibility bias -- ported from
// pipeline/model/recording_effort.py. Unlike biotope.ts, this *does* feed the
// ranked score: it's a refinement of the habitat term's own formula, not a
// separate axis. See score.ts's HabitatModel-mirroring habitatScore/habitatRatio.

import { pyRound } from "./score";

// ~2 km, matches pipeline/model/recording_effort.py's GRID_DEG exactly -- both
// sides of the fit/serve gap must round to the same cell for the same place.
const GRID_DEG = 0.018;

export interface EffortSiteRow {
  lon: number;
  lat: number;
  n: number;
}

export type EffortGridLookup = Map<string, number>;

function gridKey(lon: number, lat: number): string {
  return `${pyRound(lon / GRID_DEG)},${pyRound(lat / GRID_DEG)}`;
}

export function buildEffortGrid(rows: readonly EffortSiteRow[]): EffortGridLookup {
  const grid: EffortGridLookup = new Map();
  for (const row of rows) grid.set(gridKey(row.lon, row.lat), row.n);
  return grid;
}

/** Background record count at `q`'s cell, 0 if Svampeatlas has never recorded
 * anything there at all (open water, farmland, ...). */
export function lookupEffort(grid: EffortGridLookup, lon: number, lat: number): number {
  return grid.get(gridKey(lon, lat)) ?? 0;
}
