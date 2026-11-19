// "What's favourable here right now" — score every species at a point and date.

import { loadSpecies } from "./data";
import { loadSpeciesModel, type ModelBundle } from "./model";
import { type Conditions, conditionsScore } from "./score";
import type { Manifest } from "./types";

/** Score each species at `(lon, lat)` on `date`. Species whose document or
 * model fails to load are omitted from the map. Pass `slugs` to score only
 * that subset (e.g. ranking forests against a search-filtered species list)
 * instead of every published species. */
export async function rankHere(
  manifest: Manifest,
  bundle: ModelBundle,
  lon: number,
  lat: number,
  date: Date,
  slugs?: ReadonlySet<string>,
): Promise<Map<string, Conditions>> {
  const species = slugs ? manifest.species.filter((s) => slugs.has(s.slug)) : manifest.species;
  const scored = await Promise.all(
    species.map(async (summary) => {
      const entry = bundle.bySlug.get(summary.slug);
      if (!entry) return null;
      try {
        const [doc, model] = await Promise.all([
          loadSpecies(summary.file),
          loadSpeciesModel(entry.file),
        ]);
        const score = conditionsScore({
          points: doc.observations.map(([plon, plat]) => [plon, plat] as [number, number]),
          model,
          weatherFeatures: bundle.manifest.weather_features,
          current: bundle.current,
          effortGrid: bundle.effortGrid,
          hostTreeGrid: bundle.hostTreeGrid,
          lon,
          lat,
          date,
        });
        return [summary.slug, score] as const;
      } catch (err) {
        console.error(`could not score ${summary.slug}`, err);
        return null;
      }
    }),
  );
  return new Map(scored.filter((entry): entry is [string, Conditions] => entry !== null));
}
