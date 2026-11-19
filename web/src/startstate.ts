// The start screen's pure logic (start.ts draws it): whether to show it, the
// pin remembered on the device, which species the picker leads with, and the
// few sentences that are built from the manifest. No DOM in here.

import { seasonInfo, seasonRank, type SeasonInfo } from "./season";
import type { SpeciesSummary } from "./types";

// --- the remembered pin ---------------------------------------------------

/** The only thing the start screen stores: where the pin last stood. */
export const PIN_STORAGE_KEY = "svampekortet.pin";

/** The name the geolocation gives a pin (main.ts). Restored later it is no
 * longer where the user is, so it comes back under another name. */
export const MY_LOCATION_LABEL = "Min placering";
export const RESTORED_LOCATION_LABEL = "Seneste placering";

export interface StoredPin {
  lngLat: [number, number];
  /** The pin's name (an address, a forest), or null for a bare map position. */
  label: string | null;
}

// Generous box around Denmark incl. Bornholm: anything outside is not a pin
// this app could have written.
const LON_RANGE = [3, 17] as const;
const LAT_RANGE = [53, 59] as const;
const MAX_LABEL_LENGTH = 160;

const round5 = (value: number): number => Math.round(value * 1e5) / 1e5;

/** Five decimals is about a metre: all the pin needs, nothing more. */
export function serializePin(lngLat: [number, number], label: string | null): string {
  return JSON.stringify({ lon: round5(lngLat[0]), lat: round5(lngLat[1]), label: label ?? null });
}

/** Read back what serializePin wrote; null for anything else. */
export function parseStoredPin(raw: string | null | undefined): StoredPin | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { lon, lat, label } = value as Record<string, unknown>;
  if (typeof lon !== "number" || typeof lat !== "number") return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < LON_RANGE[0] || lon > LON_RANGE[1] || lat < LAT_RANGE[0] || lat > LAT_RANGE[1]) {
    return null;
  }
  const name = typeof label === "string" && label.trim() !== "" ? label : null;
  return { lngLat: [lon, lat], label: name ? name.slice(0, MAX_LABEL_LENGTH) : null };
}

/** The label a restored pin is shown under. */
export function restoredLabel(label: string | null): string | undefined {
  if (label === null) return undefined;
  return label === MY_LOCATION_LABEL ? RESTORED_LOCATION_LABEL : label;
}

type PinStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage, or null where it is unavailable (private mode, blocked). */
function deviceStorage(): PinStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredPin(storage: PinStorage | null = deviceStorage()): StoredPin | null {
  try {
    return parseStoredPin(storage?.getItem(PIN_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Remember the pin, or forget it (`null`). Failing to is never an error. */
export function writeStoredPin(
  pin: StoredPin | null,
  storage: PinStorage | null = deviceStorage(),
): void {
  try {
    if (pin) storage?.setItem(PIN_STORAGE_KEY, serializePin(pin.lngLat, pin.label));
    else storage?.removeItem(PIN_STORAGE_KEY);
  } catch {
    // full or blocked storage: the app works the same without it
  }
}

// --- show it or not -------------------------------------------------------

/** `?kort` in the address skips the start screen for that visit (for links
 * straight to the map, and for automated checks that start from a fresh
 * profile). The same test is inlined in index.html so the first paint is
 * already right; keep the two in step. */
export function hasSkipParam(search: string): boolean {
  return /[?&]kort(?:[=&]|$)/.test(search);
}

/** Fresh visit: the start screen. A pin from last time: straight to the map. */
export function shouldShowStart(search: string, storedPin: StoredPin | null): boolean {
  return !hasSkipParam(search) && storedPin === null;
}

// --- species for the picker -----------------------------------------------

export interface PickerSpecies {
  species: SpeciesSummary;
  season: SeasonInfo;
}

export interface PickerOrder {
  /** In season this month, the strongest first. */
  inSeason: PickerSpecies[];
  /** Everything else: nearest to its season first, then the most-found. */
  others: PickerSpecies[];
}

const isInSeason = (info: SeasonInfo): boolean => info.state === "in" || info.state === "peak";

/** `month` is 0-11. The order is stable for equal species (manifest order). */
export function pickerOrder(species: readonly SpeciesSummary[], month: number): PickerOrder {
  const all = species.map((s): PickerSpecies => ({
    species: s,
    season: seasonInfo(s.season_by_month ?? [], month),
  }));
  const byRank = (a: PickerSpecies, b: PickerSpecies): number =>
    seasonRank(b.season) - seasonRank(a.season) ||
    b.species.observation_count - a.species.observation_count;
  return {
    inSeason: all.filter((p) => isInSeason(p.season)).sort(byRank),
    others: all.filter((p) => !isInSeason(p.season)).sort(byRank),
  };
}

/** Up to this many in-season species are shown as wide cards, not tiles: one
 * lone tile in a grid reads as a gap, one card reads as a recommendation. */
export const MAX_FEATURED = 2;

/**
 * How many of the out-of-season species the picker shows before "show all".
 * The in-season ones are always all shown. With few of them, the rest fill the
 * first screen (`target` tiles); with many, the rest wait behind the button.
 * The result is always whole rows of `columns`, or everything.
 */
export function initialOthers(
  inSeasonCount: number,
  othersCount: number,
  columns = 3,
  target = 9,
): number {
  if (othersCount <= columns) return othersCount; // not worth a button
  const tilesInSeason = inSeasonCount > MAX_FEATURED ? inSeasonCount : 0;
  if (tilesInSeason >= target) return 0;
  const wanted = Math.ceil((target - tilesInSeason) / columns) * columns;
  return wanted >= othersCount ? othersCount : wanted;
}

// --- sentences built from the manifest -------------------------------------

const MONTHS = [
  "januar",
  "februar",
  "marts",
  "april",
  "maj",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "december",
];

export const monthName = (month: number): string => MONTHS[((month % 12) + 12) % 12];

/** The line above the headline: "November · 3 arter i sæson". */
export function seasonEyebrow(month: number, inSeasonCount: number): string {
  const name = monthName(month);
  const capitalised = name.charAt(0).toUpperCase() + name.slice(1);
  if (inSeasonCount === 0) return capitalised;
  return `${capitalised} · ${inSeasonCount} ${inSeasonCount === 1 ? "art" : "arter"} i sæson`;
}

/** The second line of the "Hvad er i sæson?" card. */
export function seasonLine(inSeasonNames: readonly string[], month: number): string {
  const [first, second] = inSeasonNames;
  switch (inSeasonNames.length) {
    case 0:
      return "Se, hvornår på året hver art har sæson.";
    case 1:
      return `${first} er i sæson nu.`;
    case 2:
      return `${first} og ${second} er i sæson nu.`;
    default:
      return `${inSeasonNames.length} arter er i sæson her i ${monthName(month)}.`;
  }
}

// --- the pin on the home view ----------------------------------------------

/** How the home view names the pin under a card: "Ved Vesterskov". The
 * location chip's own names do not all read well after "ved". */
export function pinSubline(label: string): string {
  const name = label.trim();
  if (/^ved\s/i.test(name)) return name;
  if (name === MY_LOCATION_LABEL) return "Ved din placering";
  if (name === RESTORED_LOCATION_LABEL) return "Ved din seneste placering";
  if (name === "" || name === "Nål på kortet") return "Ved nålen på kortet";
  return `Ved ${name}`;
}

// --- named forests for the place search --------------------------------------

export interface NamedPlace {
  name: string;
  lon: number;
  lat: number;
  area_m2: number | null;
}

/** "Grib Skov", "grib-skov" and "Gribskov" are the same search. */
const placeKey = (text: string): string => text.toLocaleLowerCase("da").replace(/[\s\-.,]+/g, "");

/**
 * Named forests matching what was typed: names that start with it first, then
 * names with a word that starts with it, then names that merely contain it;
 * larger forests before smaller. Several forests share a name (there are many
 * called Nørreskov) and the payload has nothing to tell them apart by, so only
 * the largest of each name is offered.
 */
export function matchForests<T extends NamedPlace>(
  forests: readonly T[],
  query: string,
  limit = 4,
): T[] {
  const wanted = placeKey(query);
  if (wanted.length < 2) return [];
  const firstWord = query.trim().toLocaleLowerCase("da");
  const best = new Map<string, { forest: T; rank: number }>();
  for (const forest of forests) {
    const key = placeKey(forest.name);
    const at = key.indexOf(wanted);
    if (at < 0) continue;
    const words = forest.name.toLocaleLowerCase("da").split(/[\s-]+/);
    const rank = at === 0 ? 0 : words.some((w) => w.startsWith(firstWord)) ? 1 : 2;
    const seen = best.get(key);
    if (!seen || (forest.area_m2 ?? 0) > (seen.forest.area_m2 ?? 0))
      best.set(key, { forest, rank });
  }
  return [...best.values()]
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (b.forest.area_m2 ?? 0) - (a.forest.area_m2 ?? 0) ||
        a.forest.name.localeCompare(b.forest.name, "da"),
    )
    .slice(0, limit)
    .map((entry) => entry.forest);
}
