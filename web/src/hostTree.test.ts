import { describe, expect, it } from "vitest";

import { buildHostTreeGrid, hostTreeScore, lookupHostTreeSite } from "./hostTree";

describe("buildHostTreeGrid / lookupHostTreeSite", () => {
  it("looks up a classified cell's per-tree probabilities", () => {
    const grid = buildHostTreeGrid([
      { lon: 9.6, lat: 56.3, pinus_sylvestris: 0.8, fagus_sylvatica: null },
    ]);
    expect(lookupHostTreeSite(grid, 9.6, 56.3)).toEqual({
      pinus_sylvestris: 0.8,
      fagus_sylvatica: null,
    });
  });

  it("returns null outside any classified cell", () => {
    const grid = buildHostTreeGrid([{ lon: 9.6, lat: 56.3, pinus_sylvestris: 0.8 }]);
    expect(lookupHostTreeSite(grid, 20.0, 60.0)).toBeNull();
  });
});

describe("hostTreeScore", () => {
  it("is neutral (1, unavailable) when the species has no fitted affinity", () => {
    expect(hostTreeScore(null, { pinus_sylvestris: 0.8 })).toEqual({ value: 1, available: false });
    expect(hostTreeScore({}, { pinus_sylvestris: 0.8 })).toEqual({ value: 1, available: false });
  });

  it("is neutral (1, unavailable) when the point falls outside the grid", () => {
    expect(hostTreeScore({ pinus_sylvestris: 0.9 }, null)).toEqual({
      value: 1,
      available: false,
    });
  });

  it("is a weighted average of the raw per-tree probabilities, weighted by affinity", () => {
    const affinity = { pinus_sylvestris: 0.9, fagus_sylvatica: 0.1 };
    const site = { pinus_sylvestris: 0.8, fagus_sylvatica: 0.2 };
    const expected = (0.9 * 0.8 + 0.1 * 0.2) / (0.9 + 0.1);
    expect(hostTreeScore(affinity, site)).toEqual({ value: expected, available: true });
  });

  it("drops a tree the affinity has no comparison for, without penalty", () => {
    const affinity = { pinus_sylvestris: 0.9, salix_caprea: 0.4 };
    // salix_caprea absent from the site entirely -- only pinus_sylvestris counts
    const site = { pinus_sylvestris: 0.6 };
    expect(hostTreeScore(affinity, site)).toEqual({ value: 0.6, available: true });
  });

  it("caps at 1.0", () => {
    const affinity = { pinus_sylvestris: 1 };
    const site = { pinus_sylvestris: 1 };
    expect(hostTreeScore(affinity, site)).toEqual({ value: 1, available: true });
  });
});
