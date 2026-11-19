import { describe, expect, it } from "vitest";

import { decodeShape, ForestOutlines, type ForestShape } from "./forestoutlines";
import {
  forestAt,
  forestsToDraw,
  forestsToScore,
  noForestsNote,
  scoreClass,
  scoreFeatures,
  type ScoredForest,
} from "./forestscores";
import { seasonWindowLabel } from "./maplegend";
import { forestRamp } from "./palette";
import { circleLine, ringBounds } from "./pinring";
import type { ForestPoint } from "./types";

/** A square forest of `size` degrees with its south-west corner at (lon, lat). */
function square(lon: number, lat: number, size: number): ForestShape {
  const scale = 100000;
  const s = Math.round(size * scale);
  const ring = [Math.round(lon * scale), Math.round(lat * scale), s, 0, 0, s, -s, 0, 0, -s];
  return decodeShape([[ring]], scale) as ForestShape;
}

function scored(
  index: number,
  score: number | null,
  shape: ForestShape,
  areaM2: number,
): ScoredForest {
  return { index, name: `Skov ${index}`, score, shape, areaM2 };
}

const FROMS = [0, 30, 60, 80];

describe("circleLine", () => {
  it("is a closed ring of the asked-for radius", () => {
    const line = circleLine([9.5, 56.1], 2, 36);
    const coords = line.geometry.coordinates;
    expect(coords).toHaveLength(37);
    expect(coords[0][0]).toBeCloseTo(coords[36][0], 9);
    expect(coords[0][1]).toBeCloseTo(coords[36][1], 9);
    // due east, then due north: both 2 km from the centre
    const eastKm = (coords[0][0] - 9.5) * 111.32 * Math.cos((56.1 * Math.PI) / 180);
    const northKm = (coords[9][1] - 56.1) * 110.574;
    expect(eastKm).toBeCloseTo(2, 6);
    expect(northKm).toBeCloseTo(2, 6);
  });

  it("fits in ringBounds", () => {
    const [[w, s], [e, n]] = ringBounds([9.5, 56.1], 2);
    for (const [lon, lat] of circleLine([9.5, 56.1], 2).geometry.coordinates) {
      expect(lon).toBeGreaterThanOrEqual(w - 1e-9);
      expect(lon).toBeLessThanOrEqual(e + 1e-9);
      expect(lat).toBeGreaterThanOrEqual(s - 1e-9);
      expect(lat).toBeLessThanOrEqual(n + 1e-9);
    }
  });
});

describe("forest ramp", () => {
  it("breaks at the panel's score bands (30, 60) and starts at 0", () => {
    const froms = forestRamp().classes.map((cls) => cls.from);
    expect(froms).toEqual(FROMS);
  });

  it("gets stronger with every class, and the lowest has no tint", () => {
    const classes = forestRamp().classes;
    const opacities = classes.map((cls) => cls.opacity);
    expect([...opacities].sort((a, b) => a - b)).toEqual(opacities);
    expect(classes[0].color).toBeNull();
    expect(classes.slice(1).every((cls) => cls.color !== null)).toBe(true);
  });
});

describe("scoreClass", () => {
  it("puts a score in the class whose range holds it", () => {
    expect([0, 29, 30, 59, 60, 79, 80, 100].map((score) => scoreClass(score, FROMS))).toEqual([
      0, 0, 1, 1, 2, 2, 3, 3,
    ]);
  });
});

describe("scoreFeatures", () => {
  const big = scored(1, 40, square(9, 56, 0.1), 5_000_000);
  const part = scored(2, 85, square(9.02, 56.02, 0.02), 200_000);
  const none = scored(3, null, square(9.3, 56, 0.02), 100_000);
  const zero = scored(4, 0, square(9.5, 56, 0.02), 100_000);

  it("draws the larger forest first, so a named part lies on top of it", () => {
    const { features } = scoreFeatures([part, big], FROMS);
    expect(features.map((f) => f.properties?.index)).toEqual([1, 2]);
    expect(features.map((f) => f.properties?.cls)).toEqual([1, 3]);
  });

  it("leaves out a forest without a score but keeps one that scored 0", () => {
    const { features } = scoreFeatures([none, zero], FROMS);
    expect(features).toHaveLength(1);
    expect(features[0].properties).toMatchObject({ index: 4, score: 0, cls: 0 });
  });
});

describe("forestsToDraw", () => {
  const shape = square(9, 56, 0.02);
  const mid = scored(1, 41, shape, 1);
  const low = scored(2, 12, shape, 1);
  const zero = scored(3, 0, shape, 1);
  const none = scored(4, null, shape, 1);

  it("leaves out forests that scored 0 or have no score", () => {
    expect(forestsToDraw([mid, low, zero, none], FROMS).map((f) => f.index)).toEqual([1, 2]);
  });

  it("draws nothing on a day when no forest reaches the second class", () => {
    expect(forestsToDraw([low, zero, none], FROMS)).toEqual([]);
    expect(forestsToDraw([scored(5, 29, shape, 1)], FROMS)).toEqual([]);
    expect(forestsToDraw([scored(6, 30, shape, 1), low], FROMS)).toHaveLength(2);
  });

  it("has a sentence for that day, and a few words for the closed key", () => {
    expect(noForestsNote("Tragt-Kantarel", 12)).toEqual({
      long: "Ingen skove inden for 10 km har middel eller gode forhold for Tragt-Kantarel i dag.",
      short: "ingen skove med middel/gode forhold",
    });
  });

  it("says only that there are no forests when none is in reach", () => {
    expect(noForestsNote("Tragt-Kantarel", 0)).toEqual({
      long: "Ingen skove inden for 10 km.",
      short: "ingen skove inden for 10 km",
    });
  });
});

describe("forestAt", () => {
  const big = scored(1, 40, square(9, 56, 0.1), 5_000_000);
  const part = scored(2, 85, square(9.02, 56.02, 0.02), 200_000);
  const unscored = scored(3, null, square(9.3, 56, 0.02), 100_000);

  it("is the smallest scored forest holding the point", () => {
    expect(forestAt([big, part], 9.03, 56.03)?.index).toBe(2);
    expect(forestAt([big, part], 9.08, 56.08)?.index).toBe(1);
  });

  it("is nothing outside every forest, or in one without a score", () => {
    expect(forestAt([big, part], 9.2, 56.2)).toBeNull();
    expect(forestAt([unscored], 9.31, 56.01)).toBeNull();
  });
});

describe("forestsToScore", () => {
  const points: ForestPoint[] = [
    { name: "Nær", lon: 9.01, lat: 56.01, area_m2: null },
    { name: "Længere", lon: 9.11, lat: 56.01, area_m2: null },
    { name: "Fjern", lon: 9.51, lat: 56.01, area_m2: null },
  ];
  const shapes = [square(9, 56, 0.02), square(9.1, 56, 0.02), square(9.5, 56, 0.02)];
  const outlines = {
    entries: () => shapes.map((shape, i) => [i, shape] as [number, ForestShape]).values(),
  } as unknown as ForestOutlines;

  it("takes the forests whose outline comes within reach, nearest first", () => {
    const near = forestsToScore(points, outlines, [9.01, 56.01]);
    expect(near.map((f) => f.index)).toEqual([0, 1]);
    expect(near[0].distanceKm).toBe(0);
  });

  it("stops at the limit, keeping the nearest", () => {
    expect(forestsToScore(points, outlines, [9.01, 56.01], 100, 1).map((f) => f.index)).toEqual([
      0,
    ]);
  });
});

describe("seasonWindowLabel", () => {
  it("names the months either side of the current one", () => {
    expect(seasonWindowLabel(11)).toBe("okt–dec");
    expect(seasonWindowLabel(6)).toBe("maj–jul");
  });

  it("wraps around the turn of the year", () => {
    expect(seasonWindowLabel(1)).toBe("dec–feb");
    expect(seasonWindowLabel(12)).toBe("nov–jan");
  });
});
