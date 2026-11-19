// Pure helpers behind the species detail view (detail.ts): wording and small
// derivations from the published payload and the conditions score. No DOM here,
// so it is unit-tested directly.

import { type Conditions, scoreBand } from "./score";

export const MONTH_NAMES = [
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
] as const;

export const MONTH_SHORT = [
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
] as const;

/** A month counts as "in season" from this share of the peak month's finds. */
const IN_SEASON_SHARE = 0.15;
/** ...and as high season from this share. */
const HIGH_SEASON_SHARE = 0.5;

export type SeasonStatus = "peak" | "in" | "out";

export interface SeasonSummary {
  total: number;
  /** 0-based month with the most finds. */
  peakMonth: number;
  /** First and last month (0-based, may wrap the new year) of the unbroken run
   * of in-season months around the peak. */
  from: number;
  to: number;
  /** Per month: is it part of that run? */
  inSeason: boolean[];
  /** Per month: share of all finds, 0..1. */
  share: number[];
  status: SeasonStatus;
}

/** Summarise the finds-per-month histogram, or null when there are no dated finds. */
export function seasonSummary(byMonth: readonly number[], month: number): SeasonSummary | null {
  const total = byMonth.reduce((sum, n) => sum + n, 0);
  if (byMonth.length !== 12 || total <= 0) return null;
  const max = Math.max(...byMonth);
  const peakMonth = byMonth.indexOf(max);
  const qualifies = (m: number) => byMonth[(m + 12) % 12] >= max * IN_SEASON_SHARE;

  let from = peakMonth;
  let to = peakMonth;
  // walk outwards from the peak; stop before going all the way round
  while (to - from < 11 && qualifies(from - 1)) from--;
  while (to - from < 11 && qualifies(to + 1)) to++;
  const inSeason = byMonth.map(() => false);
  for (let k = from; k <= to; k++) inSeason[(k + 120) % 12] = true;

  const now = byMonth[month] ?? 0;
  const status: SeasonStatus =
    inSeason[month] && now >= max * HIGH_SEASON_SHARE ? "peak" : inSeason[month] ? "in" : "out";
  return {
    total,
    peakMonth,
    from: (from + 120) % 12,
    to: (to + 120) % 12,
    inSeason,
    share: byMonth.map((n) => n / total),
    status,
  };
}

export const SEASON_STATUS_TEXT: Record<SeasonStatus, string> = {
  peak: "Højsæson nu",
  in: "I sæson nu",
  out: "Uden for sæson nu",
};

/** "august–november", or just "oktober" for a one-month season. */
export function seasonRangeText(summary: SeasonSummary): string {
  if (summary.from === summary.to) return MONTH_NAMES[summary.from];
  if (summary.inSeason.every(Boolean)) return "hele året";
  return `${MONTH_NAMES[summary.from]}–${MONTH_NAMES[summary.to]}`;
}

// --- conditions score ---

/** Words for the 0–100 number. It is relative favourability, not a probability.
 * The 30 and 60 steps are the colour bands of `scoreBand`, so word and colour
 * always change together. */
export function qualitativeLabel(value: number): string {
  if (value >= 80) return "Meget gode forhold";
  if (value >= 60) return "Gode forhold";
  if (value >= 30) return "Middel forhold";
  if (value >= 15) return "Lave forhold";
  return "Meget lave forhold";
}

/** One factor's word. Deliberately the same three steps as `scoreBand`, which
 * colours its bar: under 30 low, under 60 middling, otherwise good. */
export function factorLevelText(fraction: number): string {
  const band = scoreBand(Math.round(fraction * 100));
  return band === "good" ? "God" : band === "ok" ? "Middel" : "Lav";
}

export type FactorKey = "habitat" | "season" | "weather" | "hostTree";

export interface Factor {
  key: FactorKey;
  label: string;
  /** What the factor measures, in a few words. */
  measures: string;
  /** 0..1, or null when the factor has no data here and is left out of the number. */
  fraction: number | null;
}

/** The factors that make up the number, in display order. Weather is always
 * listed (as missing when there is no data); host trees only when they count. */
export function scoreFactors(score: Conditions): Factor[] {
  const factors: Factor[] = [
    {
      key: "habitat",
      label: "Levested",
      measures: "Nærhed til tidligere fund",
      fraction: score.habitat,
    },
    {
      key: "season",
      label: "Sæson",
      measures: "Dagens dato i artens sæson",
      fraction: score.seasonality,
    },
    {
      key: "weather",
      label: "Vejr",
      measures: "Seneste nedbør og temperatur",
      fraction: score.weatherAvailable ? score.weather : null,
    },
  ];
  if (score.hostTreeAvailable) {
    factors.push({
      key: "hostTree",
      label: "Værtstræer",
      measures: "Artens værtstræer på stedet",
      fraction: score.hostTree,
    });
  }
  return factors;
}

/** The factor that holds the number down the most, or null when every factor
 * is already good. The number is a geometric mean, so the lowest factor is
 * always the one with the most to give. */
export function limitingFactor(factors: readonly Factor[]): Factor | null {
  let lowest: Factor | null = null;
  for (const factor of factors) {
    if (factor.fraction === null) continue;
    if (!lowest || factor.fraction < (lowest.fraction ?? 1)) lowest = factor;
  }
  return lowest && (lowest.fraction ?? 1) < 0.6 ? lowest : null;
}

/** How hard the lowest factor pulls: a low one holds the number down, a
 * middling one merely pulls the most. Follows the colour band of its bar. */
export function limitingVerb(factor: Factor): string {
  const low = scoreBand(Math.round((factor.fraction ?? 0) * 100)) === "low";
  return low ? "holder tallet nede" : "trækker mest ned";
}

/** One sentence on what would lift the number, for the factor holding it down. */
export function limitingAdvice(key: FactorKey, season: SeasonSummary | null): string {
  switch (key) {
    case "habitat":
      return "Der er få tidligere fund tæt på nålen. Tallet stiger, jo nærmere nålen står på fundene på kortet.";
    case "season":
      return season
        ? `Dagens dato ligger uden for artens bedste tid. Her er flest fund fra ${MONTH_NAMES[season.peakMonth]}.`
        : "Dagens dato ligger uden for artens bedste tid. Tallet stiger, når sæsonen nærmer sig.";
    case "weather":
      return "De seneste ugers nedbør og temperatur ligner ikke det vejr, arten plejer at frugte i.";
    case "hostTree":
      return "Artens værtstræer er sjældne lige her. Tallet er højere, hvor de er almindelige.";
  }
}

// --- facts ---

const REDLIST_TEXT: Record<string, string> = {
  LC: "Livskraftig",
  NT: "Næsten truet",
  VU: "Sårbar",
  EN: "Truet",
  CR: "Kritisk truet",
  RE: "Regionalt uddød",
  DD: "Utilstrækkelige data",
  NA: "Vurderes ikke",
  NE: "Ikke vurderet",
};

/** Danish red-list wording: `value` in words, `code` (the IUCN letters) when there is one. */
export function redlistFact(category: string | null): { value: string; code: string | null } {
  if (!category) return { value: "Ukendt", code: null };
  if (category.toLowerCase().startsWith("not")) return { value: "Ikke vurderet", code: null };
  const code = category.toUpperCase();
  return REDLIST_TEXT[code] ? { value: REDLIST_TEXT[code], code } : { value: category, code: null };
}

// --- description ---

export interface DescriptionSection {
  /** A short heading, or null when the paragraph's subject is not clear-cut. */
  heading: string | null;
  /** True when the paragraph is about lookalikes or poisoning. */
  safety: boolean;
  text: string;
}

/** Any mention of these makes a paragraph safety reading. "Ufarlig" on its
 * own (a harmless colour change, say) does not. */
const SAFETY_WORDS =
  /forveksl|giftig|(^|[^u])farlig|fluesvamp|amanita|hold dig fra|lad svampen stå/i;

/** Any mention of these makes a paragraph (also) about preparing the mushroom:
 * cooking requirements, peeling, and who tolerates it badly. */
const PREPARATION_WORDS =
  /(^|[^a-zæøå])rå([^a-zæøå]|$)|steg|kog(es|t)|tilbered|forvell|afførende|maveuro|tåler den|skræl|slimede hud/i;

/** The paragraph opens by saying where and when the species grows. */
const HABITAT_OPENING =
  /^(den|arten) (vokser|lever|er (meget )?almindelig|ses|findes|er (en )?(vednedbryder|mykorrhizasvamp|snylter))(?![a-zæøå])/;

function firstSentence(text: string): string {
  const match = /^.*?[.!?](?=\s+[A-ZÆØÅ]|$)/.exec(text);
  return match ? match[0] : text;
}

type Subject = "lookalikes" | "features" | "habitat" | null;

/** Heading for a paragraph, from what its opening is about and what else it
 * goes on to cover. Safety content is always named with the word "forveksling". */
function headingFor(subject: Subject, preparation: boolean, safety: boolean): string | null {
  if (subject === "lookalikes") return "Forveksling";
  if (subject === "features") {
    if (preparation && safety) return "Kendetegn, tilberedning og forveksling";
    if (safety) return "Kendetegn og forveksling";
    return preparation ? "Kendetegn og tilberedning" : "Kendetegn";
  }
  if (subject === "habitat") {
    if (preparation && safety) return "Levested, tilberedning og forveksling";
    if (safety) return "Levested og forveksling";
    return preparation ? "Levested og tilberedning" : "Levested og sæson";
  }
  if (preparation && safety) return "Tilberedning og forveksling";
  if (safety) return "Forveksling og sikkerhed";
  return preparation ? "Tilberedning" : null;
}

/** Split a description into paragraphs and give them headings. The texts carry
 * no headings in the data, so a subject heading is only given where the opening
 * sentence makes the subject plain. Lookalike and poison text is the exception:
 * every paragraph that mentions it anywhere gets a "forveksling" heading, so
 * that reading is findable on every species. Cooking cautions are named too. */
export function describeSections(description: string, danishName: string): DescriptionSection[] {
  const paragraphs = description
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => p !== "");
  const name = danishName.toLowerCase();
  const used = new Set<string>();
  return paragraphs.map((text) => {
    const opening = firstSentence(text).toLowerCase();
    const safety = SAFETY_WORDS.test(text);
    const preparation = PREPARATION_WORDS.test(text);
    const subject: Subject = /forveksl/.test(opening)
      ? "lookalikes"
      : opening.startsWith(name) || opening.startsWith("hatten ")
        ? "features"
        : HABITAT_OPENING.test(opening)
          ? "habitat"
          : null;
    let heading = headingFor(subject, preparation, safety);
    // never drop a safety heading; other repeats are left unlabelled
    if (heading && used.has(heading) && !safety) heading = null;
    if (heading) used.add(heading);
    return { heading, safety, text };
  });
}
