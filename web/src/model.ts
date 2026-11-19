// Shapes and loaders for the model payload (pipeline/model/fit.py + current.py).

import { buildBiotopeGrid, type BiotopeGridLookup, type BiotopeSiteRow } from "./biotope";
import { buildEffortGrid, type EffortGridLookup, type EffortSiteRow } from "./effort";
import { buildHostTreeGrid, type HostTreeGridLookup, type HostTreeSiteRow } from "./hostTree";

const BASE = (import.meta.env.VITE_DATA_BASE ?? "/data").replace(/\/+$/, "");

export interface FeatureStat {
  mean: number;
  sd: number;
}

/** Forest-/soil-type affinity, peak-normalised per category (1.0 = the
 * category this species is found in most). Advisory only (ADR-0016) -- read
 * by `biotope.ts` to describe a pin's site, never by `score.ts`. */
export interface BiotopeAffinity {
  forest: Record<string, number>;
  soil: Record<string, number>;
}

export interface SpeciesModel {
  slug: string;
  // ratio_ref is the effort-corrected reference (ADR-0018); null if the
  // ingest step hasn't populated a recording-effort grid for this build.
  habitat: { bandwidth_km: number; raw_ref: number; ratio_ref: number | null };
  seasonality: { sigma_days: number; curve: number[] }; // curve: 366 values, peak 1
  weather: { n_observations: number; features: Record<string, FeatureStat> | null } | null;
  // Per-tree affinity (ADR-0019, an enrichment ratio -- see hostTree.ts),
  // keyed by the same species names as HostTreeSiteRow. Fitted whenever the
  // build has a host_tree_grid and this species has enough training data,
  // *regardless* of host_tree_scored -- null only when there wasn't enough
  // data to fit at all.
  host_tree: Record<string, number> | null;
  // Per-species opt-in (ADR-0019): score.ts only consults `host_tree` when
  // this is true, decided against the real backtest per species, not
  // uniformly -- see pipeline/model/host_tree.py's HOST_TREE_SCORED_SPECIES.
  // A species can have `host_tree` populated and still have this false.
  host_tree_scored: boolean;
  biotope: BiotopeAffinity | null;
  calibration: { x: number[]; y: number[] } | null;
  // diagnostics only, not consumed by the app; kept in step with the artifact
  fit: {
    n_observations: number;
    locality_spacing_km: number | null;
    weather_fitted: boolean;
    biotope_fitted: boolean;
    effort_corrected: boolean;
    host_tree_fitted: boolean;
    host_tree_scored: boolean;
    calibrated: boolean;
  };
}

export interface ModelManifestEntry {
  slug: string;
  file: string;
  bandwidth_km: number;
  weather_fitted: boolean;
}

export interface ModelManifest {
  version: string;
  weather_features: string[];
  current_conditions: string | null;
  /** Path to the published biotope grid (pipeline/model/biotope.py), or null
   * if the ingest step hasn't populated one. Advisory only -- see biotope.ts. */
  biotope_grid: string | null;
  /** Path to the published recording-effort grid (ADR-0018), or null if the
   * ingest step hasn't populated one. Feeds the habitat term -- see effort.ts. */
  recording_effort_grid: string | null;
  /** Path to the published host-tree grid (ADR-0019), or null if the ingest
   * step hasn't populated one. Feeds the ranked score -- see hostTree.ts. */
  host_tree_grid: string | null;
  species: ModelManifestEntry[];
}

export interface CurrentCell {
  cell_id: string;
  lon: number;
  lat: number;
  precip_days_covered: number;
  precip_14d_mm: number | null;
  precip_30d_mm: number | null;
  mean_temp_14d_c: number | null;
  dry_days_30d: number | null;
  // ADR-0017: wider/differently-timed windows, each gated by its own coverage
  // count instead of precip_days_covered -- see score.ts's COVERAGE_OVERRIDES.
  precip_60d_mm: number | null;
  precip_60d_days_covered: number;
  prior_summer_precip_mm: number | null;
  prior_summer_days_covered: number;
  [key: string]: string | number | null;
}

export interface CurrentConditions {
  as_of: string;
  features: string[];
  cells: CurrentCell[];
}

export interface ModelBundle {
  manifest: ModelManifest;
  current: CurrentConditions | null;
  bySlug: Map<string, ModelManifestEntry>;
  /** Advisory site grid (ADR-0016), or null if none was published. */
  biotopeGrid: BiotopeGridLookup | null;
  /** Recording-effort grid (ADR-0018), or null if none was published. */
  effortGrid: EffortGridLookup | null;
  /** Host-tree grid (ADR-0019), or null if none was published. */
  hostTreeGrid: HostTreeGridLookup | null;
}

const speciesModelCache = new Map<string, Promise<SpeciesModel>>();

export function loadSpeciesModel(file: string): Promise<SpeciesModel> {
  let pending = speciesModelCache.get(file);
  if (!pending) {
    pending = fetch(`${BASE}/${file}`).then((res) => {
      if (!res.ok) throw new Error(`Could not load ${file} (${res.status})`);
      return res.json() as Promise<SpeciesModel>;
    });
    speciesModelCache.set(file, pending);
  }
  return pending;
}

/** Load the model manifest + current conditions. Returns null if the payload
 * has no model section (e.g. an older deploy) — the app still works without it. */
export async function loadModelBundle(): Promise<ModelBundle | null> {
  try {
    // Default cache mode so the index.html preload is reused; see data.ts.
    const manRes = await fetch(`${BASE}/model/manifest.json`);
    if (!manRes.ok) return null;
    const manifest = (await manRes.json()) as ModelManifest;

    let current: CurrentConditions | null = null;
    if (manifest.current_conditions) {
      const curRes = await fetch(`${BASE}/${manifest.current_conditions}`);
      if (curRes.ok) current = (await curRes.json()) as CurrentConditions;
    }

    let biotopeGrid: BiotopeGridLookup | null = null;
    if (manifest.biotope_grid) {
      const gridRes = await fetch(`${BASE}/${manifest.biotope_grid}`);
      if (gridRes.ok) biotopeGrid = buildBiotopeGrid((await gridRes.json()) as BiotopeSiteRow[]);
    }

    let effortGrid: EffortGridLookup | null = null;
    if (manifest.recording_effort_grid) {
      const effortRes = await fetch(`${BASE}/${manifest.recording_effort_grid}`);
      if (effortRes.ok) effortGrid = buildEffortGrid((await effortRes.json()) as EffortSiteRow[]);
    }

    let hostTreeGrid: HostTreeGridLookup | null = null;
    if (manifest.host_tree_grid) {
      const hostTreeRes = await fetch(`${BASE}/${manifest.host_tree_grid}`);
      if (hostTreeRes.ok) {
        hostTreeGrid = buildHostTreeGrid((await hostTreeRes.json()) as HostTreeSiteRow[]);
      }
    }

    const bySlug = new Map(manifest.species.map((entry) => [entry.slug, entry]));
    return { manifest, current, bySlug, biotopeGrid, effortGrid, hostTreeGrid };
  } catch (err) {
    console.warn("model payload unavailable", err);
    return null;
  }
}
