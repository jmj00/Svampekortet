// Adressevælgeren -- Klimadatastyrelsens replacement for DAWA, which shuts
// down permanently 2026-10-01 (docs/data-sources.md). Two calls where DAWA's
// autocomplete needed one: a phonetic search returns candidate ids with no
// coordinates, so each candidate needs a follow-up lookup by id. Both use the
// same VITE_DATAFORDELER_API_KEY as the basemap (web/src/map.ts) -- a plain
// API-Key, safe to ship in client code (unlike an OAuth Shared Secret), scoped
// to Datafordeler's public/unprotected data.
//
// What the service offers (checked against it, 2026-11-19; it has no public
// documentation): `/soeg?tekst=` returns up to 100 hits of three kinds --
// `vejnavn` (a street name), `navngivenvejpostnummer` (a street in a postal
// district) and `husnummer` (an address) -- sorted by postal number, not by
// how well they match; spelling is matched phonetically. A postal number
// after the address in the text ("Vestergade 10, 8600") narrows the search to
// that district; a town name in the text does not, and a town alone finds
// nothing (no towns, postal districts or place names in this service). The
// only filter parameter that works is `kommunekode` (four digits, comma
// separated); `postnummer` is checked for four characters but then ignored.
// `/husnumre?id_lokalids=a,b` looks up several addresses in one request.
// So a town or postal number in the query is turned into "…, <postnr>" here
// (placeindex.ts), and the towns themselves come from the app's own list.
//
// Lookup responses carry coordinates in EPSG:25832 (UTM zone 32N) -- all of
// Denmark falls in one UTM zone, so utm32nToWgs84 below hard-codes it rather
// than handling zones generally. Converted here since the rest of this
// codebase works in WGS84 [lon, lat] (matches GeoJSON convention).

import {
  loadPlaceIndex,
  matchPlaces,
  normalizeName,
  parseAddressQuery,
  type AddressQuery,
  type PlaceSuggestion,
} from "./placeindex";

const TOKEN = import.meta.env.VITE_DATAFORDELER_API_KEY;
const SEARCH_ENDPOINT = "https://adressevaelger.dk/soeg";
const LOOKUP_ENDPOINT = "https://adressevaelger.dk/husnumre";
const MAX_RESULTS = 6;

// Shape kept close to DAWA's `adgangsadresser/autocomplete` item so the rest
// of the app (main.ts) didn't need to change.
export interface AddressSuggestion {
  tekst: string;
  adgangsadresse: {
    id: string;
    vejnavn: string;
    husnr: string;
    postnr: string;
    postnrnavn: string;
    x: number; // longitude, WGS84
    y: number; // latitude, WGS84
  };
}

interface SearchHit {
  type: string;
  id: string;
  /** "Vestergade 10, 8600 Silkeborg" */
  titel?: string;
}

interface SearchResponse {
  status: string;
  fund: SearchHit[];
}

interface LookupItem {
  id_lokalid: string;
  husnummertekst: string;
  adgangsadressebetegnelse: string;
  vejnavn: string;
  postnummer: { navn: string; postnr: string };
  adgangspunkt: { koordinater: { x: number; y: number } };
}

interface LookupResponse {
  status: string;
  husnumre: LookupItem[];
}

// WGS84/GRS80 ellipsoid; UTM zone 32N (central meridian 9°E) covers all of
// Denmark. Standard Snyder inverse transverse-Mercator series, accurate to
// well under a metre at this scale -- verified against a known address
// (Rold Skovvej 10, Horsens) during development.
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const UTM_K0 = 0.9996;
const UTM_E0 = 500000;
const UTM32_LON0 = (9 * Math.PI) / 180;

export function utm32nToWgs84(x: number, y: number): [number, number] {
  const e2 = WGS84_F * (2 - WGS84_F);
  const ePrime2 = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));

  const m = y / UTM_K0;
  const mu = m / (WGS84_A * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const n1 = WGS84_A / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
  const t1 = Math.tan(phi1) ** 2;
  const c1 = ePrime2 * Math.cos(phi1) ** 2;
  const r1 = (WGS84_A * (1 - e2)) / (1 - e2 * Math.sin(phi1) ** 2) ** 1.5;
  const d = (x - UTM_E0) / (n1 * UTM_K0);

  const lat =
    phi1 -
    ((n1 * Math.tan(phi1)) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ePrime2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ePrime2 - 3 * c1 ** 2) * d ** 6) / 720);

  const lon =
    UTM32_LON0 +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ePrime2 + 24 * t1 ** 2) * d ** 5) / 120) /
      Math.cos(phi1);

  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

/** The addresses behind the ids, in one request, in the order given. */
async function lookup(ids: string[], signal?: AbortSignal): Promise<AddressSuggestion[]> {
  if (ids.length === 0) return [];
  const res = await fetch(`${LOOKUP_ENDPOINT}?id_lokalids=${ids.join(",")}&token=${TOKEN}`, {
    signal,
  });
  if (!res.ok) throw new Error(`Adressevælgeren responded ${res.status}`);
  const data = (await res.json()) as LookupResponse;
  const byId = new Map((data.husnumre ?? []).map((item) => [item.id_lokalid, item]));
  const out: AddressSuggestion[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    const point = item?.adgangspunkt?.koordinater;
    if (!item || !point) continue;
    const [lon, lat] = utm32nToWgs84(point.x, point.y);
    out.push({
      tekst: item.adgangsadressebetegnelse,
      adgangsadresse: {
        id,
        vejnavn: item.vejnavn,
        husnr: item.husnummertekst,
        postnr: item.postnummer.postnr,
        postnrnavn: item.postnummer.navn,
        x: lon,
        y: lat,
      },
    });
  }
  return out;
}

/** The ids of the addresses one search finds. */
async function soeg(text: string, signal?: AbortSignal, prefer: string[] = []): Promise<string[]> {
  const res = await fetch(`${SEARCH_ENDPOINT}?tekst=${encodeURIComponent(text)}&token=${TOKEN}`, {
    signal,
  });
  if (!res.ok) throw new Error(`Adressevælgeren responded ${res.status}`);
  const data = (await res.json()) as SearchResponse;
  const hits = (data.fund ?? []).filter((hit) => hit.type === "husnummer");
  return preferHits(hits, prefer).map((hit) => hit.id);
}

/** Pure: the hits in a preferred postal district first (by the district name
 * at the end of each title, "Vestergade 10, 1456 København K"), otherwise
 * in the service's order. */
export function preferHits<T extends { titel?: string }>(hits: T[], prefer: string[]): T[] {
  if (prefer.length === 0) return hits;
  const inPreferred = (hit: T): boolean => {
    const district = normalizeName((hit.titel ?? "").replace(/^.*,\s*\d{4}\s+/, ""));
    return prefer.includes(district);
  };
  return [...hits.filter(inPreferred), ...hits.filter((hit) => !inPreferred(hit))];
}

/** Pure: the hits of several searches as one list, each search's own order
 * kept and its turn taken in order (the first search is the best guess), no
 * address twice. */
export function mergeHits(lists: string[][], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const id of list) {
      if (out.length >= max) return out;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Addresses for what is typed. A town or postal number in the query narrows
 * the search to its postal district (placeindex.ts parseAddressQuery); when
 * that finds nothing (a street the town does not have, a town misread), the
 * query is tried again as typed. Only the typed text goes to the service.
 */
export async function searchAddresses(
  query: string,
  signal?: AbortSignal,
): Promise<AddressSuggestion[]> {
  const q = query.trim();
  if (q.length < 3 || !TOKEN) return [];

  const index = await loadPlaceIndex().catch(() => null); // without it: the query as typed
  const parsed: AddressQuery = index ? parseAddressQuery(index, q) : { texts: [q], scoped: false };
  const prefer = parsed.prefer ?? [];
  let ids = mergeHits(
    await Promise.all(parsed.texts.map((t) => soeg(t, signal, prefer))),
    MAX_RESULTS,
  );
  if (ids.length === 0 && parsed.scoped && parsed.texts.length > 0) {
    ids = mergeHits([await soeg(q, signal)], MAX_RESULTS);
  }
  return lookup(ids, signal);
}

/** Towns and postal districts for what is typed (the app's own list; no
 * request to the address service). Empty while the list cannot be had. */
export async function searchTowns(query: string): Promise<PlaceSuggestion[]> {
  const index = await loadPlaceIndex().catch(() => null);
  return index ? matchPlaces(index, query) : [];
}
