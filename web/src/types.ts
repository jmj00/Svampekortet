import type { OutlineFileRef } from "./forestoutlines";

// Shapes of the published payload (pipeline/publish/site.py).

export interface Attribution {
  observations: string;
  weather: string;
  basemap: string;
  redlist: string;
  photos: string;
  forests: string;
}

export interface SpeciesSummary {
  slug: string;
  danish_name: string;
  scientific_name: string;
  group: string;
  /** "core" = validated conditions score; "extra" = best-effort, score not validated. */
  tier: "core" | "extra";
  score_validated: boolean;
  observation_count: number;
  /** Finds per month, January first -- the same array as the species document's.
   * Optional: a payload published before the list used it does not have it. */
  season_by_month?: number[];
  /** A small rendition of the first photo for list rows, or null without photos.
   * Optional for the same reason. */
  thumbnail?: string | null;
  file: string;
}

export interface Manifest {
  version: string;
  bbox: [number, number, number, number];
  attribution: Attribution;
  species: SpeciesSummary[];
  /** Path to the forest-points payload (data.ts's BASE), or null if none was published. */
  forests: string | null;
  /** The forests' outlines, split into files that each cover a band of the
   * country (forestoutlines.ts). Null or missing in a payload published
   * without them: the app then goes by the forest points alone. */
  forest_outlines?: OutlineFileRef[] | null;
}

/** A named forest (Danske Stednavne, naturarealtype "skovPlantage") — a
 * point inside it, not a boundary (the boundary is in the outline files). */
export interface ForestPoint {
  name: string;
  lon: number;
  lat: number;
  area_m2: number | null;
}

/** [longitude, latitude, month(1-12)] */
export type ObservationPoint = [number, number, number];

export interface SpeciesImage {
  url: string;
  credit: string;
  license: string;
  source: string;
  link: string | null;
}

export interface SpeciesDoc {
  slug: string;
  danish_name: string;
  scientific_name: string;
  group: string;
  tier: "core" | "extra";
  score_validated: boolean;
  edible: boolean;
  lookalike_risk: "low" | "medium" | "high";
  gbif_usage_key: number;
  redlist_category: string | null;
  description: string | null;
  images: SpeciesImage[];
  observation_count: number;
  season_by_month: number[];
  observations: ObservationPoint[];
}
