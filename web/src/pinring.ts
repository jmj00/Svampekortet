// The dashed ring around the pin: how far away finds count towards the score
// of the open species (the model's bandwidth). Drawn under the find marks.

import type maplibregl from "maplibre-gl";
import { legendFor } from "./maplegend";
import { mapColors } from "./palette";

const SOURCE_ID = "pin-radius";
const LAYER_ID = "pin-radius-line";
const OBSERVATION_LAYERS = ["observations-heat", "observations-circles"];

/** A circle as a closed line (flat-earth maths; fine at a few km). */
export function circleLine(
  [lon, lat]: [number, number],
  radiusKm: number,
  steps = 72,
): GeoJSON.Feature<GeoJSON.LineString> {
  const dLat = radiusKm / 110.574;
  const dLon = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const coordinates: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    coordinates.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } };
}

/** The box a ring of `radiusKm` around `center` fits in: [[w, s], [e, n]]. */
export function ringBounds(
  [lon, lat]: [number, number],
  radiusKm: number,
): [[number, number], [number, number]] {
  const dLat = radiusKm / 110.574;
  const dLon = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [
    [lon - dLon, lat - dLat],
    [lon + dLon, lat + dLat],
  ];
}

/** Draw (or move) the ring. The map's style must be loaded. */
export function showPinRing(map: maplibregl.Map, center: [number, number], radiusKm: number): void {
  const data = circleLine(center, radiusKm);
  legendFor(map).update({ ring: { radiusKm } });
  const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    return;
  }
  map.addSource(SOURCE_ID, { type: "geojson", data });
  map.addLayer(
    {
      id: LAYER_ID,
      type: "line",
      source: SOURCE_ID,
      minzoom: 8,
      layout: { "line-cap": "round" },
      paint: {
        "line-color": mapColors().ink,
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 13, 1.75],
        "line-dasharray": [0.5, 2.6],
        "line-opacity": 0.8,
      },
    },
    OBSERVATION_LAYERS.find((id) => map.getLayer(id)),
  );
}

export function clearPinRing(map: maplibregl.Map): void {
  legendFor(map).update({ ring: null });
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

/** Re-resolve the theme-dependent colour (called when the colour scheme flips). */
export function restylePinRing(map: maplibregl.Map): void {
  if (map.getLayer(LAYER_ID)) map.setPaintProperty(LAYER_ID, "line-color", mapColors().ink);
}
