import { describe, expect, it } from "vitest";
import { pickTagSide, spreadPoints } from "./forestmarkers";
import { compassDa, nearestForests } from "./forests";

describe("compassDa", () => {
  it("names the eight directions as Danish words", () => {
    expect(compassDa(10, 56, 10, 57)).toBe("nord");
    expect(compassDa(10, 56, 11, 56)).toBe("øst");
    expect(compassDa(10, 56, 10, 55)).toBe("syd");
    expect(compassDa(10, 56, 9, 56)).toBe("vest");
    expect(compassDa(10, 56, 10.5, 56.28)).toBe("nordøst");
    expect(compassDa(10, 56, 9.5, 55.72)).toBe("sydvest");
  });
});

describe("nearestForests", () => {
  it("keeps forests inside the radius, nearest first", () => {
    const points = [
      { name: "far", lon: 10.5, lat: 56, area_m2: 5 },
      { name: "near", lon: 10.01, lat: 56, area_m2: 7 },
      { name: "outside", lon: 12, lat: 56, area_m2: null },
    ];
    expect(nearestForests(points, 10, 56, 40).map((f) => f.name)).toEqual(["near", "far"]);
  });
});

describe("pickTagSide", () => {
  it("puts the tag below when nothing is in the way", () => {
    expect(pickTagSide(0, [{ x: 200, y: 200 }], 90, 400)).toBe("below");
  });

  it("moves the tag off a neighbour that sits under the marker", () => {
    const placed = [
      { x: 200, y: 200 },
      { x: 205, y: 230 },
    ];
    expect(pickTagSide(0, placed, 90, 400)).toBe("above");
  });

  it("avoids blocked boxes such as the pin, and the map's edge", () => {
    const pin = { left: 185, right: 215, top: 150, bottom: 190 };
    const placed = [
      { x: 200, y: 200 },
      { x: 205, y: 230 },
    ];
    expect(pickTagSide(0, placed, 90, 400, [pin])).toBe("right");
    expect(pickTagSide(0, placed, 90, 300, [pin])).toBe("left");
  });
});

describe("spreadPoints", () => {
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  it("leaves markers that do not touch where they are", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    expect(spreadPoints(points, [], 30)).toEqual(points);
  });

  it("separates a cluster and keeps the first marker in place", () => {
    const points = [
      { x: 50, y: 50 },
      { x: 52, y: 51 },
      { x: 50, y: 50 },
      { x: 60, y: 44 },
      { x: 47, y: 58 },
    ];
    const placed = spreadPoints(points, [], 30);
    expect(placed[0]).toEqual(points[0]);
    for (let i = 0; i < placed.length; i++) {
      for (let j = 0; j < i; j++) {
        expect(distance(placed[i], placed[j])).toBeGreaterThanOrEqual(29);
      }
    }
  });

  it("moves every marker, the first included, clear of an obstacle", () => {
    const obstacle = { x: 50, y: 30, radius: 21 };
    const placed = spreadPoints(
      [
        { x: 50, y: 50 },
        { x: 50, y: 28 },
      ],
      [obstacle],
      30,
    );
    for (const p of placed) expect(distance(p, obstacle)).toBeGreaterThanOrEqual(35);
    expect(distance(placed[0], placed[1])).toBeGreaterThanOrEqual(29);
  });
});
