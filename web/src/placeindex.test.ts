import { describe, expect, it } from "vitest";

import { mergeHits, preferHits } from "./addresses";
import placesText from "./data/places.json?raw";
import {
  buildPlaceIndex,
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
    expect(parseAddressQuery(real, "Nørregade 5 København")).toEqual({
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

  it("puts every town inside Denmark", () => {
    for (const town of real.towns) {
      expect(town.lon).toBeGreaterThan(7.9);
      expect(town.lon).toBeLessThan(15.3);
      expect(town.lat).toBeGreaterThan(54.5);
      expect(town.lat).toBeLessThan(57.8);
    }
  });
});
