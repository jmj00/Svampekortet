import { describe, expect, it } from "vitest";

import {
  hasSkipParam,
  initialOthers,
  matchForests,
  type NamedPlace,
  parseStoredPin,
  pickerOrder,
  pinSubline,
  PIN_STORAGE_KEY,
  readStoredPin,
  restoredLabel,
  dateEyebrow,
  serializePin,
  shouldShowStart,
  STRIP_MAX,
  stripSpecies,
  todayAtPin,
  todayLong,
  todayShort,
  varied,
  writeStoredPin,
} from "./startstate";
import type { SpeciesSummary } from "./types";

function species(slug: string, byMonth: number[] | undefined, finds = 0): SpeciesSummary {
  return {
    slug,
    danish_name: slug,
    scientific_name: slug,
    group: "x",
    tier: "core",
    score_validated: true,
    observation_count: finds,
    season_by_month: byMonth,
    thumbnail: null,
    file: `species/${slug}.json`,
  };
}

// Real shapes from the published payload.
const TRAGT_KANTAREL = [40, 4, 0, 0, 0, 0, 16, 167, 431, 559, 210, 83];
const KARL_JOHAN = [0, 0, 0, 1, 1, 19, 192, 800, 1086, 824, 88, 2];
const KANTAREL = [28, 5, 0, 1, 16, 183, 461, 644, 615, 397, 81, 40];
const NOVEMBER = 10;
const SEPTEMBER = 8;

describe("the remembered pin", () => {
  it("round-trips a pin at about a metre's precision", () => {
    const raw = serializePin([9.517934567, 56.142012345], "Ved Vesterskov");
    expect(raw).not.toContain("9.517934567");
    expect(parseStoredPin(raw)).toEqual({ lngLat: [9.51793, 56.14201], label: "Ved Vesterskov" });
  });

  it("keeps a bare map position without a name", () => {
    expect(parseStoredPin(serializePin([10, 56], null))).toEqual({ lngLat: [10, 56], label: null });
  });

  it.each([
    ["nothing", null],
    ["an empty string", ""],
    ["not JSON", "{lon:"],
    ["a JSON string", '"hej"'],
    ["null", "null"],
    ["missing latitude", '{"lon":10}'],
    ["strings for numbers", '{"lon":"10","lat":"56"}'],
    ["a place outside Denmark", '{"lon":-73.9,"lat":40.7,"label":null}'],
    ["swapped coordinates", '{"lon":56,"lat":10,"label":null}'],
  ])("rejects %s", (_name, raw) => {
    expect(parseStoredPin(raw)).toBeNull();
  });

  it("drops a label that is not a usable string", () => {
    expect(parseStoredPin('{"lon":10,"lat":56,"label":42}')?.label).toBeNull();
    expect(parseStoredPin('{"lon":10,"lat":56,"label":"  "}')?.label).toBeNull();
  });

  it("renames a restored geolocation: it is not where the user is any more", () => {
    expect(restoredLabel("Min placering")).toBe("Seneste placering");
    expect(restoredLabel("Rold Skov")).toBe("Rold Skov");
    expect(restoredLabel(null)).toBeUndefined();
  });

  it("writes, reads and forgets through the storage it is given", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
    expect(readStoredPin(storage)).toBeNull();
    writeStoredPin({ lngLat: [9.5, 56.1], label: null }, storage);
    expect([...data.keys()]).toEqual([PIN_STORAGE_KEY]);
    expect(readStoredPin(storage)).toEqual({ lngLat: [9.5, 56.1], label: null });
    writeStoredPin(null, storage);
    expect(data.size).toBe(0);
  });

  it("survives storage that throws or is missing", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredPin(broken)).toBeNull();
    expect(() => writeStoredPin({ lngLat: [9.5, 56.1], label: null }, broken)).not.toThrow();
    expect(() => writeStoredPin(null, broken)).not.toThrow();
    expect(readStoredPin(null)).toBeNull();
    expect(() => writeStoredPin(null, null)).not.toThrow();
  });
});

describe("whether the start screen shows", () => {
  it("recognises ?kort in any position, and nothing that merely starts with it", () => {
    expect(hasSkipParam("?kort")).toBe(true);
    expect(hasSkipParam("?kort=1")).toBe(true);
    expect(hasSkipParam("?a=b&kort")).toBe(true);
    expect(hasSkipParam("?kort&a=b")).toBe(true);
    expect(hasSkipParam("")).toBe(false);
    expect(hasSkipParam("?kortet")).toBe(false);
    expect(hasSkipParam("?a=kort")).toBe(false);
  });

  it("shows on a fresh visit, not with a remembered pin or ?kort", () => {
    const pin = { lngLat: [10, 56] as [number, number], label: null };
    expect(shouldShowStart("", null)).toBe(true);
    expect(shouldShowStart("", pin)).toBe(false);
    expect(shouldShowStart("?kort", null)).toBe(false);
  });
});

describe("pickerOrder", () => {
  const list = [
    species("ukendt-a", undefined),
    species("karl-johan", KARL_JOHAN, 3013),
    species("ukendt-b", [], 4),
    species("kantarel", KANTAREL, 2471),
    species("tragt-kantarel", TRAGT_KANTAREL, 1510),
  ];

  it("leads with what is in season this month", () => {
    const { inSeason, others } = pickerOrder(list, NOVEMBER);
    expect(inSeason.map((p) => p.species.slug)).toEqual(["tragt-kantarel"]);
    // then the nearest to its season, then the ones nothing is known about
    expect(others.map((p) => p.species.slug)).toEqual([
      "kantarel",
      "karl-johan",
      "ukendt-b",
      "ukendt-a",
    ]);
  });

  it("puts the peak species first when several are in season", () => {
    const { inSeason, others } = pickerOrder(list, SEPTEMBER);
    expect(inSeason.map((p) => p.species.slug)).toEqual([
      "karl-johan",
      "kantarel",
      "tragt-kantarel",
    ]);
    expect(others.map((p) => p.species.slug)).toEqual(["ukendt-b", "ukendt-a"]);
  });

  it("copes with an empty manifest", () => {
    expect(pickerOrder([], NOVEMBER)).toEqual({ inSeason: [], others: [] });
  });
});

describe("initialOthers", () => {
  it("fills the first screen when one or two species are featured", () => {
    expect(initialOthers(1, 49)).toBe(9);
    expect(initialOthers(2, 48)).toBe(9);
    expect(initialOthers(0, 50)).toBe(9);
  });

  it("tops a few in-season tiles up to whole rows", () => {
    expect(initialOthers(4, 46)).toBe(6); // 4 + 6 >= 9, in rows of three
    expect(initialOthers(7, 43)).toBe(3);
  });

  it("holds the rest back when the season fills the screen by itself", () => {
    expect(initialOthers(9, 41)).toBe(0);
    expect(initialOthers(15, 35)).toBe(0);
  });

  it("shows everything when there is too little left for a button", () => {
    expect(initialOthers(1, 3)).toBe(3);
    expect(initialOthers(15, 2)).toBe(2);
    expect(initialOthers(1, 7)).toBe(7);
    expect(initialOthers(0, 0)).toBe(0);
  });
});

describe("the line above the headline", () => {
  it("names the day the way a forecast does", () => {
    expect(dateEyebrow(new Date(2026, 10, 27))).toBe("Fredag 27. november");
    expect(dateEyebrow(new Date(2027, 0, 3))).toBe("Søndag 3. januar");
  });
});

describe("today at the pin", () => {
  const scored = [
    { name: "Almindelig Østershat", value: 62.6 },
    { name: "Almindelig Judasøre", value: 64.2 },
    { name: "Trompetsvamp", value: 25 },
  ];

  it("counts the good ones and names the best, rounded as the list shows it", () => {
    expect(todayAtPin(scored)).toEqual({
      good: 2,
      best: { name: "Almindelig Judasøre", value: 64 },
    });
    expect(todayAtPin([])).toBeNull();
  });

  it("counts a score that rounds up to the line as good", () => {
    expect(todayAtPin([{ name: "A", value: 59.6 }])?.good).toBe(1);
    expect(todayAtPin([{ name: "A", value: 59.4 }])?.good).toBe(0);
  });

  it("says it in a line for the start screen", () => {
    expect(todayShort({ good: 2, best: null })).toBe("2 arter med gode forhold i dag");
    expect(todayShort({ good: 1, best: null })).toBe("1 art med gode forhold i dag");
    expect(todayShort({ good: 0, best: null })).toBe("Ingen arter med gode forhold i dag");
  });

  it("and in a sentence for the return card", () => {
    const best = { name: "Almindelig Judasøre", value: 64 };
    expect(todayLong({ good: 2, best })).toBe(
      "2 arter har gode forhold – bedst er Almindelig Judasøre med 64.",
    );
    expect(todayLong({ good: 1, best })).toBe("Almindelig Judasøre har gode forhold (64).");
    expect(todayLong({ good: 0, best: { name: "Trompetsvamp", value: 25 } })).toBe(
      "Ingen arter har gode forhold. Bedst er Trompetsvamp med 25.",
    );
  });
});

describe("the season strip", () => {
  const named = (name: string, byMonth: number[]): SpeciesSummary => ({
    ...species(name.toLowerCase().replace(/ /g, "-"), byMonth, 100),
    danish_name: name,
  });

  it("lets each kind lead once before its relatives", () => {
    const order = pickerOrder(
      [
        named("Bleg Hekseringshat", [0, 0, 0, 0, 0, 0, 0, 0, 10, 50, 100, 40]),
        named("Violet Hekseringshat", [0, 0, 0, 0, 0, 0, 0, 0, 10, 60, 90, 40]),
        named("Almindelig Østershat", [20, 10, 0, 0, 0, 0, 0, 0, 10, 50, 80, 60]),
      ],
      NOVEMBER,
    );
    expect(varied(order.inSeason).map((p) => p.species.danish_name)).toEqual([
      "Bleg Hekseringshat",
      "Almindelig Østershat",
      "Violet Hekseringshat",
    ]);
  });

  it("shows what is in season, or what comes next in a month without", () => {
    const list = [
      species("karl-johan", KARL_JOHAN, 3013),
      species("tragt-kantarel", TRAGT_KANTAREL, 1510),
    ];
    const november = stripSpecies(pickerOrder(list, NOVEMBER));
    expect(november.inSeason).toBe(true);
    expect(november.items.map((p) => p.species.slug)).toEqual(["tragt-kantarel"]);
    const april = stripSpecies(pickerOrder(list, 3));
    expect(april.inSeason).toBe(false);
    expect(april.items).toHaveLength(2);
  });

  it("keeps to its length", () => {
    const many = Array.from({ length: 20 }, (_, i) => species(`s${i}`, KANTAREL, 10));
    expect(stripSpecies(pickerOrder(many, SEPTEMBER)).items).toHaveLength(STRIP_MAX);
  });
});

describe("pinSubline", () => {
  it("puts 'ved' in front of a name that lacks it", () => {
    expect(pinSubline("Ved Vesterskov")).toBe("Ved Vesterskov");
    expect(pinSubline("I Mølleskov i Rold Skov")).toBe("I Mølleskov i Rold Skov");
    expect(pinSubline("ved Rold")).toBe("Ved Rold");
    expect(pinSubline("Rold Skov")).toBe("Ved Rold Skov");
    expect(pinSubline("Rådhuspladsen 1, 1550 København V")).toBe(
      "Ved Rådhuspladsen 1, 1550 København V",
    );
  });

  it("rewrites the chip's own names so they read as Danish", () => {
    expect(pinSubline("Min placering")).toBe("Ved din placering");
    expect(pinSubline("Seneste placering")).toBe("Ved din seneste placering");
    expect(pinSubline("Nål på kortet")).toBe("Ved nålen på kortet");
  });
});

describe("matchForests", () => {
  const forest = (name: string, area: number | null, lon = 10): NamedPlace => ({
    name,
    lon,
    lat: 56,
    area_m2: area,
  });
  const forests = [
    forest("Nørreskov", 100, 9),
    forest("Rold Skov", 8000),
    forest("Gribskov", 5600),
    forest("Nørreskov", 900, 12),
    forest("Lille Gribskov", 50),
    forest("Store Dyrehave", 1100),
    forest("Skovrød Krat", 20),
    forest("Uden areal", null),
  ];
  const names = (query: string, limit?: number) =>
    matchForests(forests, query, limit).map((f) => f.name);

  it("finds a forest by the start of its name, whatever the case and spacing", () => {
    expect(names("rold")).toEqual(["Rold Skov"]);
    expect(names("ROLD SKOV")).toEqual(["Rold Skov"]);
    expect(names("grib skov")).toEqual(["Gribskov", "Lille Gribskov"]);
  });

  it("ranks a name that starts with the query over one that contains it", () => {
    expect(names("skov")).toEqual(["Skovrød Krat", "Rold Skov", "Gribskov", "Nørreskov"]);
    expect(names("dyre")).toEqual(["Store Dyrehave"]);
  });

  it("offers one forest per name: the largest", () => {
    const found = matchForests(forests, "nørre");
    expect(found).toHaveLength(1);
    expect(found[0].lon).toBe(12);
  });

  it("needs two characters and respects the limit", () => {
    expect(names("r")).toEqual([]);
    expect(names("  ")).toEqual([]);
    expect(names("skov", 2)).toHaveLength(2);
    expect(names("findes ikke")).toEqual([]);
  });
});

describe("matchForests near a town", () => {
  const forests = [
    { name: "Vesterskov", lon: 9.52, lat: 56.14, area_m2: 1e5 },
    { name: "Vesterskov", lon: 10.9, lat: 55.4, area_m2: 9e6 },
    { name: "Nørre Vesterskov", lon: 9.6, lat: 56.2, area_m2: 1e5 },
    { name: "Østerskov", lon: 9.53, lat: 56.15, area_m2: 1e5 },
  ];

  it("lists every forest of the name near the town, the nearest first", () => {
    const near = matchForests(forests, "Vesterskov", 4, [9.551, 56.181]);
    expect(near.map((f) => [f.name, f.lon])).toEqual([
      ["Vesterskov", 9.52],
      ["Nørre Vesterskov", 9.6],
    ]);
    // without a town the largest of the name stands for it
    expect(matchForests(forests, "Vesterskov")[0].lon).toBe(10.9);
  });
});
