import { describe, expect, it } from "vitest";

import { chooseCardAnchor, framingForNearest, inSeason, planSpecies } from "./observations";
import { MAX_COLOURED_SPECIES, speciesColor } from "./palette";
import type { ObservationPoint } from "./types";

const near: ObservationPoint = [9.5, 56.2, 8];
const far: ObservationPoint = [12.5, 55.7, 9];
const farther: ObservationPoint = [15.2, 55.1, 9];

describe("framingForNearest", () => {
  const view = (contains: boolean) => ({
    center: [9.4, 56.1] as [number, number],
    zoom: 13,
    contains: () => contains,
  });

  it("leaves the camera alone when a find is already on screen", () => {
    expect(framingForNearest(view(true), [near, far])).toBeNull();
  });

  it("leaves the camera alone when the species has no finds", () => {
    expect(framingForNearest(view(false), [])).toBeNull();
  });

  it("frames the current centre together with the nearest find", () => {
    const framing = framingForNearest(view(false), [far, near, farther]);
    expect(framing).not.toBeNull();
    expect(framing?.bounds).toEqual([
      [9.4, 56.1],
      [9.5, 56.2],
    ]);
  });

  it("never zooms in past the current zoom", () => {
    expect(framingForNearest(view(false), [far])?.maxZoom).toBe(13);
  });
});

describe("framingForNearest distance", () => {
  it("measures nearness on the ground, not in raw degrees", () => {
    // 0.5 degrees east is ~31 km at 56N; 0.4 degrees north is ~44 km.
    const east: ObservationPoint = [10.0, 56.0, 9];
    const north: ObservationPoint = [9.5, 56.4, 9];
    const framing = framingForNearest({ center: [9.5, 56.0], zoom: 10, contains: () => false }, [
      north,
      east,
    ]);
    expect(framing?.bounds[1]).toEqual([10.0, 56.0]);
  });
});

describe("inSeason", () => {
  it("counts the current month and its neighbours", () => {
    expect(inSeason(10, 11)).toBe(true);
    expect(inSeason(11, 11)).toBe(true);
    expect(inSeason(12, 11)).toBe(true);
    expect(inSeason(9, 11)).toBe(false);
    expect(inSeason(1, 11)).toBe(false);
  });

  it("wraps around the turn of the year", () => {
    expect(inSeason(12, 1)).toBe(true);
    expect(inSeason(1, 12)).toBe(true);
    expect(inSeason(2, 12)).toBe(false);
    expect(inSeason(11, 1)).toBe(false);
  });
});

describe("planSpecies", () => {
  const doc = (name: string, finds: number) => ({
    danish_name: name,
    observations: new Array<unknown>(finds).fill(0),
  });

  it("leaves out species without finds but keeps the others' colour index", () => {
    const plan = planSpecies([doc("A", 3), doc("B", 0), doc("C", 1)], "#f0f");
    expect(plan.mode).toBe("species");
    expect(plan.shown).toEqual([0, 2]);
    expect(plan.species).toEqual([
      { name: "A", color: speciesColor(0) },
      { name: "C", color: speciesColor(2) },
    ]);
  });

  it("colours per species up to the limit, counting only species with finds", () => {
    const docs = Array.from({ length: MAX_COLOURED_SPECIES }, (_, i) => doc(`S${i}`, 1));
    expect(planSpecies([...docs, doc("empty", 0)], "#f0f").mode).toBe("species");
  });

  it("switches to one colour beyond the limit, never cycling the palette", () => {
    const docs = Array.from({ length: MAX_COLOURED_SPECIES + 1 }, (_, i) => doc(`S${i}`, 1));
    const plan = planSpecies(docs, "#f0f");
    expect(plan.mode).toBe("many");
    expect(new Set(plan.species.map((s) => s.color))).toEqual(new Set(["#f0f"]));
  });
});

describe("chooseCardAnchor", () => {
  const free = { left: 8, top: 105, right: 382, bottom: 461 };
  const card = { width: 220, height: 150 };

  it("puts the card above the pin when there is room", () => {
    expect(chooseCardAnchor({ x: 195, y: 400 }, card, free)).toBe("bottom");
  });

  it("puts it below the pin when the top of the free map is too close", () => {
    expect(chooseCardAnchor({ x: 195, y: 180 }, card, free)).toBe("top");
  });

  it("hangs it to the inside near a side edge", () => {
    expect(chooseCardAnchor({ x: 40, y: 400 }, card, free)).toBe("bottom-left");
    expect(chooseCardAnchor({ x: 360, y: 180 }, card, free)).toBe("top-right");
  });

  it("takes the roomier side when neither fits", () => {
    const tall = { width: 220, height: 400 };
    expect(chooseCardAnchor({ x: 195, y: 420 }, tall, free)).toBe("bottom");
    expect(chooseCardAnchor({ x: 195, y: 150 }, tall, free)).toBe("top");
  });
});
