import { describe, expect, it } from "vitest";
import { ForestOutlines } from "./forestoutlines";
import { SHORTCUT_KM, hereMetaShort, hereMetaText, resolveHere, scoreKey } from "./foresthere";
import { PIN_FOREST_KM, closestForest, forestAtPin, sameForest } from "./forests";

// 0.01 degrees of latitude is about 1.11 km.
const points = [
  { name: "Nærskov", lon: 10, lat: 56.005, area_m2: null },
  { name: "Naboskov", lon: 10, lat: 56.012, area_m2: null },
  { name: "Fjernskov", lon: 10, lat: 56.2, area_m2: null },
];

describe("forestAtPin", () => {
  it("is the nearest named forest within the pin radius", () => {
    expect(forestAtPin(points, 10, 56)?.name).toBe("Nærskov");
    expect(forestAtPin(points, 10, 56.011)?.name).toBe("Naboskov");
  });

  it("is null when the nearest forest is further than the radius", () => {
    expect(forestAtPin(points, 10, 56.1)).toBeNull();
    expect(forestAtPin([], 10, 56)).toBeNull();
  });

  it("draws the line at PIN_FOREST_KM", () => {
    const degreesPerKm = 1 / 111.195;
    const one = [{ name: "Skov", lon: 10, lat: 56, area_m2: null }];
    expect(forestAtPin(one, 10, 56 + (PIN_FOREST_KM - 0.02) * degreesPerKm)?.name).toBe("Skov");
    expect(forestAtPin(one, 10, 56 + (PIN_FOREST_KM + 0.02) * degreesPerKm)).toBeNull();
  });
});

describe("closestForest", () => {
  it("looks as far as it is told, and reports the distance", () => {
    expect(closestForest(points, 10, 56.1, 5)).toBeNull();
    const far = closestForest(points, 10, 56.1, 20);
    expect(far?.name).toBe("Naboskov");
    expect(far?.distanceKm).toBeGreaterThan(9);
    expect(far?.distanceKm).toBeLessThan(10);
  });
});

describe("sameForest", () => {
  it("needs the same name at the same point", () => {
    const a = { name: "Storskov", lon: 10, lat: 56 };
    expect(sameForest(a, { ...a, distanceKm: 3 } as typeof a)).toBe(true);
    expect(sameForest(a, { name: "Storskov", lon: 11, lat: 56 })).toBe(false);
    expect(sameForest(a, { name: "Lilleskov", lon: 10, lat: 56 })).toBe(false);
  });
});

describe("resolveHere", () => {
  it("is unknown without a pin or without forest data", () => {
    expect(resolveHere(points, null)).toEqual({ kind: "unknown" });
    expect(resolveHere(null, [10, 56])).toEqual({ kind: "unknown" });
  });

  it("names the forest the pin is in or beside", () => {
    const here = resolveHere(points, [10, 56]);
    expect(here.kind).toBe("forest");
    expect(here.kind === "forest" && here.forest.name).toBe("Nærskov");
  });

  it("offers the nearest forest when the pin is by none", () => {
    const here = resolveHere(points, [10, 56.1]);
    expect(here.kind).toBe("nowhere");
    expect(here.kind === "nowhere" && here.nearest?.name).toBe("Naboskov");
  });

  it("says it is looking while the outlines for the spot are on their way", () => {
    const ref = {
      file: "a.json",
      start: 0,
      count: 3,
      bbox: [9.9, 55.9, 10.1, 56.3] as [number, number, number, number],
    };
    const outlines = new ForestOutlines([ref], () => new Promise(() => {}));
    outlines.request(10, 56);
    expect(resolveHere(points, [10, 56], outlines)).toEqual({ kind: "pending" });
  });

  it("offers nothing when no forest is within reach", () => {
    expect(SHORTCUT_KM).toBeLessThan(100);
    expect(resolveHere(points, [10, 58])).toEqual({ kind: "nowhere", nearest: null });
  });
});

describe("hereMetaText", () => {
  const ready = (score: number | null, scoreSpecies: string | null) =>
    ({ state: "ready", score: { score, scoreSpecies } }) as const;

  it("says what is going on while there is no score", () => {
    expect(hereMetaText({ state: "loading" }, null)).toMatch(/Beregner/);
    expect(hereMetaText({ state: "unavailable" }, null)).toMatch(/kan ikke beregnes/);
    expect(hereMetaText({ state: "failed" }, null)).toMatch(/kunne ikke beregnes/);
  });

  it("names the best species, and the search when the list is narrowed", () => {
    expect(hereMetaText(ready(48, "Tragt-Kantarel"), null)).toBe(
      "Dagens forhold · bedst for Tragt-Kantarel",
    );
    expect(hereMetaText(ready(48, "Tragt-Kantarel"), 4)).toBe(
      "Bedst for Tragt-Kantarel blandt de 4 arter i din søgning",
    );
    expect(hereMetaText(ready(48, "Tragt-Kantarel"), 1)).toBe("Dagens forhold for Tragt-Kantarel");
  });

  it("has a short form for the folded card on a phone", () => {
    expect(hereMetaShort(ready(48, "Tragt-Kantarel"), null)).toBe("Bedst for Tragt-Kantarel");
    expect(hereMetaShort(ready(48, "Tragt-Kantarel"), 4)).toBe("Bedst for Tragt-Kantarel");
    expect(hereMetaShort(ready(48, "Tragt-Kantarel"), 1)).toBe("Tragt-Kantarel");
    expect(hereMetaShort(ready(0, "Tragt-Kantarel"), null)).toBe("Ingen gunstige forhold i dag");
    expect(hereMetaShort(ready(null, null), 2)).toBe("Intet forholdstal");
    expect(hereMetaShort({ state: "loading" }, null)).toBe("Beregner …");
    expect(hereMetaShort({ state: "offline" }, null)).toBe("Kan ikke beregnes");
    // every short form is short enough for one line beside the number at 360 px
    for (const text of [hereMetaShort(ready(0, "x"), null), hereMetaShort(ready(null, null), 1)]) {
      expect(text.length).toBeLessThanOrEqual(30);
    }
  });

  it("does not name a best species for a top score of 0", () => {
    expect(hereMetaText(ready(0, "Almindelig Kantarel"), null)).toBe(
      "Ingen af arterne har gunstige forhold her i dag.",
    );
    expect(hereMetaText(ready(0, "Almindelig Kantarel"), 4)).toBe(
      "Ingen af arterne i din søgning har gunstige forhold her i dag.",
    );
    expect(hereMetaText(ready(1, "Almindelig Kantarel"), null)).toMatch(/bedst for/);
  });

  it("explains a missing score", () => {
    expect(hereMetaText(ready(null, null), null)).toMatch(/Intet forholdstal/);
    expect(hereMetaText(ready(null, null), 3)).toMatch(/i din søgning/);
    // a search that matches no scored species at all is still a search
    expect(hereMetaText(ready(null, null), 0)).toBe(
      "Ingen af arterne i din søgning har et forholdstal her.",
    );
    expect(hereMetaText({ state: "offline" }, null)).toMatch(/lige nu/);
  });
});

describe("scoreKey", () => {
  const forest = { name: "Skov", lon: 10, lat: 56 };
  const day = new Date(2026, 9, 3, 8);

  it("is the same for the same forest, species and day, whatever the order", () => {
    expect(scoreKey(forest, new Set(["a", "b"]), day)).toBe(
      scoreKey(forest, new Set(["b", "a"]), new Date(2026, 9, 3, 22)),
    );
  });

  it("is about the position, to about a metre, not the name", () => {
    expect(scoreKey({ lon: 10.000001, lat: 56 }, new Set(["a"]), day)).toBe(
      scoreKey({ lon: 10, lat: 56.000002 }, new Set(["a"]), day),
    );
    expect(scoreKey({ lon: 10.001, lat: 56 }, new Set(["a"]), day)).not.toBe(
      scoreKey({ lon: 10, lat: 56 }, new Set(["a"]), day),
    );
  });

  it("differs for another place, species set or day", () => {
    const base = scoreKey(forest, new Set(["a", "b"]), day);
    expect(scoreKey({ ...forest, lon: 11 }, new Set(["a", "b"]), day)).not.toBe(base);
    expect(scoreKey(forest, new Set(["a"]), day)).not.toBe(base);
    expect(scoreKey(forest, new Set(["a", "b"]), new Date(2026, 9, 4))).not.toBe(base);
  });
});
