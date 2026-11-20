import { describe, expect, it } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import {
  BASEMAP_ID,
  BASEMAP_PREFIX,
  DARK,
  GLYPHS,
  LIGHT,
  VECTOR_SOURCE,
  VECTOR_SOURCE_ID,
  basemapLayers,
} from "./basemapstyle";

// An invalid style does not throw: MapLibre just never finishes loading it.
describe("basemap style", () => {
  for (const [name, palette] of [
    ["light", LIGHT],
    ["dark", DARK],
  ] as const) {
    it(`is a valid style (${name})`, () => {
      const errors = validateStyleMin({
        version: 8,
        glyphs: GLYPHS,
        sources: { [VECTOR_SOURCE_ID]: VECTOR_SOURCE },
        layers: [
          { id: "backdrop", type: "background", paint: { "background-color": palette.land } },
          ...basemapLayers(palette),
        ],
      });
      expect(errors.map((e) => e.message)).toEqual([]);
    });
  }

  it("has the marker between the ground and the roads", () => {
    const ids = basemapLayers(LIGHT).map((layer) => layer.id);
    const marker = ids.indexOf(BASEMAP_ID);
    expect(marker).toBeGreaterThan(ids.indexOf(`${BASEMAP_PREFIX}wood`));
    expect(marker).toBeLessThan(ids.indexOf(`${BASEMAP_PREFIX}road-minor`));
    expect(ids.filter((id) => id !== BASEMAP_ID).every((id) => id.startsWith(BASEMAP_PREFIX))).toBe(
      true,
    );
  });
});
