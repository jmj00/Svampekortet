import { describe, expect, it } from "vitest";

import { CHIPS, isActiveQuery, resolveQuery } from "./keywords";
import type { Manifest, SpeciesSummary } from "./types";

function summary(partial: Partial<SpeciesSummary> & { slug: string }): SpeciesSummary {
  return {
    danish_name: partial.slug,
    scientific_name: partial.slug,
    group: "kantarel",
    tier: "core",
    score_validated: true,
    observation_count: 0,
    file: `species/${partial.slug}.json`,
    ...partial,
  };
}

const manifest: Manifest = {
  version: "test",
  bbox: [8.0, 54.5, 15.3, 57.9],
  attribution: {
    observations: "",
    weather: "",
    basemap: "",
    redlist: "",
    photos: "",
    forests: "",
  },
  forests: null,
  species: [
    summary({
      slug: "kantarel",
      danish_name: "Almindelig Kantarel",
      scientific_name: "Cantharellus cibarius",
      group: "kantarel",
    }),
    summary({
      slug: "tragt",
      danish_name: "Tragt-Kantarel",
      scientific_name: "Craterellus tubaeformis",
      group: "kantarel",
    }),
    summary({
      slug: "karljohan",
      danish_name: "Spiselig Rørhat",
      scientific_name: "Boletus edulis",
      group: "rorhat",
    }),
    summary({
      slug: "brun",
      danish_name: "Brunstokket Rørhat",
      scientific_name: "Imleria badia",
      group: "rorhat",
    }),
    summary({
      slug: "oesters",
      danish_name: "Østershat",
      scientific_name: "Pleurotus ostreatus",
      group: "traesvamp",
      tier: "extra",
      score_validated: false,
    }),
    summary({
      slug: "pig",
      danish_name: "Almindelig Pigsvamp",
      scientific_name: "Hydnum repandum",
      group: "pigsvamp",
      tier: "extra",
      score_validated: false,
    }),
    summary({
      slug: "stovbold",
      danish_name: "Krystal-Støvbold",
      scientific_name: "Lycoperdon perlatum",
      group: "stoevbold",
      tier: "extra",
      score_validated: false,
    }),
    summary({
      slug: "morkel",
      danish_name: "Spiselig Morkel",
      scientific_name: "Morchella esculenta",
      group: "morkel",
      tier: "extra",
      score_validated: false,
    }),
    summary({
      slug: "granmk",
      danish_name: "Gran-Mælkehat",
      scientific_name: "Lactarius deterrimus",
      group: "maelkehat",
      tier: "extra",
      score_validated: false,
    }),
  ],
};

const slugs = (rows: SpeciesSummary[]) => rows.map((r) => r.slug).sort();

describe("resolveQuery", () => {
  it("returns every species for an empty query", () => {
    expect(resolveQuery("", manifest)).toHaveLength(9);
    expect(resolveQuery("   ", manifest)).toHaveLength(9);
  });

  it("maps 'karl johan' to Boletus edulis only", () => {
    expect(slugs(resolveQuery("Karl Johan", manifest))).toEqual(["karljohan"]);
  });

  it("maps chanterelle words to the kantarel group", () => {
    expect(slugs(resolveQuery("kantarel", manifest))).toEqual(["kantarel", "tragt"]);
    expect(slugs(resolveQuery("chanterelle", manifest))).toEqual(["kantarel", "tragt"]);
  });

  it("maps bolete words to the rorhat group", () => {
    expect(slugs(resolveQuery("rørhat", manifest))).toEqual(["brun", "karljohan"]);
    expect(slugs(resolveQuery("slimrør", manifest))).toEqual(["brun", "karljohan"]);
  });

  it("maps wood-fungus words to the traesvamp group", () => {
    expect(slugs(resolveQuery("træsvamp", manifest))).toEqual(["oesters"]);
    expect(slugs(resolveQuery("østershat", manifest))).toEqual(["oesters"]);
  });

  it("maps tooth-fungus words to the pigsvamp group", () => {
    expect(slugs(resolveQuery("pigsvamp", manifest))).toEqual(["pig"]);
    expect(slugs(resolveQuery("hydnum", manifest))).toEqual(["pig"]);
  });

  it("maps puffball words to the stoevbold group", () => {
    expect(slugs(resolveQuery("støvbold", manifest))).toEqual(["stovbold"]);
    expect(slugs(resolveQuery("bovist", manifest))).toEqual(["stovbold"]);
  });

  it("maps morel words to the morkel group", () => {
    expect(slugs(resolveQuery("morkel", manifest))).toEqual(["morkel"]);
    expect(slugs(resolveQuery("morchella", manifest))).toEqual(["morkel"]);
  });

  it("maps milkcap words to the maelkehat group", () => {
    expect(slugs(resolveQuery("mælkehat", manifest))).toEqual(["granmk"]);
    expect(slugs(resolveQuery("lactarius", manifest))).toEqual(["granmk"]);
  });

  it("treats 'spiselige' as everything (all MVP species are edible)", () => {
    expect(resolveQuery("spiselige", manifest)).toHaveLength(9);
  });

  it("falls back to a name substring match", () => {
    expect(slugs(resolveQuery("badia", manifest))).toEqual(["brun"]);
    expect(slugs(resolveQuery("tragt", manifest))).toEqual(["tragt"]);
    expect(resolveQuery("shiitake", manifest)).toEqual([]);
  });

  it("matches a group keyword typed without its accents", () => {
    expect(slugs(resolveQuery("rorhat", manifest))).toEqual(["brun", "karljohan"]);
    expect(slugs(resolveQuery("STOVBOLD", manifest))).toEqual(["stovbold"]);
  });

  it("falls back word-by-word, so a different word order still matches", () => {
    expect(slugs(resolveQuery("badia imleria", manifest))).toEqual(["brun"]);
  });

  it("every chip query resolves to at least one species", () => {
    for (const chip of CHIPS) {
      expect(resolveQuery(chip.query, manifest).length).toBeGreaterThan(0);
    }
  });
});

// Name matches come before group and keyword rules (real names from the payload).
describe("resolveQuery precedence", () => {
  const real: Manifest = {
    ...manifest,
    species: [
      summary({ slug: "kantarel", danish_name: "Almindelig Kantarel", group: "kantarel" }),
      summary({ slug: "trompet", danish_name: "Trompetsvamp", group: "kantarel" }),
      summary({
        slug: "karljohan",
        danish_name: "Spiselig Rørhat",
        scientific_name: "Boletus edulis",
        group: "rorhat",
      }),
      summary({ slug: "brun", danish_name: "Brunstokket Rørhat", group: "rorhat" }),
      summary({ slug: "slim", danish_name: "Brungul Slimrørhat", group: "rorhat" }),
      summary({ slug: "stilk", danish_name: "Skællet Stilkporesvamp", group: "traesvamp" }),
      summary({ slug: "kaempe", danish_name: "Kæmpeporesvamp", group: "traesvamp" }),
      summary({ slug: "oesters", danish_name: "Almindelig Østershat", group: "traesvamp" }),
      summary({ slug: "morkel", danish_name: "Spiselig Morkel", group: "morkel" }),
    ],
  };

  it("finds a species by a name that ends in 'svamp'", () => {
    expect(slugs(resolveQuery("stilkporesvamp", real))).toEqual(["stilk"]);
    expect(slugs(resolveQuery("trompetsvamp", real))).toEqual(["trompet"]);
    expect(slugs(resolveQuery("kæmpeporesvamp", real))).toEqual(["kaempe"]);
    expect(slugs(resolveQuery("poresvamp", real))).toEqual(["kaempe", "stilk"]);
  });

  it("prefers a full name over the group its last word names", () => {
    expect(slugs(resolveQuery("spiselig rørhat", real))).toEqual(["karljohan"]);
    expect(slugs(resolveQuery("Brunstokket  Rørhat", real))).toEqual(["brun"]);
    expect(slugs(resolveQuery("østershat", real))).toEqual(["oesters"]);
  });

  it("still gives the whole group for the group's own name", () => {
    expect(slugs(resolveQuery("kantarel", real))).toEqual(["kantarel", "trompet"]);
    expect(slugs(resolveQuery("Kantareller", real))).toEqual(["kantarel", "trompet"]);
    expect(slugs(resolveQuery("rørhat", real))).toEqual(["brun", "karljohan", "slim"]);
    expect(slugs(resolveQuery("træsvampe", real))).toEqual(["kaempe", "oesters", "stilk"]);
  });

  it("keeps the nickname and the catch-all phrases", () => {
    expect(slugs(resolveQuery("karl johan", real))).toEqual(["karljohan"]);
    expect(resolveQuery("spiselige svampe", real)).toHaveLength(9);
    expect(resolveQuery("svampe", real)).toHaveLength(9);
  });

  it("does not let 'svamp' inside an unknown word match everything", () => {
    expect(resolveQuery("fluesvamp", real)).toEqual([]);
    expect(resolveQuery("xyzsvampen", real)).toEqual([]);
  });

  it("does not filter on a single typed letter", () => {
    expect(resolveQuery("k", real)).toHaveLength(9);
    expect(resolveQuery(" x ", real)).toHaveLength(9);
    expect(isActiveQuery("k")).toBe(false);
    expect(isActiveQuery("ka")).toBe(true);
    expect(slugs(resolveQuery("ka", real))).toEqual(["kaempe", "kantarel", "stilk"]);
  });

  it("matches a hyphenated name typed with a space", () => {
    expect(slugs(resolveQuery("tragt kantarel", manifest))).toEqual(["tragt"]);
  });
});
