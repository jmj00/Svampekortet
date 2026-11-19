import type { Manifest, SpeciesSummary } from "./types";

// Known-good example queries -- no longer rendered as clickable chips (the
// search box's placeholder text points at a couple of these instead, to save
// vertical space on mobile), but kept as a small regression check
// (keywords.test.ts) that each one still resolves to a sensible match.
export const CHIPS: { label: string; query: string }[] = [
  { label: "Spiselige svampe", query: "spiselige" },
  { label: "Kantareller", query: "kantarel" },
  { label: "Rørhatte", query: "rørhat" },
  { label: "Træsvampe", query: "træsvamp" },
  { label: "Pigsvampe", query: "pigsvamp" },
  { label: "Støvbolde", query: "støvbold" },
  { label: "Mælkehatte", query: "mælkehat" },
  { label: "Karl Johan", query: "karl johan" },
];

const MIN_FALLBACK_WORD_LENGTH = 2;
/** A query shorter than this does not filter yet: one typed letter would
 * otherwise flash "nothing matches" before the second keystroke. */
export const MIN_QUERY_LENGTH = 2;

/** Whether `query` is long enough to narrow the list at all. */
export function isActiveQuery(query: string): boolean {
  return normalise(query.trim()).length >= MIN_QUERY_LENGTH;
}

/** Lowercase and drop Danish diacritics (æ/ø/å) plus general accents, so
 * "rørhat" and a typed "rorhat" compare equal -- one normalisation step
 * shared by every comparison below, rather than spelling out every accented
 * variant in each pattern (the previous approach). Not fuzzy/typo-tolerant
 * matching, just accent-insensitive. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // å -> a (NFD splits it into a + a combining ring)
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o");
}

// A query that is exactly a group's own name (with a common ending) means the
// whole group, including members whose names do not contain the word:
// "kantarel" should still list Trompetsvamp.
const GROUP_WORDS: { pattern: RegExp; group: string }[] = [
  { pattern: /^kantarel(ler|lerne)?$/, group: "kantarel" },
  { pattern: /^rorhat(te|ten|tene)?$/, group: "rorhat" },
  { pattern: /^traesvampe?(ne)?$/, group: "traesvamp" },
  { pattern: /^pigsvampe?(ne)?$/, group: "pigsvamp" },
  { pattern: /^blaek(hat|hatte|svamp|svampe)$/, group: "blaeksvamp" },
  { pattern: /^stovbold(e|ene)?$/, group: "stoevbold" },
  { pattern: /^mork(el|ler|lerne)$/, group: "morkel" },
  { pattern: /^maelkehat(te|ten|tene)?$/, group: "maelkehat" },
];

// Looser keywords, tried only when the query is not (part of) a species name.
// Ordered: first matching rule wins. Patterns are written against the
// *normalised* query (see `normalise`), so an accented and unaccented typing
// of the same word both match without the pattern spelling out both forms.
const RULES: { pattern: RegExp; keep: (s: SpeciesSummary) => boolean }[] = [
  { pattern: /karl\s*johan/, keep: (s) => s.scientific_name === "Boletus edulis" },
  { pattern: /kantarel|chanterelle/, keep: (s) => s.group === "kantarel" },
  { pattern: /rorhat|bolete|slimr/, keep: (s) => s.group === "rorhat" },
  { pattern: /traesvamp|ostershat|judasore|osters|wood/, keep: (s) => s.group === "traesvamp" },
  { pattern: /pigsvamp|pigger|hydnum/, keep: (s) => s.group === "pigsvamp" },
  { pattern: /blaekhat|blaeksvamp|coprinus|paryk/, keep: (s) => s.group === "blaeksvamp" },
  { pattern: /stovbold|puffball|bovist|lycoperdon/, keep: (s) => s.group === "stoevbold" },
  { pattern: /morkel|morel|morchella/, keep: (s) => s.group === "morkel" },
  { pattern: /maelkehat|lactarius|milkcap/, keep: (s) => s.group === "maelkehat" },
  // Every published species is edible. "svamp" counts only as a word of its
  // own, so it does not swallow an unknown or mistyped "...svamp" name.
  { pattern: /\bspiselig|\bedible|\bsvampe?(ne)?\b/, keep: () => true },
];

/** Hyphenated names ("Tragt-Kantarel") should match with a space typed instead. */
function unhyphen(text: string): string {
  return text.replace(/-/g, " ");
}

/** Resolution order, most specific first:
 *  1. a group's own name ("rørhat") -> that group;
 *  2. the query is part of a species' Danish or scientific name -> those
 *     species ("stilkporesvamp", "spiselig rørhat", "badia");
 *  3. a looser keyword or nickname ("karl johan", "bolete", "spiselige svampe");
 *  4. any single word of the query found in a name. */
export function resolveQuery(query: string, manifest: Manifest): SpeciesSummary[] {
  const q = normalise(query.trim()).replace(/\s+/g, " ");
  if (q.length < MIN_QUERY_LENGTH) return manifest.species;

  const groupWord = GROUP_WORDS.find((g) => g.pattern.test(q));
  if (groupWord) return manifest.species.filter((s) => s.group === groupWord.group);

  const names = manifest.species.map(
    (s) => `${normalise(s.danish_name)} ${normalise(s.scientific_name)}`,
  );
  const byName = manifest.species.filter(
    (_, i) => names[i].includes(q) || unhyphen(names[i]).includes(unhyphen(q)),
  );
  if (byName.length > 0) return byName;

  const rule = RULES.find((r) => r.pattern.test(q));
  if (rule) return manifest.species.filter(rule.keep);

  // Nothing matched as a whole -- fall back word by word, so a different word
  // order, or one matching word plus one that doesn't, still finds something.
  // Still just substring matching, not real fuzzy/typo tolerance.
  const words = q.split(" ").filter((w) => w.length >= MIN_FALLBACK_WORD_LENGTH);
  if (words.length === 0) return [];
  return manifest.species.filter((_, i) => words.some((w) => names[i].includes(w)));
}
