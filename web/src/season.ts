// "Is it in season now?" for the species list, read off the same per-month find
// counts the detail view charts (SpeciesDoc.season_by_month). Purely
// descriptive: a month counts as in season when it holds a fair share of the
// finds of the species' best month. No model involved.

export type SeasonState = "peak" | "in" | "out" | "unknown";

export interface SeasonInfo {
  state: SeasonState;
  /** This month's finds as a share of the best month's, 0..1. */
  share: number;
  /** First and last month (0-11) of the run of in-season months around the
   * best month; it may wrap past December. Null when unknown. */
  from: number | null;
  to: number | null;
  /** Each month's finds as a share of the best month's, 0..1 (12 entries). */
  shares: number[];
}

/** Below this many dated finds the monthly shape is noise, not a season. */
export const MIN_FINDS_FOR_SEASON = 20;
const IN_SEASON_SHARE = 0.25;
const PEAK_SHARE = 0.7;

const MONTH_SHORT = [
  "jan",
  "feb",
  "mar",
  "apr",
  "maj",
  "jun",
  "jul",
  "aug",
  "sep",
  "okt",
  "nov",
  "dec",
];

const UNKNOWN: SeasonInfo = {
  state: "unknown",
  share: 0,
  from: null,
  to: null,
  shares: new Array<number>(12).fill(0),
};

/** `month` is 0-11 (Date.getMonth()). */
export function seasonInfo(byMonth: readonly number[], month: number): SeasonInfo {
  if (byMonth.length !== 12) return UNKNOWN;
  const total = byMonth.reduce((sum, n) => sum + n, 0);
  const max = Math.max(...byMonth);
  if (total < MIN_FINDS_FOR_SEASON || max <= 0) return UNKNOWN;

  const shares = byMonth.map((n) => n / max);
  const inSeason = (m: number) => shares[((m % 12) + 12) % 12] >= IN_SEASON_SHARE;

  const best = shares.indexOf(1);
  let from = best;
  let to = best;
  for (let i = 0; i < 11 && inSeason(from - 1); i++) from--;
  for (let i = 0; i < 11 - (best - from) && inSeason(to + 1); i++) to++;

  const share = shares[month] ?? 0;
  const state: SeasonState = share >= PEAK_SHARE ? "peak" : share >= IN_SEASON_SHARE ? "in" : "out";
  return { state, share, from: ((from % 12) + 12) % 12, to: to % 12, shares };
}

/** Short Danish text for a list row; empty when the season is unknown. */
export function seasonLabel(info: SeasonInfo): string {
  if (info.state === "peak") return "Højsæson nu";
  if (info.state === "in") return "I sæson nu";
  if (info.state === "unknown" || info.from === null || info.to === null) return "";
  return info.from === info.to
    ? `Sæson i ${MONTH_SHORT[info.from]}`
    : `Sæson ${MONTH_SHORT[info.from]}–${MONTH_SHORT[info.to]}`;
}

/** Sort key: best season first, unknown last. */
export function seasonRank(info: SeasonInfo | undefined): number {
  if (!info || info.state === "unknown") return -1;
  const base = info.state === "peak" ? 2 : info.state === "in" ? 1 : 0;
  return base + info.share; // share < 1.01, so states never overlap by more than a tie
}
