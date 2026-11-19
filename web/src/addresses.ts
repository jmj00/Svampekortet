// Adressevælgeren -- Klimadatastyrelsens replacement for DAWA, which shuts
// down permanently 2026-10-01 (docs/data-sources.md). Two calls where DAWA's
// autocomplete needed one: a phonetic search returns candidate ids with no
// coordinates, so each candidate needs a follow-up lookup by id. Both use the
// same VITE_DATAFORDELER_API_KEY as the basemap (web/src/map.ts) -- a plain
// API-Key, safe to ship in client code (unlike an OAuth Shared Secret), scoped
// to Datafordeler's public/unprotected data.
//
// Lookup responses carry coordinates in EPSG:25832 (UTM zone 32N) -- all of
// Denmark falls in one UTM zone, so utm32nToWgs84 below hard-codes it rather
// than handling zones generally. Converted here since the rest of this
// codebase works in WGS84 [lon, lat] (matches GeoJSON convention).

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
}

interface SearchResponse {
  status: string;
  fund: SearchHit[];
}

interface LookupResponse {
  status: string;
  husnummer: {
    husnummertekst: string;
    adgangsadressebetegnelse: string;
    vejnavn: string;
    postnummer: { navn: string; postnr: string };
    adgangspunkt: { koordinater: { x: number; y: number } };
  };
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

async function lookup(id: string, signal?: AbortSignal): Promise<AddressSuggestion | null> {
  const res = await fetch(`${LOOKUP_ENDPOINT}/${id}?token=${TOKEN}`, { signal });
  if (!res.ok) return null;
  const detail = (await res.json()) as LookupResponse;
  const { x, y } = detail.husnummer.adgangspunkt.koordinater;
  const [lon, lat] = utm32nToWgs84(x, y);
  return {
    tekst: detail.husnummer.adgangsadressebetegnelse,
    adgangsadresse: {
      id,
      vejnavn: detail.husnummer.vejnavn,
      husnr: detail.husnummer.husnummertekst,
      postnr: detail.husnummer.postnummer.postnr,
      postnrnavn: detail.husnummer.postnummer.navn,
      x: lon,
      y: lat,
    },
  };
}

export async function searchAddresses(
  query: string,
  signal?: AbortSignal,
): Promise<AddressSuggestion[]> {
  const q = query.trim();
  if (q.length < 3 || !TOKEN) return [];

  const res = await fetch(`${SEARCH_ENDPOINT}?tekst=${encodeURIComponent(q)}&token=${TOKEN}`, {
    signal,
  });
  if (!res.ok) throw new Error(`Adressevælgeren responded ${res.status}`);
  const data = (await res.json()) as SearchResponse;

  const ids = data.fund
    .filter((hit) => hit.type === "husnummer")
    .slice(0, MAX_RESULTS)
    .map((hit) => hit.id);
  const found = await Promise.all(ids.map((id) => lookup(id, signal)));
  return found.filter((item): item is AddressSuggestion => item !== null);
}
