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

const WEEKDAYS = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];

/** The line above "Hvad kan jeg finde her i dag?": which day that is, as a
 * forecast names it ("Fredag 27. november"). */
export function dateEyebrow(date: Date): string {
  const day = WEEKDAYS[date.getDay()];
  return `${day.charAt(0).toUpperCase()}${day.slice(1)} ${date.getDate()}. ${monthName(date.getMonth())}`;
}

// --- the pin on the home view ----------------------------------------------

/** How the home view names the pin under a card: "Ved Vesterskov". The
 * location chip's own names do not all read well after "ved". */
export function pinSubline(label: string): string {
  const name = label.trim();
  // "Ved Vesterskov", "I Mølleskov i Rold Skov": already a place phrase
  if (/^(ved|i)\s/i.test(name)) return name.charAt(0).toUpperCase() + name.slice(1);
  if (name === MY_LOCATION_LABEL) return "Ved din placering";
  if (name === RESTORED_LOCATION_LABEL) return "Ved din seneste placering";
  if (name === "" || name === "Nål på kortet") return "Ved nålen på kortet";
  return `Ved ${name}`;
}

// --- today at the pin ------------------------------------------------------

/** From this score on a species has "gode" conditions (scoreBand, score.ts). */
export const GOOD_SCORE = 60;

export interface ScoredName {
  name: string;
  /** 0-100 */
  value: number;
  /** For opening the species from the sentence that names it. */
  slug?: string;
}

export interface TodayAtPin {
  /** How many species have good conditions. */
  good: number;
  /** The best-scoring species, rounded as the list shows it. */
  best: ScoredName | null;
}

/** Sum up a finished ranking at the pin. A ranking that scored nothing (the
 * species files could not be fetched, offline) is "unavailable": there will
 * be nothing to wait for. */
export function todayAtPin(scored: readonly ScoredName[]): TodayAtPin | "unavailable" {
  if (scored.length === 0) return "unavailable";
  let best: ScoredName | null = null;
  let good = 0;
  for (const { name, value, slug } of scored) {
    const rounded = Math.round(value);
    if (rounded >= GOOD_SCORE) good++;
    if (!best || rounded > best.value)
      best = slug === undefined ? { name, value: rounded } : { name, value: rounded, slug };
  }
  return { good, best };
}

/** What the return card says while there is no summary, and when there will
 * be none. */
export const TODAY_LOADING = "vurderer forholdene …";
export const TODAY_UNAVAILABLE = "Dagens forhold kunne ikke beregnes lige nu.";

const arter = (n: number): string => (n === 1 ? "1 art" : `${n} arter`);

/** Short, under the pin's name on the start screen: "3 arter med gode
 * forhold i dag". */
export function todayShort(today: TodayAtPin): string {
  return today.good === 0
    ? "Ingen arter med gode forhold i dag"
    : `${arter(today.good)} med gode forhold i dag`;
}

/** The sentence of the return card, after "I dag ved din nål:", in three
 * parts so the best species' name can be a link: `before` + name + `after`.
 * Without a best species the whole sentence is in `before`. */
export function todayParts(today: TodayAtPin): {
  before: string;
  best: ScoredName | null;
  after: string;
} {
  const best = today.best;
  if (!best) return { before: `${todayShort(today)}.`, best: null, after: "" };
  if (today.good === 0)
    return { before: "Ingen arter har gode forhold. Bedst er ", best, after: ` (${best.value}).` };
  if (today.good === 1) return { before: "", best, after: ` har gode forhold (${best.value}).` };
  return {
    before: `${arter(today.good)} har gode forhold – bedst er `,
    best,
    after: ` (${best.value}).`,
  };
}

/** The same sentence as plain text. */
export function todayLong(today: TodayAtPin): string {
  const { before, best, after } = todayParts(today);
  return `${before}${best?.name ?? ""}${after}`;
}

// --- the season strip on the home view ---------------------------------------

/** At most this many species in the strip (the last tile leads to them all). */
export const STRIP_MAX = 8;

/** The species for the strip: those in season now, or, in a month with none,
 * the ones nearest to theirs (`inSeason` false: the strip says so). */
export function stripSpecies(order: PickerOrder): {
  inSeason: boolean;
  items: PickerSpecies[];
} {
  const inSeason = order.inSeason.length > 0;
  const pool = inSeason ? order.inSeason : order.others;
  return { inSeason, items: varied(pool).slice(0, STRIP_MAX) };
}

/** The kind a Danish name names: its last word ("Violet Hekseringshat" is a
 * hekseringshat). */
const kindOf = (name: string): string =>
  (
    name
      .trim()
      .split(/[\s-]+/)
      .pop() ?? ""
  ).toLocaleLowerCase("da");

/** Keep the order, but let each kind lead once before its relatives follow:
 * three hekseringshatte in a row look like one photo three times. */
export function varied(items: readonly PickerSpecies[]): PickerSpecies[] {
  const seen = new Set<string>();
  const first: PickerSpecies[] = [];
  const later: PickerSpecies[] = [];
  for (const item of items) {
    const kind = kindOf(item.species.danish_name);
    (seen.has(kind) ? later : first).push(item);
    seen.add(kind);
  }
  return [...first, ...later];
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
/** How far from a named town a forest of the typed name may be (km). */
export const NEAR_TOWN_KM = 20;

function forestsNear<T extends NamedPlace>(
  forests: readonly T[],
  wanted: string,
  [lon, lat]: [number, number],
  limit: number,
): T[] {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const found: { forest: T; km: number; rank: number }[] = [];
  for (const forest of forests) {
    const key = placeKey(forest.name);
    const at = key.indexOf(wanted);
    if (at < 0) continue;
    const km = Math.hypot((forest.lon - lon) * kx, (forest.lat - lat) * 110.57);
    // the name itself first ("Vesterskov"), then names it begins, then the rest
    const rank = key === wanted ? 0 : at === 0 ? 1 : 2;
    if (km <= NEAR_TOWN_KM) found.push({ forest, km, rank });
  }
  return found
    .sort((a, b) => a.rank - b.rank || a.km - b.km)
    .slice(0, limit)
    .map((f) => f.forest);
}

export function matchForests<T extends NamedPlace>(
  forests: readonly T[],
  query: string,
  limit = 4,
  /** A town the forest should be near ("Vesterskov Silkeborg"): then every
   * forest of the name within NEAR_TOWN_KM counts, the name itself first,
   * then the nearest. */
  near?: [number, number],
): T[] {
  const wanted = placeKey(query);
  if (wanted.length < 2) return [];
  if (near) return forestsNear(forests, wanted, near, limit);
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
