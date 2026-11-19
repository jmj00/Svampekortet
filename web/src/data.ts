import type { OutlineFileDoc } from "./forestoutlines";
import type { ForestPoint, Manifest, SpeciesDoc } from "./types";

// In dev this resolves to web/public/data/. In production it points at wherever
// the pipeline publishes its payload (set VITE_DATA_BASE at build time).
const BASE = (import.meta.env.VITE_DATA_BASE ?? "/data").replace(/\/+$/, "");

// Default cache mode so the `<link rel="preload">` in index.html is actually
// reused (a `no-cache` fetch counts as a different request and double-fetches).
// Freshness after a deploy is covered two ways regardless: Cloudflare Pages
// serves these unhashed files `max-age=0, must-revalidate`, and the service
// worker fetches `/data/` network-first with `cache: "no-store"`.
export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(`${BASE}/manifest.json`);
  if (!res.ok) throw new Error(`Could not load manifest (${res.status})`);
  return (await res.json()) as Manifest;
}

let forestsCache: Promise<ForestPoint[]> | null = null;

/** Loads the forest-points payload named by `manifest.forests`, or `[]` if none was
 * published (an older deploy, or a local dev build without the geodanmark table). */
export function loadForests(file: string | null): Promise<ForestPoint[]> {
  if (!file) return Promise.resolve([]);
  if (!forestsCache) {
    const pending = fetch(`${BASE}/${file}`).then((res) => {
      if (!res.ok) throw new Error(`Could not load ${file} (${res.status})`);
      return res.json() as Promise<ForestPoint[]>;
    });
    forestsCache = pending;
    // A failure must not stick: the next call (the finder's "Prøv igen") refetches.
    pending.catch(() => {
      if (forestsCache === pending) forestsCache = null;
    });
  }
  return forestsCache;
}

/** One of the outline files named in `manifest.forest_outlines`. Not cached
 * here: the outline store (forestoutlines.ts) keeps what it has loaded and
 * asks again only for a file that failed. */
export async function loadForestOutlineFile(file: string): Promise<OutlineFileDoc> {
  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) throw new Error(`Could not load ${file} (${res.status})`);
  return (await res.json()) as OutlineFileDoc;
}

const speciesCache = new Map<string, Promise<SpeciesDoc>>();

export function loadSpecies(file: string): Promise<SpeciesDoc> {
  let pending = speciesCache.get(file);
  if (!pending) {
    pending = fetch(`${BASE}/${file}`).then((res) => {
      if (!res.ok) throw new Error(`Could not load ${file} (${res.status})`);
      return res.json() as Promise<SpeciesDoc>;
    });
    speciesCache.set(file, pending);
  }
  return pending;
}
