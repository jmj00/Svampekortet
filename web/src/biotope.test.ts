import { describe, expect, it } from "vitest";

import {
  buildBiotopeGrid,
  classifySite,
  describeSite,
  forestLabel,
  soilLabel,
  type BiotopeSiteRow,
} from "./biotope";
import type { BiotopeAffinity } from "./model";

describe("buildBiotopeGrid / classifySite", () => {
  const rows: BiotopeSiteRow[] = [
    { lon: 9.6, lat: 56.3, forest_type: "coniferous", soil_tsym: "ES" },
    { lon: 10.1, lat: 56.5, forest_type: null, soil_tsym: "ML" },
  ];

  it("classifies a point in a known cell", () => {
    const grid = buildBiotopeGrid(rows);
    expect(classifySite(grid, 9.6, 56.3)).toEqual({ forestType: "coniferous", soilTsym: "ES" });
    expect(classifySite(grid, 10.1, 56.5)).toEqual({ forestType: null, soilTsym: "ML" });
  });

  it("returns null far outside any classified cell", () => {
    const grid = buildBiotopeGrid(rows);
    expect(classifySite(grid, 20.0, 60.0)).toBeNull();
  });

  it("returns null for a cell classified as fully unclassified", () => {
    const grid = buildBiotopeGrid([{ lon: 5, lat: 50, forest_type: null, soil_tsym: null }]);
    expect(classifySite(grid, 5, 50)).toBeNull();
  });
});

describe("forestLabel / soilLabel", () => {
  it("translates known CORINE forest codes to Danish", () => {
    expect(forestLabel("coniferous")).toBe("Nåleskov");
    expect(forestLabel("broadleaf")).toBe("Løvskov");
    expect(forestLabel("mixed")).toBe("Blandskov");
  });

  it("translates known GEUS soil codes to Danish, from the layer's own legend", () => {
    expect(soilLabel("ML")).toBe("Moræneler");
    expect(soilLabel("ES")).toBe("Flyvesand");
    expect(soilLabel("SK")).toBe("Prækvartær aflejring"); // pre-Quaternary bedrock code
  });

  it("falls back to the raw code for anything unmapped", () => {
    expect(soilLabel("ZZZ")).toBe("ZZZ");
  });
});

describe("describeSite", () => {
  const affinity: BiotopeAffinity = {
    forest: { coniferous: 1.0, broadleaf: 10 / 30 },
    soil: { ES: 1.0 },
  };

  it("returns null when nothing is classified at the pin", () => {
    expect(describeSite(null, affinity)).toBeNull();
  });

  it("marks the species' peak category as typical", () => {
    const description = describeSite({ forestType: "coniferous", soilTsym: "ES" }, affinity);
    expect(description?.forest).toEqual({ label: "Nåleskov", typicality: "typical" });
    expect(description?.soil).toEqual({ label: "Flyvesand", typicality: "typical" });
  });

  it("marks a seen-but-uncommon category as 'seen', below the 0.5 typical threshold", () => {
    const description = describeSite({ forestType: "broadleaf", soilTsym: null }, affinity);
    expect(description?.forest).toEqual({ label: "Løvskov", typicality: "seen" });
    expect(description?.soil).toBeNull();
  });

  it("marks a never-seen category as unusual", () => {
    const description = describeSite({ forestType: "mixed", soilTsym: null }, affinity);
    expect(description?.forest?.typicality).toBe("unusual");
  });

  it("marks every category unknown when the species has no fitted distribution", () => {
    const description = describeSite({ forestType: "coniferous", soilTsym: "ES" }, null);
    expect(description?.forest?.typicality).toBe("unknown");
    expect(description?.soil?.typicality).toBe("unknown");
  });

  it("marks a category unknown when the affinity itself is empty (too few observations)", () => {
    const empty: BiotopeAffinity = { forest: {}, soil: {} };
    const description = describeSite({ forestType: "coniferous", soilTsym: "ES" }, empty);
    expect(description?.forest?.typicality).toBe("unknown");
  });
});
