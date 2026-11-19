// "Forests near me": rank named forests (data.ts's forests.json — Danske
// Stednavne polygons, naturarealtype "skovPlantage") near a pin, for a
// click-to-go suggestion list. See pipeline/ingest/stednavne.py for the source.
//
// Two ranking modes: plain distance (nearestForests, always available), and
// "best conditions nearby" (rankForestsByScore) -- the highest current
// conditions score any species in the given `slugs` set reaches at that spot
// (the panel passes its currently search/chip-filtered core-tier species, so
// e.g. searching "kantarel" ranks forests for kantarel specifically), reusing
// the same per-species scoring the pin's ranked list already computes. Capped
// to the nearest MAX_CANDIDATES_TO_SCORE before scoring: scoring is a real (if
// cheap-per-call) computation repeated across every candidate, and a 50 km
// radius can hold well over a thousand named forests.

import {
  bboxDistanceKm,
  distanceToShapeKm,
  pointInShape,
  shapeAreaM2,
  type ForestOutlines,
  type ForestShape,
} from "./forestoutlines";
import type { ModelBundle } from "./model";
import { rankHere } from "./rank";
import { haversineKm } from "./score";
import type { ForestPoint, Manifest } from "./types";

export interface NearbyForest {
  name: string;
  /** A point inside the forest (where a pin put "on" the forest goes). */
  lon: number;
  lat: number;
  distanceKm: number;
  /** The forest's index in forests.json, which is also its outline's key. */
  index?: number;
  /** From forestAtPin with outlines: the pin is inside the forest, not just
   * beside it. */
  inside?: boolean;
  /** From forestAtPin with outlines: the pin stands on this forest's own
   * point, which only happens when the forest was chosen by name. */
  chosen?: boolean;
  /** From forestAtPin with outlines: the largest named forest this one lies
   * in at the pin (Mølleskov is a part of Rold Skov), if any. */
  partOf?: { name: string; index: number };
}

export interface RankedForest extends NearbyForest {
  /** Best current conditions score (0-100) among the ranked species here, or
   * null if none of them scored (e.g. an empty filter, or no model loaded). */
  score: number | null;
  /** Danish name of the species that reached `score`. */
  scoreSpecies: string | null;
}

export const MAX_RESULTS = 8;
// Confirmed slow to respond on a real device at 25 -- each candidate scores
// every rankable species, so this is the dominant cost of a search. Halving
// it roughly halves that cost; 12 is still plenty to find a genuinely good
// spot within the results shown (MAX_RESULTS).
export const MAX_CANDIDATES_TO_SCORE = 12;

function withinRadius(
  points: readonly ForestPoint[],
  lon: number,
  lat: number,
  radiusKm: number,
): NearbyForest[] {
  const within: NearbyForest[] = [];
  points.forEach((forest, index) => {
    const distanceKm = haversineKm(lat, lon, forest.lat, forest.lon);
    if (distanceKm <= radiusKm) {
      within.push({ name: forest.name, lon: forest.lon, lat: forest.lat, distanceKm, index });
    }
  });
  within.sort((a, b) => a.distanceKm - b.distanceKm);
  return within;
}

/** How many named forests lie within the radius at all. */
export function countWithin(
  points: readonly ForestPoint[],
  lon: number,
  lat: number,
  radiusKm: number,
): number {
  return withinRadius(points, lon, lat, radiusKm).length;
}

export function nearestForests(
  points: readonly ForestPoint[],
  lon: number,
  lat: number,
  radiusKm: number,
): NearbyForest[] {
  return withinRadius(points, lon, lat, radiusKm).slice(0, MAX_RESULTS);
}

/** Without outlines, a pin counts as being in or right beside a named forest
 * when the forest's point lies within this many km. */
export const PIN_FOREST_KM = 1.5;

/** With outlines, a pin that is in no forest still counts as being at one
 * whose edge is this near (km): a pin on the road or the car park along the
 * forest, or one that the outline's 25 m simplification left just outside. */
export const PIN_EDGE_MARGIN_KM = 0.125;

/**
 * What the location chip and the forest tab both ask, so they agree: the
 * forest at the pin (forestAtPin), or "pending" while the outlines for that
 * part of the country are on their way -- the caller then holds off naming
 * the pin for a moment rather than show a name it may have to take back.
 */
export function pinForest(
  points: readonly ForestPoint[],
  lon: number,
  lat: number,
  outlines?: ForestOutlines | null,
): NearbyForest | null | "pending" {
  if (outlines?.cover(lon, lat) === "pending") return "pending";
  return forestAtPin(points, lon, lat, outlines);
}

/** The key of a position as forests.json writes it (five decimals). */
const pointKey = (lon: number, lat: number): string => `${lon.toFixed(5)},${lat.toFixed(5)}`;

const chosenIndex = new WeakMap<readonly ForestPoint[], Map<string, number>>();

/** The forest whose own published point this is, if any. A pin lands exactly
 * on a forest's point only by choosing that forest -- from a search, from the
 * result list, from the "nearest forest" shortcut -- never by a tap on the
 * map, so this is how a chosen forest is known again (also after a reload,
 * which restores the pin's coordinates). Where two forests share a point the
 * larger one is taken. */
function forestChosenAt(points: readonly ForestPoint[], lon: number, lat: number): number | null {
  let byPoint = chosenIndex.get(points);
  if (!byPoint) {
    byPoint = new Map();
    points.forEach((forest, index) => {
      const key = pointKey(forest.lon, forest.lat);
      const before = byPoint?.get(key);
      if (before === undefined || (forest.area_m2 ?? 0) > (points[before].area_m2 ?? 0)) {
        byPoint?.set(key, index);
      }
    });
    chosenIndex.set(points, byPoint);
  }
  return byPoint.get(pointKey(lon, lat)) ?? null;
}

/**
 * THE rule for "which forest is the pin in".
 *
 * With outlines that cover the spot:
 *  1. a forest chosen by name stays that forest: when the pin stands on a
 *     forest's own point (see forestChosenAt) and that forest's outline holds
 *     it, that is the forest, even if a smaller named forest lies there too;
 *  2. otherwise the smallest forest whose outline contains the pin (a named
 *     part inside a larger forest wins over the larger one);
 *  3. failing that, the forest whose edge is nearest, within
 *     PIN_EDGE_MARGIN_KM;
 *  4. otherwise none.
 * The result's `partOf` names the largest other forest around it, if the
 * pin is in one that is larger than the forest itself.
 *
 * Without outlines (none published, or the band could not be fetched): the
 * nearest forest point within PIN_FOREST_KM.
 */
export function forestAtPin(
  points: readonly ForestPoint[],
  lon: number,
  lat: number,
  outlines?: ForestOutlines | null,
): NearbyForest | null {
  if (!outlines || outlines.cover(lon, lat) !== "ready") {
    return closestForest(points, lon, lat, PIN_FOREST_KM);
  }
  const areaOf = (index: number, shape: ForestShape): number =>
    points[index].area_m2 ?? shapeAreaM2(shape);
  const containing: { index: number; area: number }[] = [];
  let beside: { index: number; distanceKm: number } | null = null;
  for (const [index, shape] of outlines.entries()) {
    if (!points[index]) continue;
    if (bboxDistanceKm(lon, lat, shape) > PIN_EDGE_MARGIN_KM) continue;
    if (pointInShape(lon, lat, shape)) {
      containing.push({ index, area: areaOf(index, shape) });
    } else if (containing.length === 0) {
      const distanceKm = distanceToShapeKm(lon, lat, shape);
      if (distanceKm <= PIN_EDGE_MARGIN_KM && (!beside || distanceKm < beside.distanceKm)) {
        beside = { index, distanceKm };
      }
    }
  }
  if (containing.length === 0) {
    if (!beside) return null;
    const forest = points[beside.index];
    return {
      name: forest.name,
      lon: forest.lon,
      lat: forest.lat,
      distanceKm: beside.distanceKm,
      index: beside.index,
      inside: false,
    };
  }
  containing.sort((x, y) => x.area - y.area); // smallest first
  const chosen = forestChosenAt(points, lon, lat);
  const here = containing.find((c) => c.index === chosen) ?? containing[0];
  // the largest forest around it, when there is a larger one
  const around = containing[containing.length - 1];
  const forest = points[here.index];
  return {
    name: forest.name,
    lon: forest.lon,
    lat: forest.lat,
    distanceKm: 0,
    index: here.index,
    inside: true,
    ...(here.index === chosen ? { chosen: true } : {}),
    ...(around.index !== here.index && around.area > here.area
      ? { partOf: { name: points[around.index].name, index: around.index } }
      : {}),
  };
}

/** The nearest named forest within `maxKm`, or null. The distance is to the
 * forest's edge where its outline is loaded (0 inside it), otherwise to its
 * point. */
export function closestForest(
  points: readonly ForestPoint[],
  lon: number,
  lat: number,
  maxKm: number,
  outlines?: ForestOutlines | null,
): NearbyForest | null {
  let best: NearbyForest | null = null;
  points.forEach((forest, index) => {
    const shape = outlines?.shape(index) ?? null;
    let distanceKm: number;
    if (shape) {
      // the box is never further than the edge: skip the walk when it is too far
      if (bboxDistanceKm(lon, lat, shape) > (best ? best.distanceKm : maxKm)) return;
      distanceKm = distanceToShapeKm(lon, lat, shape);
    } else {
      distanceKm = haversineKm(lat, lon, forest.lat, forest.lon);
    }
    if (distanceKm <= maxKm && (!best || distanceKm < best.distanceKm)) {
      best = { name: forest.name, lon: forest.lon, lat: forest.lat, distanceKm, index };
    }
  });
  return best;
}

/** Whether two forest records are the same forest (same name at the same point). */
export function sameForest(
  a: { name: string; lon: number; lat: number },
  b: { name: string; lon: number; lat: number },
): boolean {
  return a.name === b.name && a.lon === b.lon && a.lat === b.lat;
}

export interface ForestScore {
  /** Best current conditions score (0-100) among `slugs` at the forest, or
   * null when none of them scored. */
  score: number | null;
  /** Danish name of the species that reached `score`. */
  scoreSpecies: string | null;
}

/** Today's score for one forest: the highest conditions score any species in
 * `slugs` reaches at the forest's point. What a row of the ranking shows. */
export async function scoreForest(
  forest: { lon: number; lat: number },
  manifest: Manifest,
  modelBundle: ModelBundle,
  slugs: ReadonlySet<string>,
  date: Date,
): Promise<ForestScore> {
  const scores = await rankHere(manifest, modelBundle, forest.lon, forest.lat, date, slugs);
  let best: { slug: string; value: number } | null = null;
  for (const [slug, conditions] of scores) {
    if (!best || conditions.value > best.value) best = { slug, value: conditions.value };
  }
  if (!best) return { score: null, scoreSpecies: null };
  const winner = best.slug;
  return {
    score: best.value,
    scoreSpecies: manifest.species.find((s) => s.slug === winner)?.danish_name ?? null,
  };
}

const COMPASS_DA = [
  "nord",
  "nordøst",
  "øst",
  "sydøst",
  "syd",
  "sydvest",
  "vest",
  "nordvest",
] as const;

/** Eight-point compass direction, as a Danish word, from one point to
 * another, e.g. "nordøst" (written out: "Ø" alone reads as "island").
 * Initial great-circle bearing. */
export function compassDa(fromLon: number, fromLat: number, toLon: number, toLat: number): string {
  const rad = Math.PI / 180;
  const dLon = (toLon - fromLon) * rad;
  const y = Math.sin(dLon) * Math.cos(toLat * rad);
  const x =
    Math.cos(fromLat * rad) * Math.sin(toLat * rad) -
    Math.sin(fromLat * rad) * Math.cos(toLat * rad) * Math.cos(dLon);
  const bearing = (Math.atan2(y, x) / rad + 360) % 360;
  return COMPASS_DA[Math.round(bearing / 45) % 8];
}

/** Rank the nearest candidate forests by the best conditions score any
 * species in `slugs` reaches there today, best first. Falls back to plain
 * distance order within the tie/no-score case. */
export async function rankForestsByScore(
  points: readonly ForestPoint[],
  manifest: Manifest,
  modelBundle: ModelBundle,
  slugs: ReadonlySet<string>,
  lon: number,
  lat: number,
  radiusKm: number,
  date: Date,
): Promise<RankedForest[]> {
  const candidates = withinRadius(points, lon, lat, radiusKm).slice(0, MAX_CANDIDATES_TO_SCORE);
  const scored = await Promise.all(
    candidates.map(async (forest): Promise<RankedForest> => ({
      ...forest,
      ...(await scoreForest(forest, manifest, modelBundle, slugs, date)),
    })),
  );

  scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.distanceKm - b.distanceKm);
  return scored.slice(0, MAX_RESULTS);
}
