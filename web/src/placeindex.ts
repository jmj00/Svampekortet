// Towns and postal districts for the place search. Adressevælgeren (the
// address service, addresses.ts) knows streets and house numbers only: a town
// name typed alone finds nothing, and a town after an address ("Vestergade 10
// Silkeborg") does not narrow the search -- the answer comes sorted by postal
// number, so København K first. What it does honour is a postal number after
// the address ("Vestergade 10, 8600"). So the app carries its own small list
// of towns (Danske Stednavne) and postal districts (DAGI), built by
// web/scripts/gen-places.mjs, and uses it two ways:
//
//   - a typed town or postal number is a suggestion of its own: the map flies
//     there (matchPlaces);
//   - a town or postal number after an address is turned into the postal
//     number the service understands (parseAddressQuery).
//
// Everything here is pure except loadPlaceIndex, which fetches the list (about
// 140 kB gzipped) the first time a place search needs it.

import placesUrl from "./data/places.json?url";

export interface Town {
  name: string;
  lon: number;
  lat: number;
  /** Radius of a circle of the town's area (km). */
  radiusKm: number;
  /** The postal district the town's point lies in (index), or -1. */
  postal: number;
  /** 0 a town or village, 1 part of a town, 2 a holiday-home area. */
  type: 0 | 1 | 2;
}

export interface PostalDistrict {
  postnr: string;
  name: string;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
}

export interface PlaceIndex {
  towns: Town[];
  postal: PostalDistrict[];
  byPostnr: Map<string, PostalDistrict>;
  /** Normalised name -> towns of that name, the largest first. */
  townsByName: Map<string, Town[]>;
  /** Normalised name -> postal districts of that name ("aarhus c"). */
  postalByName: Map<string, PostalDistrict[]>;
  /** Every normalised town and district name, sorted, for prefix search. */
  names: string[];
}

export interface RawPlaces {
  postal: [string, string, number, number, number, number][];
  towns: [string, number, number, number, number, number][];
}

/** "Århus", "aarhus" and "AARHUS" are one search; so are "Sankt" and "Skt."
 * spelled either way with dots and dashes. */
export function normalizeName(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/aa/g, "å")
    .replace(/[.\-–]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildPlaceIndex(raw: RawPlaces): PlaceIndex {
  const postal: PostalDistrict[] = raw.postal.map(([postnr, name, w, s, e, n]) => ({
    postnr,
    name,
    bbox: [w, s, e, n],
  }));
  const towns: Town[] = raw.towns.map(([name, lon, lat, radiusKm, district, type]) => ({
    name,
    lon,
    lat,
    radiusKm,
    postal: district,
    type: (type === 1 || type === 2 ? type : 0) as Town["type"],
  }));
  const byPostnr = new Map(postal.map((p) => [p.postnr, p]));
  const townsByName = new Map<string, Town[]>();
  for (const town of towns) {
    const key = normalizeName(town.name);
    const list = townsByName.get(key) ?? [];
    list.push(town);
    townsByName.set(key, list);
  }
  for (const list of townsByName.values()) {
    list.sort((a, b) => a.type - b.type || b.radiusKm - a.radiusKm);
  }
  const postalByName = new Map<string, PostalDistrict[]>();
  for (const district of postal) {
    const key = normalizeName(district.name);
    const list = postalByName.get(key) ?? [];
    list.push(district);
    postalByName.set(key, list);
  }
  const names = [...new Set([...townsByName.keys(), ...postalByName.keys()])].sort();
  return { towns, postal, byPostnr, townsByName, postalByName, names };
}

/** Whether `a` and `b` are at most one typing slip apart (a letter missing,
 * extra, wrong, or two swapped). */
export function oneSlipApart(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const restA = a.slice(i);
  const restB = b.slice(i);
  if (restA.slice(1) === restB.slice(1)) return true; // replaced
  if (restA.slice(1) === restB || restA === restB.slice(1)) return true; // dropped or added
  return (
    restA.length >= 2 &&
    restA[0] === restB[1] &&
    restA[1] === restB[0] &&
    restA.slice(2) === restB.slice(2)
  );
}

/** The names in the index at most one slip from `key` (keys of 5 letters or
 * more: shorter ones match too much by accident). */
function nearNames(index: PlaceIndex, key: string): string[] {
  if (key.length < 5) return [];
  return index.names.filter(
    (name) => Math.abs(name.length - key.length) <= 1 && oneSlipApart(name, key),
  );
}

/** The postal districts a typed name means: its own name ("Silkeborg"), the
 * parts of a city ("Aarhus" -> Aarhus C, N, V), or one slip away. */
export function postalFor(index: PlaceIndex, name: string): PostalDistrict[] {
  const key = normalizeName(name);
  if (!key) return [];
  const exact = index.postalByName.get(key);
  if (exact) return exact;
  const parts = index.postal.filter((p) => {
    const n = normalizeName(p.name);
    return n.startsWith(`${key} `) && n.length - key.length <= 2; // "aarhus c", "odense sø"
  });
  if (parts.length) return parts;
  return nearNames(index, key).flatMap((n) => index.postalByName.get(n) ?? []);
}

/** The towns a typed name means: exactly that name, or one slip away. */
export function townsFor(index: PlaceIndex, name: string): Town[] {
  const key = normalizeName(name);
  if (!key) return [];
  const exact = index.townsByName.get(key);
  if (exact) return exact;
  return nearNames(index, key).flatMap((n) => index.townsByName.get(n) ?? []);
}

export interface AddressQuery {
  /** What to send to the address service, one search each (at most ten). */
  texts: string[];
  /** True when a town or postal number was read out of the query. */
  scoped: boolean;
  /** Postal district names (normalised) whose addresses go first: for a
   * city of many postal numbers (København K has one for every few
   * streets), where narrowing by number would miss most of it. */
  prefer?: string[];
}

const MAX_SCOPES = 10;

/**
 * What to ask the address service for. A postal number anywhere after the
 * street ("Vestergade 10 8600", "Vestergade 10, 8600 Silkeborg") or a town at
 * the end ("Vestergade 10 Silkeborg", "Hovedvejen 3, Rold") becomes the form
 * the service filters on: "Vestergade 10, 8600". A town that is a postal
 * district's name is taken at its word; any other town only after a comma or
 * a house number, so that a street such as "Rold Skovvej" or a forest name is
 * not cut in two. Without either, the query goes as typed.
 */
export function parseAddressQuery(index: PlaceIndex, query: string): AddressQuery {
  const typed = query.trim().replace(/\s+/g, " ");
  // tokens, with where the commas were
  const parts = typed.split(",");
  const tokens: string[] = [];
  const commaBefore = new Set<number>();
  parts.forEach((part, i) => {
    if (i > 0) commaBefore.add(tokens.length);
    tokens.push(...part.trim().split(" ").filter(Boolean));
  });
  const n = tokens.length;
  const plain: AddressQuery = { texts: typed ? [typed] : [], scoped: false };

  // a postal number after the street
  for (let i = n - 1; i >= 0; i--) {
    if (!/^\d{4}$/.test(tokens[i]) || !index.byPostnr.has(tokens[i])) continue;
    if (i === 0) return { texts: [], scoped: true }; // just a number: a district, not an address
    return { texts: [`${tokens.slice(0, i).join(" ")}, ${tokens[i]}`], scoped: true };
  }

  // a town at the end: the longest that is one, up to three words
  for (let k = Math.min(3, n - 1); k >= 1; k--) {
    const rest = tokens.slice(0, n - k);
    const name = tokens.slice(n - k).join(" ");
    const evidence = commaBefore.has(n - k) || rest.some((t) => /\d/.test(t));
    let postnrs = postalFor(index, name).map((p) => p.postnr);
    if (postnrs.length === 0 && evidence) {
      postnrs = townsFor(index, name)
        .map((town) => index.postal[town.postal]?.postnr)
        .filter((p): p is string => Boolean(p));
    }
    const unique = [...new Set(postnrs)];
    if (unique.length === 0) continue;
    const street = rest.join(" ");
    if (unique.length > MAX_SCOPES) {
      const names = unique.map((p) => normalizeName(index.byPostnr.get(p)?.name ?? ""));
      return { texts: [street], scoped: true, prefer: [...new Set(names)].filter(Boolean) };
    }
    return { texts: unique.map((p) => `${street}, ${p}`), scoped: true };
  }
  return plain;
}

/** A town or postal district the search offers, and how close to fly. */
export interface PlaceSuggestion {
  /** What the list shows: "Rold · 9510 Arden", "8600 Silkeborg". */
  text: string;
  /** The pin's name once chosen: "Rold", "8600 Silkeborg". */
  label: string;
  target: [number, number];
  zoom: number;
}

/** How close to fly to a town of this size: its surroundings in view. */
export function townZoom(radiusKm: number): number {
  if (radiusKm < 0.4) return 14;
  if (radiusKm < 0.8) return 13.5;
  if (radiusKm < 1.5) return 13;
  if (radiusKm < 3) return 12;
  return 11.5;
}

/** How close to fly for a postal district: the whole district in view. */
export function districtZoom([w, s, e, n]: [number, number, number, number]): number {
  const lat = ((s + n) / 2) * (Math.PI / 180);
  const spanKm = Math.max((e - w) * 111.32 * Math.cos(lat), (n - s) * 110.57, 1);
  // about 320 px of map across the district on a phone
  const zoom = Math.log2((40075 * Math.cos(lat) * 320) / (256 * spanKm));
  return Math.round(Math.min(13, Math.max(8.5, zoom)) * 2) / 2;
}

function townSuggestion(index: PlaceIndex, town: Town): PlaceSuggestion {
  const district = index.postal[town.postal];
  let text = town.name;
  // A city is known by its name: its middle may lie in any of its districts
  // (Aarhus's in 8230 Åbyhøj), so no district is named for it.
  const city = town.type === 0 && (town.radiusKm >= 2 || hasDistricts(index, town.name));
  if (district && !city) {
    text =
      normalizeName(district.name) === normalizeName(town.name)
        ? `${town.name} · ${district.postnr}`
        : `${town.name} · ${district.postnr} ${district.name}`;
  }
  if (town.type === 2) text += " (sommerhusområde)";
  return { text, label: town.name, target: [town.lon, town.lat], zoom: townZoom(town.radiusKm) };
}

/** Whether the town's name is that of postal districts ("Aarhus C"). */
function hasDistricts(index: PlaceIndex, name: string): boolean {
  const key = normalizeName(name);
  return index.postal.some((p) => {
    const n = normalizeName(p.name);
    return n === key || n.startsWith(`${key} `);
  });
}

function districtSuggestion(district: PostalDistrict): PlaceSuggestion {
  const [w, s, e, n] = district.bbox;
  const label = `${district.postnr} ${district.name}`;
  return {
    text: label,
    label,
    target: [(w + e) / 2, (s + n) / 2],
    zoom: districtZoom(district.bbox),
  };
}

/**
 * Towns and postal districts for what is typed: a postal number (alone, or
 * with its name) gives its district; a name gives the towns it is or begins
 * (an exact name first, towns before parts of towns and holiday-home areas,
 * larger first), and a postal district of that name when no town has it. A
 * name one slip off counts when nothing else matches. Nothing under three
 * letters: that is where most names begin.
 */
export function matchPlaces(index: PlaceIndex, query: string, limit = 3): PlaceSuggestion[] {
  const typed = query.trim();
  const number = /^(\d{4})(?:\s*,?\s+(.*))?$/.exec(typed);
  if (number) {
    const district = index.byPostnr.get(number[1]);
    return district ? [districtSuggestion(district)] : [];
  }
  const key = normalizeName(typed);
  if (key.length < 3 || /\d/.test(key)) return [];

  // names that are, or begin with, what is typed (binary search for the start)
  let lo = 0;
  let hi = index.names.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index.names[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  let keys: string[] = [];
  for (let i = lo; i < index.names.length && index.names[i].startsWith(key); i++)
    keys.push(index.names[i]);
  if (keys.length === 0) keys = nearNames(index, key);

  const candidates: { s: PlaceSuggestion; rank: number[] }[] = [];
  for (const name of keys) {
    const exact = name === key || keys.length === 1 ? 0 : 1;
    const towns = index.townsByName.get(name) ?? [];
    const shown = towns.slice(0, 2); // two of a name at most: the largest
    for (const town of shown) {
      candidates.push({
        s: townSuggestion(index, town),
        rank: [exact, town.type, -town.radiusKm],
      });
    }
    if (towns.length === 0) {
      for (const district of index.postalByName.get(name) ?? []) {
        candidates.push({ s: districtSuggestion(district), rank: [exact, 0.5, 0] });
      }
    }
  }
  const townKeys = candidates.filter((c) => c.rank[1] !== 0.5).map((c) => normalizeName(c.s.label));
  const kept = candidates.filter(
    (c) =>
      c.rank[1] !== 0.5 ||
      !townKeys.some((t) => normalizeName(c.s.label.replace(/^\d{4} /, "")).startsWith(t)),
  );
  kept.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);
  return kept.slice(0, limit).map((c) => c.s);
}

/** A town at the end of what is typed ("Vesterskov Silkeborg"): the words
 * before it, and where the town is. The town must be one by its exact name
 * (or a postal district's), and something must come before it. */
export function splitTown(
  index: PlaceIndex,
  query: string,
): { rest: string; at: [number, number]; town: string } | null {
  const tokens = query
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  for (let k = Math.min(3, tokens.length - 1); k >= 1; k--) {
    const name = tokens.slice(tokens.length - k).join(" ");
    const key = normalizeName(name);
    const town = index.townsByName.get(key)?.[0];
    const district = index.postalByName.get(key)?.[0];
    let at: [number, number] | null = null;
    if (town) at = [town.lon, town.lat];
    else if (district) {
      const [w, s, e, n] = district.bbox;
      at = [(w + e) / 2, (s + n) / 2];
    }
    if (at) {
      const proper = town?.name ?? district?.name ?? name;
      return { rest: tokens.slice(0, tokens.length - k).join(" "), at, town: proper };
    }
  }
  return null;
}

let loaded: PlaceIndex | null = null;
let loading: Promise<PlaceIndex> | null = null;

/** The list if it has arrived (for a search that cannot wait for it). */
export function loadedPlaceIndex(): PlaceIndex | null {
  return loaded;
}

/** The list, fetched once (an asset of the app's own build, cached offline by
 * the service worker like the rest of it). A failed fetch is tried again on
 * the next search. */
export function loadPlaceIndex(): Promise<PlaceIndex> {
  if (!loading) {
    loading = fetch(placesUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`places.json: HTTP ${res.status}`);
        return res.json() as Promise<RawPlaces>;
      })
      .then((raw) => {
        loaded = buildPlaceIndex(raw);
        return loaded;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}
