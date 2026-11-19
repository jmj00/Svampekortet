// The v0 conditions score, ported from pipeline/model/. Kept in step with the
// Python: habitat KDE, seasonality curve and weather typicality, each in [0, 1].
// The 0..100 value is the geometric mean of those axes (weather only when
// available) — monotone in their product, so it matches the backtest ranking
// while spreading the scale (ADR-0008). No calibration in v0 (ADR-0007). The
// habitat KDE runs over finds thinned to a ~660 m grid, matching the Python
// raw_ref fit (ADR-0011). The Python side has the tests.

import { type EffortGridLookup, lookupEffort } from "./effort";
import { hostTreeScore, type HostTreeGridLookup, lookupHostTreeSite } from "./hostTree";
import type { CurrentCell, CurrentConditions, FeatureStat, SpeciesModel } from "./model";

const EARTH_RADIUS_KM = 6371.0088;
const DAYS_IN_YEAR = 366;

const LOW_CONFIDENCE_MAX = 5;
const MEDIUM_CONFIDENCE_MAX = 20;
const LOWER_BAND: Record<Confidence, Confidence> = {
  high: "medium",
  medium: "low",
  low: "low",
};

const SD_FLOOR_FRAC = 0.05;
const MIN_SD = 1e-6;
const MIN_LIKELIHOOD = 1e-12;
const FULL_WINDOW_DAYS = 28;
const MAX_CELL_DISTANCE_KM = 12; // beyond this a pin is treated as off the weather grid
const DENSITY_GRID_DEG = 0.006; // ~660 m; habitat KDE support, matches habitat.py (ADR-0011)

// ADR-0018: floors the effort denominator so a barely- (or never-) recorded
// cell can't blow the corrected ratio up -- port of
// pipeline/model/recording_effort.py's MIN_EFFORT_TO_CORRECT.
const MIN_EFFORT_TO_CORRECT = 5;

// ADR-0017: precip_60d_mm and prior_summer_precip_mm need a wider or
// differently-timed window than the rest, so each is gated by its own
// coverage column/threshold instead of the shared precip_days_covered one --
// port of pipeline/model/weather.py's coverage_column_and_threshold.
const COVERAGE_OVERRIDES: Record<string, { column: keyof CurrentCell; threshold: number }> = {
  precip_60d_mm: { column: "precip_60d_days_covered", threshold: 56 },
  prior_summer_precip_mm: { column: "prior_summer_days_covered", threshold: 85 },
};

export type Confidence = "low" | "medium" | "high";

/** Coarse band for a score pill's colour — shared between the species panel
 * and the "forests near me" list, so both read the same 0-100 number the
 * same way. */
export function scoreBand(value: number): "good" | "ok" | "low" {
  if (value >= 60) return "good";
  if (value >= 30) return "ok";
  return "low";
}

export interface Conditions {
  value: number; // 0..100
  raw: number;
  habitat: number;
  seasonality: number;
  weather: number;
  hostTree: number;
  nNearby: number;
  weatherAvailable: boolean;
  hostTreeAvailable: boolean;
  confidence: Confidence;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rlat1 = (lat1 * Math.PI) / 180;
  const rlat2 = (lat2 * Math.PI) / 180;
  const dlat = rlat2 - rlat1;
  const dlon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(rlat1) * Math.cos(rlat2) * Math.sin(dlon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(a));
}

export function dayOfYear(date: Date): number {
  // local calendar date, mapped through UTC so DST transitions don't shift it
  const start = Date.UTC(date.getFullYear(), 0, 1);
  const today = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((today - start) / 86_400_000) + 1;
}

function gaussian(distance: number, bandwidth: number): number {
  const z = distance / bandwidth;
  return Math.exp(-0.5 * z * z);
}

export function habitatRaw(
  points: readonly [number, number][],
  bandwidthKm: number,
  lon: number,
  lat: number,
): number {
  let sum = 0;
  for (const [plon, plat] of points)
    sum += gaussian(haversineKm(lat, lon, plat, plon), bandwidthKm);
  return sum;
}

// Python's round() is half-to-even; JS Math.round is half-up. Grid keys land on
// exact halves for coordinates that are odd multiples of gridDeg/2, so match
// Python to keep the same cell assignment on both sides.
export function pyRound(x: number): number {
  const floor = Math.floor(x);
  const frac = x - floor;
  if (frac < 0.5) return floor;
  if (frac > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** One point per ~gridDeg cell, first seen wins — port of habitat._dedupe. The
 * species payload is ordered `observed_on, lon, lat`, the same order the Python
 * fit dedupes in, so both keep the same representative point per cell. */
export function dedupeToGrid(
  points: readonly [number, number][],
  gridDeg: number,
): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const [lon, lat] of points) {
    const key = `${pyRound(lon / gridDeg)},${pyRound(lat / gridDeg)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push([lon, lat]);
    }
  }
  return out;
}

// The forest scores on the map score one species at up to 120 forests, all
// with the same payload array; cache the density thinning by that array's
// identity.
const densityCache = new WeakMap<readonly [number, number][], [number, number][]>();

function densityLocalities(points: readonly [number, number][]): [number, number][] {
  let hit = densityCache.get(points);
  if (!hit) {
    hit = dedupeToGrid(points, DENSITY_GRID_DEG);
    densityCache.set(points, hit);
  }
  return hit;
}

/** Port of HabitatModel.score (ADR-0018): `ratioRef`/`effort` correct for
 * local recording effort when both are available, falling back to the
 * original `rawRef` comparison exactly as before otherwise -- a caller that
 * doesn't look up `effort` gets today's uncorrected score, unchanged. */
export function habitatScore(
  raw: number,
  rawRef: number,
  ratioRef: number | null = null,
  effort: number | null = null,
): number {
  if (effort !== null && ratioRef !== null && ratioRef > 0) {
    const ratio = raw / Math.max(effort, MIN_EFFORT_TO_CORRECT);
    return Math.min(1, ratio / ratioRef);
  }
  if (rawRef <= 0) return 0;
  return Math.min(1, raw / rawRef);
}

export function countWithin(
  points: readonly [number, number][],
  radiusKm: number,
  lon: number,
  lat: number,
): number {
  let n = 0;
  for (const [plon, plat] of points) if (haversineKm(lat, lon, plat, plon) <= radiusKm) n += 1;
  return n;
}

export function seasonalityScore(curve: readonly number[], doy: number): number {
  if (curve.length === 0) return 0;
  const i = Math.max(1, Math.min(DAYS_IN_YEAR, Math.trunc(doy))) - 1;
  return curve[Math.min(i, curve.length - 1)] ?? 0;
}

export function weatherScore(
  features: Record<string, FeatureStat> | null,
  current: Record<string, number | null>,
): number {
  if (!features) return 1;
  const likelihoods: number[] = [];
  for (const [name, stat] of Object.entries(features)) {
    const x = current[name];
    if (x === null || x === undefined) continue;
    const sd = Math.max(stat.sd, SD_FLOOR_FRAC * Math.abs(stat.mean), MIN_SD);
    const z = (x - stat.mean) / sd;
    likelihoods.push(Math.max(Math.exp(-0.5 * z * z), MIN_LIKELIHOOD));
  }
  if (likelihoods.length === 0) return 1;
  const logMean = likelihoods.reduce((acc, v) => acc + Math.log(v), 0) / likelihoods.length;
  return Math.exp(logMean);
}

export function nearestCell(
  cells: readonly CurrentCell[],
  lon: number,
  lat: number,
): { cell: CurrentCell; distKm: number } | null {
  let best: { cell: CurrentCell; distKm: number } | null = null;
  for (const cell of cells) {
    const distKm = haversineKm(lat, lon, cell.lat, cell.lon);
    if (!best || distKm < best.distKm) best = { cell, distKm };
  }
  return best;
}

export function confidenceBand(nNearby: number): Confidence {
  if (nNearby < LOW_CONFIDENCE_MAX) return "low";
  if (nNearby < MEDIUM_CONFIDENCE_MAX) return "medium";
  return "high";
}

export interface ScoreInputs {
  points: readonly [number, number][];
  model: SpeciesModel;
  weatherFeatures: readonly string[];
  current: CurrentConditions | null;
  lon: number;
  lat: number;
  date: Date;
  /** Recording-effort grid (ADR-0018), or omit/null for the uncorrected
   * habitat score -- see habitatScore. */
  effortGrid?: EffortGridLookup | null;
  /** Host-tree grid (ADR-0019), or omit/null to leave the host_tree axis
   * neutral -- see hostTreeScore. */
  hostTreeGrid?: HostTreeGridLookup | null;
}

export function conditionsScore(input: ScoreInputs): Conditions {
  const { points, model, weatherFeatures, current, lon, lat, date, effortGrid, hostTreeGrid } =
    input;

  const bandwidth = model.habitat.bandwidth_km;
  const localities = densityLocalities(points);
  const effort = effortGrid ? lookupEffort(effortGrid, lon, lat) : null;
  const habitat = habitatScore(
    habitatRaw(localities, bandwidth, lon, lat),
    model.habitat.raw_ref,
    model.habitat.ratio_ref,
    effort,
  );
  const seasonality = seasonalityScore(model.seasonality.curve, dayOfYear(date));

  let weather = 1;
  let weatherAvailable = false;
  const near = current ? nearestCell(current.cells, lon, lat) : null;
  if (
    model.weather?.features &&
    near &&
    near.distKm <= MAX_CELL_DISTANCE_KM &&
    near.cell.precip_days_covered >= FULL_WINDOW_DAYS
  ) {
    const observed: Record<string, number | null> = {};
    for (const name of weatherFeatures) {
      const v = near.cell[name];
      const override = COVERAGE_OVERRIDES[name];
      const covered = override ? near.cell[override.column] : near.cell.precip_days_covered;
      const enough =
        typeof covered === "number" && covered >= (override?.threshold ?? FULL_WINDOW_DAYS);
      observed[name] = typeof v === "number" && enough ? v : null;
    }
    if (weatherFeatures.some((name) => observed[name] !== null)) {
      weather = weatherScore(model.weather.features, observed);
      weatherAvailable = true;
    }
  }

  const site = hostTreeGrid ? lookupHostTreeSite(hostTreeGrid, lon, lat) : null;
  // ADR-0019: host_tree may be fitted but not yet validated for this species
  // (host_tree_scored false) -- mirrors pipeline/model/species_model.py's
  // terms()/score() gating exactly, so a species not in
  // HOST_TREE_SCORED_SPECIES stays neutral/unavailable even with real data.
  const { value: hostTree, available: hostTreeAvailable } = hostTreeScore(
    model.host_tree_scored ? model.host_tree : null,
    site,
  );

  const raw = habitat * seasonality * weather * hostTree;
  // geometric mean of the axes — weather/hostTree join only when available (ADR-0008)
  const axes = [
    habitat,
    seasonality,
    ...(weatherAvailable ? [weather] : []),
    ...(hostTreeAvailable ? [hostTree] : []),
  ];
  const combined = axes.reduce((product, term) => product * term, 1) ** (1 / axes.length);
  const nNearby = countWithin(points, bandwidth, lon, lat);
  const band = confidenceBand(nNearby);
  // ADR-0019: confidence is only kept at its full band when *both* optional
  // axes are present -- one present but not the other still knocks it down,
  // matching pipeline/model/species_model.py's `lowered` gate exactly.
  const lowered = weatherAvailable && hostTreeAvailable;
  return {
    value: Math.round(100 * combined),
    raw,
    habitat,
    seasonality,
    weather,
    hostTree,
    nNearby,
    weatherAvailable,
    hostTreeAvailable,
    confidence: lowered ? band : LOWER_BAND[band],
  };
}
