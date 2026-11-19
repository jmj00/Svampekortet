import { describe, expect, it } from "vitest";

import { mergeHits, preferHits } from "./addresses";
import placesText from "./data/places.json?raw";
import {
  buildPlaceIndex,
  districtPoint,
  distinctTexts,
  isPlaceName,
  districtZoom,
  matchPlaces,
  normalizeName,
  oneSlipApart,
  parseAddressQuery,
  splitTown,
  postalFor,
  townsFor,
  townZoom,
  type RawPlaces,
} from "./placeindex";

// A few real entries, in the file's own shape.
const RAW: RawPlaces = {
  postal: [
    ["1456", "København K", 12.56, 55.67, 12.58, 55.69],
    ["8000", "Aarhus C", 10.172, 56.118, 10.332, 56.173],
    ["8200", "Aarhus N", 10.113, 56.169, 10.224, 56.24],
    ["8210", "Aarhus V", 10.114, 56.158, 10.191, 56.184],
    ["8600", "Silkeborg", 9.362, 56.098, 9.762, 56.267],
    ["8620", "Kjellerup", 9.3, 56.2, 9.5, 56.35],
    ["9510", "Arden", 9.771, 56.72, 10.058, 56.825],
  ],
  towns: [
    ["Rold", 9.815, 56.773, 0.3, 6, 0],
    ["Silkeborg", 9.551, 56.181, 3.1, 4, 0],
    ["Silkeborg Bad", 9.53, 56.16, 0.4, 4, 1],
    ["Aarhus", 10.172, 56.155, 5.6, 1, 0],
    ["Arden", 9.86, 56.77, 0.9, 6, 0],
    ["Skov", 9.0, 56.0, 0.2, 5, 0],
  ],
};
const index = buildPlaceIndex(RAW);

describe("normalizeName", () => {
  it("treats aa as å, and case, dots and dashes as nothing", () => {
    expect(normalizeName("Aarhus")).toBe(normalizeName("århus"));
    expect(normalizeName("  Skt.  Klemens ")).toBe("skt klemens");
    expect(normalizeName("Vester-Skerninge")).toBe("vester skerninge");
  });
});

describe("oneSlipApart", () => {
  it("allows one letter missing, extra, wrong, or two swapped", () => {
    expect(oneSlipApart("silkeborg", "silkebrg")).toBe(true);
    expect(oneSlipApart("silkeborg", "silkeborgg")).toBe(true);
    expect(oneSlipApart("silkeborg", "silkebogr")).toBe(true);
    expect(oneSlipApart("silkeborg", "silkebarg")).toBe(true);
    expect(oneSlipApart("silkeborg", "sjlkebarg")).toBe(false);
  });
});

describe("postalFor / townsFor", () => {
  it("finds a district by name, a city's parts, and a slip", () => {
    expect(postalFor(index, "Silkeborg").map((p) => p.postnr)).toEqual(["8600"]);
    expect(postalFor(index, "Aarhus").map((p) => p.postnr)).toEqual(["8000", "8200", "8210"]);
    expect(postalFor(index, "silkebrg").map((p) => p.postnr)).toEqual(["8600"]);
    expect(postalFor(index, "Rold")).toEqual([]);
    expect(townsFor(index, "Rold").map((t) => t.name)).toEqual(["Rold"]);
  });
});

describe("parseAddressQuery", () => {
  const texts = (q: string) => parseAddressQuery(index, q).texts;

  it("turns a town after the address into the postal number the service filters on", () => {
    expect(texts("Vestergade 10 Silkeborg")).toEqual(["Vestergade 10, 8600"]);
    expect(texts("Vestergade 10, Silkeborg")).toEqual(["Vestergade 10, 8600"]);
    expect(texts("Vestergade Silkeborg")).toEqual(["Vestergade, 8600"]);
    expect(texts("Vestergade 10 Silkebrg")).toEqual(["Vestergade 10, 8600"]);
    expect(texts("Vestergade 10 Aarhus")).toEqual([
      "Vestergade 10, 8000",
      "Vestergade 10, 8200",
      "Vestergade 10, 8210",
    ]);
  });

  it("reads a postal number wherever it stands after the street", () => {
    expect(texts("Vestergade 10 8600")).toEqual(["Vestergade 10, 8600"]);
    expect(texts("Vestergade 10, 8600 Silkeborg")).toEqual(["Vestergade 10, 8600"]);
    expect(texts("8600")).toEqual([]); // a district, not an address
  });

  it("takes a town that is no postal district only after a comma or a house number", () => {
    expect(texts("Hovedvejen 3 Rold")).toEqual(["Hovedvejen 3, 9510"]);
    expect(texts("Hovedvejen, Rold")).toEqual(["Hovedvejen, 9510"]);
    // a street or a forest name is not cut in two
    expect(texts("Rold Skov")).toEqual(["Rold Skov"]);
    expect(parseAddressQuery(index, "Rold Skov").scoped).toBe(false);
  });

  it("leaves anything else as typed", () => {
    expect(texts("Vestergade 10")).toEqual(["Vestergade 10"]);
    expect(texts("  Rådhuspladsen   1 ")).toEqual(["Rådhuspladsen 1"]);
  });
});

describe("matchPlaces", () => {
  const texts = (q: string) => matchPlaces(index, q).map((s) => s.text);

  it("offers a town for its name, the exact one first", () => {
    expect(texts("Silkeborg")).toEqual(["Silkeborg", "Silkeborg Bad · 8600 Silkeborg"]);
    expect(texts("Rold")).toEqual(["Rold · 9510 Arden"]);
    expect(texts("silkebrg")).toEqual(["Silkeborg"]);
  });

  it("offers the district for a postal number, alone or with its name", () => {
    expect(texts("8600")).toEqual(["8600 Silkeborg"]);
    expect(texts("8600 Silkeborg")).toEqual(["8600 Silkeborg"]);
    expect(texts("9999")).toEqual([]);
  });

  it("offers districts no town is named after, and only those", () => {
    expect(texts("Aarhus C")).toEqual(["8000 Aarhus C"]);
    // a city: the town, not its districts as well
    expect(texts("Aarhus")).toEqual(["Aarhus"]);
  });

  it("names a town by its name alone when a postal district has that name", () => {
    expect(texts("Arden")).toEqual(["Arden"]);
  });

  it("names the pin after the town, and flies close enough to see it", () => {
    const [rold] = matchPlaces(index, "Rold");
    expect(rold.label).toBe("Rold");
    expect(rold.target).toEqual([9.815, 56.773]);
    expect(rold.zoom).toBe(14);
  });

  it("says nothing under three letters, or for an address", () => {
    expect(texts("Ro")).toEqual([]);
    expect(texts("Vestergade 10")).toEqual([]);
  });
});

describe("splitTown", () => {
  it("finds a town at the end, with the words before it", () => {
    expect(splitTown(index, "Vesterskov Silkeborg")).toEqual({
      rest: "Vesterskov",
      at: [9.551, 56.181],
      town: "Silkeborg",
    });
    expect(splitTown(index, "Vesterskov, aarhus c")).toMatchObject({
      rest: "Vesterskov",
      town: "Aarhus C",
    });
    expect(splitTown(index, "Silkeborg")).toBeNull(); // nothing before it
    expect(splitTown(index, "Vesterskov")).toBeNull();
  });
});

describe("no two suggestions read the same", () => {
  it("names the district of a second town of a name, not of the city itself", () => {
    const list = distinctTexts([
      {
        text: "Frederiksberg",
        full: "Frederiksberg · 2000",
        label: "Frederiksberg",
        target: [12.5, 55.68],
        zoom: 12,
      },
      {
        text: "Frederiksberg",
        full: "Frederiksberg · 4180 Sorø",
        label: "Frederiksberg",
        target: [11.6, 55.4],
        zoom: 14,
      },
    ]);
    expect(list.map((s) => s.text)).toEqual(["Frederiksberg", "Frederiksberg · 4180 Sorø"]);
  });

  it("names the district of a town that has a forest's name", () => {
    const list = distinctTexts(
      [{ text: "Rold", full: "Rold · 9510 Arden", label: "Rold", target: [9.8, 56.8], zoom: 14 }],
      new Set(["Rold"]),
    );
    expect(list.map((s) => s.text)).toEqual(["Rold · 9510 Arden"]);
  });

  it("never shows two of the same in the published list", () => {
    for (const q of ["Frederiksberg", "Hald", "Nørreby", "Vester", "Skov", "Ny"]) {
      const texts = matchPlaces(buildPlaceIndex(JSON.parse(placesText) as RawPlaces), q).map(
        (s) => s.text,
      );
      expect(new Set(texts).size).toBe(texts.length);
    }
  });
});

describe("isPlaceName", () => {
  it("is a town's or district's name and nothing else", () => {
    expect(isPlaceName(index, "Silkeborg")).toBe(true);
    expect(isPlaceName(index, "aarhus c")).toBe(true);
    expect(isPlaceName(index, "Silkeborgvej")).toBe(false);
    expect(isPlaceName(index, "Rold 3")).toBe(false);
  });
});

describe("parseAddressQuery says which town it read", () => {
  it("gives the street, the town and the town itself", () => {
    expect(parseAddressQuery(index, "Hovedgaden 1 Rold")).toMatchObject({
      street: "Hovedgaden 1",
      town: "Rold",
      place: { label: "Rold" },
    });
    expect(parseAddressQuery(index, "Vestergade 10 8600")).toMatchObject({
      street: "Vestergade 10",
      town: "8600 Silkeborg",
    });
  });
});

describe("zooms", () => {
  it("goes closer for a smaller town", () => {
    expect(townZoom(0.2)).toBeGreaterThan(townZoom(1));
    expect(townZoom(1)).toBeGreaterThan(townZoom(5));
  });

  it("fits a postal district", () => {
    const silkeborg = districtZoom([9.362, 56.098, 9.762, 56.267]);
    expect(silkeborg).toBeGreaterThanOrEqual(8.5);
    expect(silkeborg).toBeLessThanOrEqual(11);
  });
});

describe("preferHits", () => {
  it("puts the addresses in a preferred district first, keeping the order otherwise", () => {
    const hits = [
      { titel: "Nørregade 5, 1165 København K" },
      { titel: "Nørregade 5, 5000 Odense C" },
      { titel: "Nørregade 5, 1050 København K" },
    ];
    expect(preferHits(hits, ["odense c"]).map((h) => h.titel)).toEqual([
      "Nørregade 5, 5000 Odense C",
      "Nørregade 5, 1165 København K",
      "Nørregade 5, 1050 København K",
    ]);
    expect(preferHits(hits, [])).toBe(hits);
  });
});

describe("mergeHits", () => {
  it("keeps each search's order, the first search first, no address twice", () => {
    expect(mergeHits([["a", "b"], ["b", "c"], ["d"]], 3)).toEqual(["a", "b", "c"]);
    expect(mergeHits([[], ["x"]], 6)).toEqual(["x"]);
  });
});

describe("the published list", () => {
  const raw = JSON.parse(placesText) as RawPlaces;
  const real = buildPlaceIndex(raw);

  it("has the towns and districts the search relies on", () => {
    expect(real.postal.length).toBeGreaterThan(1000);
    expect(real.towns.length).toBeGreaterThan(8000);
    expect(matchPlaces(real, "Silkeborg")[0].text).toBe("Silkeborg");
    expect(matchPlaces(real, "Aarhus")[0].text).toBe("Aarhus"); // not its middle's district
    expect(parseAddressQuery(real, "Nørregade 5 København")).toMatchObject({
      texts: ["Nørregade 5"],
      scoped: true,
      prefer: expect.arrayContaining(["københavn k"]),
    });
    expect(matchPlaces(real, "Rold")[0].text).toBe("Rold · 9510 Arden");
    expect(matchPlaces(real, "8600")[0].text).toBe("8600 Silkeborg");
    expect(parseAddressQuery(real, "Vestergade 10 Silkeborg").texts).toEqual([
      "Vestergade 10, 8600",
    ]);
  });

  it("gives the bare name to the town a name means, not to a hamlet of that name", () => {
    const first = (q: string) => matchPlaces(real, q)[0];
    // Hellerup north of Copenhagen, not the hamlet in 5750 Ringe on Funen
    expect(first("Hellerup").text).toBe("Hellerup");
    expect(first("Hellerup").target[0]).toBeGreaterThan(12.4);
    expect(matchPlaces(real, "Hellerup")[1].text).toBe("Hellerup · 5750 Ringe");
    // Askeby on Møn (4792 Askeby), not the village on Funen
    expect(first("Askeby").text).toBe("Askeby");
    expect(first("Askeby").target[0]).toBeGreaterThan(12);
    expect(matchPlaces(real, "Askeby").map((s) => s.text)).toContain("Askeby · 5471 Søndersø");
    // and those that were right stay right
    for (const [q, east] of [
      ["Frederiksberg", true],
      ["Assens", false],
      ["Anholt", true],
      ["Almind", false],
      ["Agerskov", false],
    ] as const) {
      const s = first(q);
      expect(s.text).toBe(q);
      if (east) expect(s.target[0]).toBeGreaterThan(11);
    }
    expect(first("Anholt").target[1]).toBeGreaterThan(56.6); // the island
  });

  it("puts every postal district on land: at one of its own towns", () => {
    const km = (a: [number, number], b: [number, number]) =>
      Math.hypot((a[0] - b[0]) * 111.32 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110.57);
    let checked = 0;
    real.postal.forEach((district, i) => {
      const own = real.towns.filter((town) => town.postal === i);
      if (own.length === 0) return; // (a street postcode in København)
      const { target } = districtPoint(real, district);
      const nearest = Math.min(...own.map((town) => km(target, [town.lon, town.lat])));
      expect(nearest, `${district.postnr} ${district.name}`).toBeLessThan(3);
      checked++;
    });
    expect(checked).toBeGreaterThan(500);
    // the ones that were in the sea
    const at = (postnr: string) => districtPoint(real, real.byPostnr.get(postnr)!).target;
    expect(km(at("6857"), [8.104, 55.556])).toBeLessThan(1); // Blåvand
    expect(km(at("6960"), [8.124, 56.015])).toBeLessThan(1); // Hvide Sande
    expect(km(at("3700"), [14.713, 55.102])).toBeLessThan(1); // Rønne
    expect(km(at("6950"), [8.264, 56.088])).toBeLessThan(1); // Ringkøbing
    expect(at("6720")[0]).toBeGreaterThan(8.3); // on Fanø, not west of it
  });

  it("offers a district first when the towns of its name lie elsewhere", () => {
    expect(matchPlaces(real, "Læsø")[0].text).toBe("9940 Læsø");
    expect(matchPlaces(real, "Askø")[0].text).toBe("4942 Askø");
    expect(matchPlaces(real, "Fanø")[0].text).toBe("6720 Fanø");
  });

  it("finds a postal district by its last word", () => {
    expect(matchPlaces(real, "Lyngby")[0].text).toBe("2800 Kongens Lyngby");
  });

  it("puts every town inside Denmark", () => {
    for (const town of real.towns) {
      expect(town.lon).toBeGreaterThan(7.9);
      expect(town.lon).toBeLessThan(15.3);
      expect(town.lat).toBeGreaterThan(54.5);
      expect(town.lat).toBeLessThan(57.8);
    }
  });
});
