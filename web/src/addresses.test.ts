import { describe, expect, it } from "vitest";

import { utm32nToWgs84 } from "./addresses";

describe("utm32nToWgs84", () => {
  it("matches a known Adressevælgeren lookup (Rold Skovvej 10, 8700 Horsens)", () => {
    const [lon, lat] = utm32nToWgs84(556004.23, 6186277.17);
    expect(lon).toBeCloseTo(9.8938, 3);
    expect(lat).toBeCloseTo(55.8188, 3);
  });

  it("stays within the Denmark bounding box for a central-Jutland point", () => {
    // Roughly Silkeborg
    const [lon, lat] = utm32nToWgs84(540000, 6221000);
    expect(lon).toBeGreaterThan(8.0);
    expect(lon).toBeLessThan(15.3);
    expect(lat).toBeGreaterThan(54.5);
    expect(lat).toBeLessThan(57.9);
  });
});
