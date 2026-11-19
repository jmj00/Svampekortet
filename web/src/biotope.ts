// Advisory site description (ADR-0016): what kind of forest/soil a pin sits
// on, and whether that's typical for the open species -- ported from
// pipeline/model/biotope.py, but deliberately NOT part of score.ts. Folding
// this into the ranked score regressed the backtest's week_matched gate for
// half the core species without a compensating gain elsewhere; it ships as
// read-only context on the conditions card instead.

import type { BiotopeAffinity } from "./model";
import { pyRound } from "./score";

// ~2 km, matches pipeline/model/biotope.py's GRID_DEG exactly -- both sides of
// the fit/serve gap must round to the same cell for the same place.
const GRID_DEG = 0.018;

export interface BiotopeSiteRow {
  lon: number;
  lat: number;
  forest_type: string | null;
  soil_tsym: string | null;
}

export interface Site {
  forestType: string | null;
  soilTsym: string | null;
}

export type BiotopeGridLookup = Map<string, Site>;

function gridKey(lon: number, lat: number): string {
  return `${pyRound(lon / GRID_DEG)},${pyRound(lat / GRID_DEG)}`;
}

export function buildBiotopeGrid(rows: readonly BiotopeSiteRow[]): BiotopeGridLookup {
  const grid: BiotopeGridLookup = new Map();
  for (const row of rows) {
    grid.set(gridKey(row.lon, row.lat), { forestType: row.forest_type, soilTsym: row.soil_tsym });
  }
  return grid;
}

/** Classify a pin's site, or null if it falls outside any classified cell
 * (sea, city, farmland -- most of a bounding-box-shaped grid). */
export function classifySite(grid: BiotopeGridLookup, lon: number, lat: number): Site | null {
  const site = grid.get(gridKey(lon, lat));
  if (!site || (site.forestType === null && site.soilTsym === null)) return null;
  return site;
}

// CORINE forest-type codes (pipeline/ingest/biotope.py's CORINE_FOREST_CODES),
// already English words -- translated for display.
const FOREST_LABELS: Record<string, string> = {
  coniferous: "Nåleskov",
  broadleaf: "Løvskov",
  mixed: "Blandskov",
};

// GEUS Jordartskort tsym -> Danish label, straight from the layer's own
// unique-value renderer (data.geus.dk/arcgis/rest/services/Denmark/
// Jordartskort_200000/MapServer/1?f=json). Every pre-Quaternary bedrock code
// (AF, BS, CV, ED, EQ, GC, GL, GNG, GS, HAG, JV, KA, KG, KQ, KS, LL, OL, PAM,
// PL, RG, ROG, SK, SVG, VAG, ZK) shares one label, same as the source map.
const PRAEKVARTAER = "Prækvartær aflejring";
const SOIL_LABELS: Record<string, string> = {
  ES: "Flyvesand",
  F: "Ferskvandsdannelser",
  HV: "Marsk",
  HSL: "Marint sand og ler",
  HG: "Strandvolde",
  MSG: "Morænesand og grus",
  ML: "Moræneler",
  DSG: "Smeltevandssand og -grus",
  DL: "Smeltevandsler",
  T: "Ekstramarginale aflejringer",
  Y: "Ældre havaflejringer",
  SØ: "Søaflejringer",
  FYLD: "Fyld, havne, diger m.m.",
  AF: PRAEKVARTAER,
  BS: PRAEKVARTAER,
  CV: PRAEKVARTAER,
  ED: PRAEKVARTAER,
  EQ: PRAEKVARTAER,
  GC: PRAEKVARTAER,
  GL: PRAEKVARTAER,
  GNG: PRAEKVARTAER,
  GS: PRAEKVARTAER,
  HAG: PRAEKVARTAER,
  JV: PRAEKVARTAER,
  KA: PRAEKVARTAER,
  KG: PRAEKVARTAER,
  KQ: PRAEKVARTAER,
  KS: PRAEKVARTAER,
  LL: PRAEKVARTAER,
  OL: PRAEKVARTAER,
  PAM: PRAEKVARTAER,
  PL: PRAEKVARTAER,
  RG: PRAEKVARTAER,
  ROG: PRAEKVARTAER,
  SK: PRAEKVARTAER,
  SVG: PRAEKVARTAER,
  VAG: PRAEKVARTAER,
  ZK: PRAEKVARTAER,
};

export function forestLabel(type: string): string {
  return FOREST_LABELS[type] ?? type;
}

export function soilLabel(tsym: string): string {
  return SOIL_LABELS[tsym] ?? tsym;
}

export type Typicality = "typical" | "seen" | "unusual" | "unknown";

export interface SiteFeature {
  label: string;
  typicality: Typicality;
}

export interface SiteDescription {
  forest: SiteFeature | null;
  soil: SiteFeature | null;
}

// Mirrors CategoryAffinity.score's bands (pipeline/model/biotope.py):
// 1.0 = the species' single most-common category; unseen categories floor at
// UNSEEN_CATEGORY_SCORE (0.15) there, which this treats as "unusual" here too.
function typicality(scores: Record<string, number>, category: string): Typicality {
  if (Object.keys(scores).length === 0) return "unknown"; // too few observations to fit
  const score = scores[category];
  if (score === undefined) return "unusual"; // never seen for this species
  return score >= 0.5 ? "typical" : "seen";
}

/** Describe a classified site for the open species, or null if there's
 * nothing classified here at all. `affinity` is null when the species has too
 * few classified training observations to fit -- the site labels still show,
 * just without a typicality qualifier. */
export function describeSite(
  site: Site | null,
  affinity: BiotopeAffinity | null,
): SiteDescription | null {
  if (!site) return null;
  const forest: SiteFeature | null = site.forestType
    ? {
        label: forestLabel(site.forestType),
        typicality: affinity ? typicality(affinity.forest, site.forestType) : "unknown",
      }
    : null;
  const soil: SiteFeature | null = site.soilTsym
    ? {
        label: soilLabel(site.soilTsym),
        typicality: affinity ? typicality(affinity.soil, site.soilTsym) : "unknown",
      }
    : null;
  if (!forest && !soil) return null;
  return { forest, soil };
}
