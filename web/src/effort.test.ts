import { describe, expect, it } from "vitest";

import { buildEffortGrid, lookupEffort } from "./effort";

describe("buildEffortGrid / lookupEffort", () => {
  it("looks up a cell's background record count", () => {
    const grid = buildEffortGrid([{ lon: 9.6, lat: 56.3, n: 42 }]);
    expect(lookupEffort(grid, 9.6, 56.3)).toBe(42);
  });

  it("defaults to 0 when the cell was never recorded at all", () => {
    const grid = buildEffortGrid([{ lon: 9.6, lat: 56.3, n: 42 }]);
    expect(lookupEffort(grid, 20.0, 60.0)).toBe(0);
  });
});
