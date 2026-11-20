// Forest names on the map, from the app's own forest points (forests.json:
// Danske Stednavne's named forests, the same official names Skærmkort wrote
// across its forests). The OSM-based basemap has the forests but not their
// names. Bigger forests show from further out: one layer per size band, each
// with its own minimum zoom, and bigger ones win where names would collide.
// Drawn just under the basemap's place names, so towns still read on top.

import type maplibregl from "maplibre-gl";
import { BASEMAP_PREFIX, DARK, LIGHT } from "./basemapstyle";
import { prefersDark } from "./palette";
import type { ForestPoint } from "./types";

const SOURCE_ID = "forest-names";
const LAYER_PREFIX = "forest-name-";

/** [minimum area in m², min zoom, text size] -- largest first. */
const BANDS: [number, number, number][] = [
  [20_000_000, 8.5, 14],
  [4_000_000, 10, 13],
  [800_000, 11.5, 12],
  [150_000, 12.5, 11.5],
  [0, 13.5, 11],
];

const colors = (): { color: string; halo: string } => {
  const p = prefersDark() ? DARK : LIGHT;
  return { color: p.forestLabel, halo: p.halo };
};

function toGeoJSON(points: readonly ForestPoint[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: points.map((point) => ({
      type: "Feature",
      properties: { name: point.name, area: point.area_m2 ?? 0 },
      geometry: { type: "Point", coordinates: [point.lon, point.lat] },
    })),
  };
}

/** Add (or refresh) the forest names. The map's style must be loaded. */
export function showForestLabels(map: maplibregl.Map, points: readonly ForestPoint[]): void {
  if (points.length === 0) return;
  const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(toGeoJSON(points));
    return;
  }
  map.addSource(SOURCE_ID, { type: "geojson", data: toGeoJSON(points) });
  // Under the basemap's place names (the first of them), else on top.
  const layers = map.getStyle().layers ?? [];
  const before = layers.find((layer) => layer.id.startsWith(`${BASEMAP_PREFIX}place-`))?.id;
  const { color, halo } = colors();
  BANDS.forEach(([minArea, minzoom, size], index) => {
    const upper = index === 0 ? Infinity : BANDS[index - 1][0];
    map.addLayer(
      {
        id: `${LAYER_PREFIX}${index}`,
        type: "symbol",
        source: SOURCE_ID,
        minzoom,
        filter: [
          "all",
          [">=", ["get", "area"], minArea],
          ...(Number.isFinite(upper)
            ? [["<", ["get", "area"], upper] as maplibregl.ExpressionSpecification]
            : []),
        ],
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Italic"],
          "text-size": size,
          "text-letter-spacing": 0.06,
          "text-max-width": 7,
          "symbol-sort-key": ["-", ["get", "area"]],
        },
        paint: {
          "text-color": color,
          "text-halo-color": halo,
          "text-halo-width": 1.4,
          "text-halo-blur": 0.4,
        },
      },
      before,
    );
  });
}

/** Re-resolve the colours (the colour scheme flipped; map.ts restyleAll). */
export function restyleForestLabels(map: maplibregl.Map): void {
  const { color, halo } = colors();
  BANDS.forEach((_, index) => {
    const id = `${LAYER_PREFIX}${index}`;
    if (!map.getLayer(id)) return;
    map.setPaintProperty(id, "text-color", color);
    map.setPaintProperty(id, "text-halo-color", halo);
  });
}
