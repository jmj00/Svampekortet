import { describe, expect, it, vi } from "vitest";
import {
  ForestOutlines,
  bboxDistanceKm,
  decodeRing,
  decodeShape,
  distanceToRingKm,
  distanceToShapeKm,
  pointInRing,
  pointInShape,
  shapeAreaM2,
  shapeToGeoJSON,
  type ForestShape,
  type OutlineFileDoc,
  type OutlineFileRef,
} from "./forestoutlines";
import {
  PIN_EDGE_MARGIN_KM,
  PIN_FOREST_KM,
  closestForest,
  forestAtPin,
  pinForest,
} from "./forests";
import type { ForestPoint } from "./types";

const SCALE = 100000;

/** A delta-coded rectangle, as the pipeline writes it (closing point left out). */
function rect(west: number, south: number, east: number, north: number): number[] {
  const w = Math.round(west * SCALE);
  const s = Math.round(south * SCALE);
  const e = Math.round(east * SCALE);
  const n = Math.round(north * SCALE);
  return [w, s, e - w, 0, 0, n - s, w - e, 0];
}

// At 56 N: 0.016 degrees of longitude and 0.009 of latitude are each about 1 km.
const BIG = rect(10.0, 56.0, 10.064, 56.036); // about 4 km x 4 km
const PART = rect(10.016, 56.009, 10.032, 56.018); // about 1 km x 1 km, inside BIG
const HOLE = rect(10.04, 56.02, 10.056, 56.029); // a clearing in BIG
const FAR = rect(10.2, 56.0, 10.216, 56.009);

const points: ForestPoint[] = [
  { name: "Storskov", lon: 10.01, lat: 56.004, area_m2: 16_000_000 },
  { name: "Lilleskov", lon: 10.024, lat: 56.0135, area_m2: 1_000_000 },
  { name: "Fjernskov", lon: 10.208, lat: 56.0045, area_m2: 1_000_000 },
];

const REF: OutlineFileRef = {
  file: "forest-outlines-0.json",
  start: 0,
  count: 3,
  bbox: [10, 56, 10.216, 56.036],
};
const DOC: OutlineFileDoc = {
  version: 1,
  scale: SCALE,
  start: 0,
  count: 3,
  forests: [[[BIG, HOLE]], [[PART]], [[FAR]]],
};

function loaded(doc: OutlineFileDoc = DOC, ref: OutlineFileRef = REF): ForestOutlines {
  const outlines = new ForestOutlines([ref], () =>
    Promise.reject(new Error("not fetched in tests")),
  );
  outlines.add(doc, ref);
  // mark the band as loaded the way request() does
  (outlines as unknown as { bands: { state: string }[] }).bands[0].state = "loaded";
  return outlines;
}

const shapeOf = (ring: number[], ...holes: number[][]): ForestShape =>
  decodeShape([[ring, ...holes]], SCALE) as ForestShape;

describe("decoding", () => {
  it("turns delta-coded integers into a closed ring of degrees", () => {
    expect(decodeRing(rect(10, 56, 10.016, 56.009), SCALE)).toEqual([
      10, 56, 10.016, 56, 10.016, 56.009, 10, 56.009, 10, 56,
    ]);
  });

  it("gives a shape its bounding box and drops rings that are not polygons", () => {
    const shape = decodeShape([[BIG, [1, 2, 3, 4]]], SCALE) as ForestShape;
    expect(shape.bbox).toEqual([10, 56, 10.064, 56.036]);
    expect(shape.polygons[0]).toHaveLength(1); // the two-corner "hole" is gone
    expect(decodeShape([[[1, 2]]], SCALE)).toBeNull();
  });

  it("writes GeoJSON in [lon, lat] order with holes kept", () => {
    const geometry = shapeToGeoJSON(shapeOf(BIG, HOLE));
    expect(geometry.type).toBe("MultiPolygon");
    expect(geometry.coordinates[0]).toHaveLength(2);
    expect(geometry.coordinates[0][0][0]).toEqual([10, 56]);
    expect(geometry.coordinates[0][0]).toHaveLength(5); // closed
  });
});

describe("point in forest", () => {
  const big = shapeOf(BIG, HOLE);

  it("is true inside the outer ring and false outside it", () => {
    expect(pointInRing(10.03, 56.01, decodeRing(BIG, SCALE))).toBe(true);
    expect(pointInRing(10.07, 56.01, decodeRing(BIG, SCALE))).toBe(false);
    expect(pointInShape(10.03, 56.01, big)).toBe(true);
    expect(pointInShape(9.99, 56.01, big)).toBe(false);
    expect(pointInShape(10.03, 56.04, big)).toBe(false);
  });

  it("is false in a hole", () => {
    expect(pointInShape(10.048, 56.0245, big)).toBe(false);
  });

  it("handles a concave outline", () => {
    // an "L": the notch at the top right is outside
    const l = decodeShape(
      [[[1000000, 5600000, 3200, 0, 0, 900, -1600, 0, 0, 900, -1600, 0]]],
      SCALE,
    ) as ForestShape;
    expect(pointInShape(10.008, 56.0135, l)).toBe(true); // the upright
    expect(pointInShape(10.024, 56.0045, l)).toBe(true); // the foot
    expect(pointInShape(10.024, 56.0135, l)).toBe(false); // the notch
  });
});

describe("distance to the edge", () => {
  const big = shapeOf(BIG, HOLE);

  it("is zero inside and the distance to the nearest edge outside", () => {
    expect(distanceToShapeKm(10.03, 56.01, big)).toBe(0);
    // 0.001 degrees of latitude south of the southern edge: about 110 m
    expect(distanceToShapeKm(10.03, 55.999, big)).toBeCloseTo(0.1105, 3);
    // 0.002 degrees of longitude east of the eastern edge: about 124 m at 56 N
    expect(distanceToShapeKm(10.066, 56.01, big)).toBeCloseTo(0.1245, 3);
  });

  it("measures to a corner when that is nearest", () => {
    const ring = decodeRing(BIG, SCALE);
    const d = distanceToRingKm(9.998, 55.999, ring);
    expect(d).toBeCloseTo(
      Math.hypot(0.002 * 111.32 * Math.cos((55.999 * Math.PI) / 180), 0.1105),
      3,
    );
  });

  it("counts a clearing's edge: standing in a hole is being beside the forest", () => {
    // 0.0005 degrees of latitude inside the hole's southern edge: about 55 m
    expect(distanceToShapeKm(10.048, 56.0205, big)).toBeCloseTo(0.0553, 3);
  });

  it("never reports the box as further away than the edge", () => {
    for (const [lon, lat] of [
      [10.2, 56.2],
      [9.9, 56.01],
      [10.03, 55.9],
    ]) {
      expect(bboxDistanceKm(lon, lat, big)).toBeLessThanOrEqual(distanceToShapeKm(lon, lat, big));
    }
    expect(bboxDistanceKm(10.03, 56.01, big)).toBe(0);
  });

  it("works out an area when the register gives none", () => {
    expect(shapeAreaM2(shapeOf(PART))).toBeGreaterThan(950_000);
    expect(shapeAreaM2(shapeOf(PART))).toBeLessThan(1_050_000);
    expect(shapeAreaM2(shapeOf(BIG, HOLE))).toBeLessThan(shapeAreaM2(shapeOf(BIG)));
  });
});

describe("forestAtPin with outlines", () => {
  const outlines = loaded();

  it("names the forest the pin is inside, however far from its point", () => {
    // the far corner of Storskov: about 4.6 km from its point, far beyond the old 1.5 km
    const forest = forestAtPin(points, 10.06, 56.034, outlines);
    expect(forest?.name).toBe("Storskov");
    expect(forest?.inside).toBe(true);
    expect(forest?.distanceKm).toBe(0);
    expect(forest?.index).toBe(0);
    expect(forestAtPin(points, 10.06, 56.034)?.name).toBeUndefined(); // the old rule missed it
  });

  it("prefers the named part inside a larger forest", () => {
    expect(forestAtPin(points, 10.024, 56.0135, outlines)?.name).toBe("Lilleskov");
    // just outside the part, still inside the large forest
    expect(forestAtPin(points, 10.034, 56.0135, outlines)?.name).toBe("Storskov");
  });

  it("works out the smaller area itself when the register has none", () => {
    const noAreas = points.map((p) => ({ ...p, area_m2: null }));
    expect(forestAtPin(noAreas, 10.024, 56.0135, outlines)?.name).toBe("Lilleskov");
  });

  it("takes a pin just outside an edge, within the margin, as beside the forest", () => {
    // about 55 m south of Storskov's southern edge
    const near = forestAtPin(points, 10.03, 55.9995, outlines);
    expect(near?.name).toBe("Storskov");
    expect(near?.inside).toBe(false);
    expect(near?.distanceKm).toBeGreaterThan(0.04);
    expect(near?.distanceKm).toBeLessThan(PIN_EDGE_MARGIN_KM);
  });

  it("names no forest beyond the margin, even close to a forest's point", () => {
    // about 220 m south of the edge, 0.7 km from Storskov's point: the old rule said yes
    expect(forestAtPin(points, 10.012, 55.998, outlines)).toBeNull();
    expect(forestAtPin(points, 10.012, 55.998)?.name).toBe("Storskov");
  });

  it("treats a pin in a clearing as beside the forest only near the clearing's edge", () => {
    expect(forestAtPin(points, 10.048, 56.0205, outlines)?.inside).toBe(false); // 55 m in
    expect(forestAtPin(points, 10.048, 56.0245, outlines)).toBeNull(); // the middle, 500 m in
  });

  it("picks the nearest edge when two forests are within the margin", () => {
    const twoRef = { ...REF, count: 2 };
    const two = loaded(
      {
        ...DOC,
        count: 2,
        forests: [[[rect(10, 56, 10.016, 56.009)]], [[rect(10.0175, 56, 10.0335, 56.009)]]],
      },
      twoRef,
    );
    const pair: ForestPoint[] = [
      { name: "Vest", lon: 10.008, lat: 56.0045, area_m2: 1 },
      { name: "Øst", lon: 10.0255, lat: 56.0045, area_m2: 1 },
    ];
    expect(forestAtPin(pair, 10.0163, 56.004, two)?.name).toBe("Vest");
    expect(forestAtPin(pair, 10.0171, 56.004, two)?.name).toBe("Øst");
  });
});

describe("a forest chosen by name, and the forest around a part", () => {
  const outlines = loaded();

  it("names the larger forest a named part lies in", () => {
    const part = forestAtPin(points, 10.024, 56.0135, outlines);
    expect(part?.name).toBe("Lilleskov");
    expect(part?.partOf).toEqual({ name: "Storskov", index: 0 });
    // in the large forest itself there is nothing around it
    expect(forestAtPin(points, 10.05, 56.005, outlines)?.partOf).toBeUndefined();
  });

  it("picks the largest when several forests lie around the part", () => {
    const huge = rect(9.9, 55.9, 10.2, 56.1);
    const ref = {
      ...REF,
      count: 3,
      bbox: [9.9, 55.9, 10.2, 56.1] as [number, number, number, number],
    };
    const three = loaded({ ...DOC, forests: [[[BIG]], [[PART]], [[huge]]] }, ref);
    const pts: ForestPoint[] = [
      points[0],
      points[1],
      { name: "Kæmpeskov", lon: 9.95, lat: 55.95, area_m2: 400_000_000 },
    ];
    expect(forestAtPin(pts, 10.024, 56.0135, three)?.partOf?.name).toBe("Kæmpeskov");
  });

  it("keeps a forest chosen by name, though a smaller forest lies at its point", () => {
    // Storskov's published point put inside Lilleskov: only choosing Storskov
    // by name lands a pin exactly there
    const nested: ForestPoint[] = [{ ...points[0], lon: 10.02, lat: 56.012 }, points[1], points[2]];
    const chosen = forestAtPin(nested, 10.02, 56.012, outlines);
    expect(chosen).toMatchObject({ name: "Storskov", chosen: true, inside: true });
    expect(chosen?.partOf).toBeUndefined(); // it is the largest forest there
    // a metre away is a tap on the map, not a choice: the smaller forest again
    const tapped = forestAtPin(nested, 10.02002, 56.012, outlines);
    expect(tapped).toMatchObject({ name: "Lilleskov" });
    expect(tapped?.chosen).toBeUndefined();
  });

  it("marks the smallest forest as chosen too when the pin is on its own point", () => {
    expect(forestAtPin(points, points[1].lon, points[1].lat, outlines)).toMatchObject({
      name: "Lilleskov",
      chosen: true,
      partOf: { name: "Storskov", index: 0 },
    });
  });

  it("does not take a point match on trust when the outline does not hold the pin", () => {
    // a published point that lies outside its own outline (bad data): the rule
    // falls through to what the outlines say
    const stray: ForestPoint[] = [{ ...points[0], lon: 10.3, lat: 56.3 }, points[1], points[2]];
    expect(forestAtPin(stray, 10.3, 56.3, loaded())).toBeNull();
  });
});

describe("fallback without outlines", () => {
  it("uses the forest points when no outlines are published", () => {
    expect(forestAtPin(points, 10.012, 55.998, null)?.name).toBe("Storskov");
    expect(forestAtPin(points, 10.06, 56.034, null)).toBeNull(); // further than PIN_FOREST_KM
    expect(PIN_FOREST_KM).toBe(1.5);
  });

  it("uses the forest points when the band for the spot is not loaded", () => {
    const empty = new ForestOutlines([REF], () => new Promise(() => {}));
    expect(empty.cover(10.012, 55.998)).toBe("none"); // never asked for
    expect(forestAtPin(points, 10.012, 55.998, empty)?.name).toBe("Storskov");
  });

  it("is ready, with no forest, outside every band", () => {
    const outlines = loaded();
    expect(outlines.cover(12, 55)).toBe("ready");
    expect(forestAtPin(points, 12, 55, outlines)).toBeNull();
  });
});

describe("closestForest", () => {
  it("measures to the edge where the outline is loaded, to the point otherwise", () => {
    const outlines = loaded();
    // 1 km east of Storskov's eastern edge (about 4.4 km from its point)
    const byEdge = closestForest(points, 10.08, 56.01, 30, outlines);
    expect(byEdge?.name).toBe("Storskov");
    expect(byEdge?.distanceKm).toBeGreaterThan(0.9);
    expect(byEdge?.distanceKm).toBeLessThan(1.1);
    const byPoint = closestForest(points, 10.08, 56.01, 30);
    expect(byPoint?.name).toBe("Lilleskov"); // its point happens to be nearer
    expect(byPoint?.distanceKm).toBeGreaterThan(3);
  });

  it("returns null when nothing is within reach", () => {
    expect(closestForest(points, 12, 55, 30, loaded())).toBeNull();
  });
});

describe("ForestOutlines store", () => {
  const twoBands: OutlineFileRef[] = [
    { file: "a.json", start: 0, count: 2, bbox: [10, 56, 10.064, 56.036] },
    { file: "b.json", start: 2, count: 1, bbox: [10.2, 56, 10.216, 56.009] },
  ];
  const docA: OutlineFileDoc = {
    version: 1,
    scale: SCALE,
    start: 0,
    count: 2,
    forests: [[[BIG]], [[PART]]],
  };
  const docB: OutlineFileDoc = { version: 1, scale: SCALE, start: 2, count: 1, forests: [[[FAR]]] };

  it("fetches only the band a spot needs and reports when it has arrived", async () => {
    const fetched: string[] = [];
    const onChange = vi.fn();
    const outlines = new ForestOutlines(
      twoBands,
      (file) => {
        fetched.push(file);
        return Promise.resolve(file === "a.json" ? docA : docB);
      },
      onChange,
    );
    outlines.request(10.03, 56.01);
    expect(fetched).toEqual(["a.json"]);
    expect(outlines.cover(10.03, 56.01)).toBe("pending");
    expect(pinForest(points, 10.03, 56.01, outlines)).toBe("pending");
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(outlines.cover(10.03, 56.01)).toBe("ready");
    expect(pinForest(points, 10.05, 56.005, outlines)).toMatchObject({
      name: "Storskov",
      inside: true,
    });
    expect(outlines.shape(0)?.bbox).toEqual([10, 56, 10.064, 56.036]);
    expect(outlines.shape(2)).toBeNull(); // the other band was never needed
    outlines.request(10.03, 56.01); // already loaded: not fetched again
    expect(fetched).toEqual(["a.json"]);
  });

  it("falls back, and tries again later, when a band cannot be fetched", async () => {
    let fail = true;
    const onChange = vi.fn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const outlines = new ForestOutlines(
      twoBands,
      () => (fail ? Promise.reject(new Error("offline")) : Promise.resolve(docA)),
      onChange,
      10_000,
      5,
    );
    outlines.request(10.03, 56.01);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(outlines.cover(10.03, 56.01)).toBe("none");
    expect(pinForest(points, 10.012, 55.998, outlines)).toMatchObject({ name: "Storskov" }); // by its point
    fail = false;
    outlines.request(10.03, 56.01);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(outlines.cover(10.03, 56.01)).toBe("ready");
    errors.mockRestore();
  });

  it("rides out one failed fetch without reporting anything", async () => {
    let calls = 0;
    const onChange = vi.fn();
    const outlines = new ForestOutlines(
      twoBands,
      () => (++calls === 1 ? Promise.reject(new Error("blip")) : Promise.resolve(docA)),
      onChange,
      10_000,
      5,
    );
    outlines.request(10.03, 56.01);
    await vi.waitFor(() => expect(outlines.cover(10.03, 56.01)).toBe("ready"));
    expect(calls).toBe(2);
    expect(onChange).toHaveBeenCalledTimes(1); // once, with the outlines in
  });

  it("refuses a file that does not match the manifest", async () => {
    const onChange = vi.fn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const outlines = new ForestOutlines(twoBands, () => Promise.resolve(docB), onChange);
    outlines.request(10.03, 56.01); // asks for a.json, gets b's content
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(outlines.cover(10.03, 56.01)).toBe("none");
    expect(outlines.shape(0)).toBeNull();
    errors.mockRestore();
  });

  it("keeps a spot pending for as long as its band is on its way", async () => {
    let deliver: (doc: OutlineFileDoc) => void = () => {};
    const onChange = vi.fn();
    const outlines = new ForestOutlines(
      twoBands,
      () => new Promise<OutlineFileDoc>((resolve) => (deliver = resolve)),
      onChange,
    );
    outlines.request(10.03, 56.01);
    // however long it takes: no falling back to the forest points meanwhile
    expect(outlines.cover(10.03, 56.01)).toBe("pending");
    expect(pinForest(points, 10.012, 55.998, outlines)).toBe("pending");
    deliver(docA);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(outlines.cover(10.03, 56.01)).toBe("ready");
  });

  it("gives up on a request that never answers, and tries again for the next pin", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    let answer: (doc: OutlineFileDoc) => void = () => {};
    const onChange = vi.fn();
    const outlines = new ForestOutlines(
      twoBands,
      () => {
        calls++;
        return new Promise<OutlineFileDoc>((resolve) => (answer = resolve));
      },
      onChange,
      10_000,
    );
    outlines.request(10.03, 56.01);
    vi.advanceTimersByTime(9_999);
    expect(outlines.cover(10.03, 56.01)).toBe("pending");
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    // the clock has run out: the file counts as failed, the forest points decide
    expect(outlines.cover(10.03, 56.01)).toBe("none");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(pinForest(points, 10.012, 55.998, outlines)).toMatchObject({ name: "Storskov" });
    // an answer that turns up after that is dropped, not half-applied
    const late = answer;
    late(docA);
    await vi.advanceTimersByTimeAsync(0);
    expect(outlines.cover(10.03, 56.01)).toBe("none");
    expect(outlines.shape(0)).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    // the next pin there asks again, and this time it answers
    outlines.request(10.03, 56.01);
    expect(calls).toBe(2);
    answer(docA);
    await vi.advanceTimersByTimeAsync(0);
    expect(outlines.cover(10.03, 56.01)).toBe("ready");
    errors.mockRestore();
    vi.useRealTimers();
  });

  it("fetches the bands under the area in view, ahead of a pin", async () => {
    const fetched: string[] = [];
    const outlines = new ForestOutlines(twoBands, (file) => {
      fetched.push(file);
      return Promise.resolve(file === "a.json" ? docA : docB);
    });
    expect(outlines.requested()).toBe(0);
    outlines.requestArea(11, 56, 12, 57); // no band reaches in here
    expect(fetched).toEqual([]);
    outlines.requestArea(10.05, 55.9, 10.1, 56.1); // the west band only
    expect(fetched).toEqual(["a.json"]);
    outlines.requestArea(9, 55, 11, 57); // both; the first is not fetched twice
    expect(fetched).toEqual(["a.json", "b.json"]);
    expect(outlines.requested()).toBe(2);
    await vi.waitFor(() => expect(outlines.cover(10.03, 56.01)).toBe("ready"));
    expect(pinForest(points, 10.05, 56.005, outlines)).toMatchObject({ name: "Storskov" });
  });

  it("does not retry a failed band for the view, only for a pin", async () => {
    let calls = 0;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const onChange = vi.fn();
    const outlines = new ForestOutlines(
      twoBands,
      () => {
        calls++;
        return Promise.reject(new Error("offline"));
      },
      onChange,
      10_000,
      5,
    );
    outlines.requestArea(10, 56, 10.05, 56.02);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(calls).toBe(2); // tried once more before it counted as failed
    outlines.requestArea(10, 56, 10.05, 56.02);
    expect(calls).toBe(2);
    outlines.request(10.03, 56.01);
    expect(calls).toBe(3);
    errors.mockRestore();
  });

  it("refuses a file from another publish than the manifest's", async () => {
    const stamped = twoBands.map((ref) => ({ ...ref, stamp: "aaaaaaaaaaaa" }));
    const onChange = vi.fn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const outlines = new ForestOutlines(
      stamped,
      () => Promise.resolve({ ...docA, stamp: "bbbbbbbbbbbb" }),
      onChange,
    );
    outlines.request(10.03, 56.01);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(outlines.cover(10.03, 56.01)).toBe("none"); // falls back to the forest points
    expect(outlines.shape(0)).toBeNull();
    errors.mockRestore();

    const matching = new ForestOutlines(stamped, () => Promise.reject(new Error("unused")));
    matching.add({ ...docA, stamp: "aaaaaaaaaaaa" }, stamped[0]);
    expect(matching.shape(0)).not.toBeNull();
  });

  it("has nothing to offer for a payload without outlines", () => {
    const outlines = new ForestOutlines([], () => Promise.reject(new Error("unused")));
    expect(outlines.cover(10.03, 56.01)).toBe("none");
  });
});
