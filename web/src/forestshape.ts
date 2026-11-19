// The outline of one forest on the map: the forest the pin stands in, which
// is also the forest just chosen from the list (the pin moves there). A soft
// fill and a line with a halo, so it reads over the basemap's own green in
// light and dark. Its own source and layers (ids below), put in directly above
// the basemap and the forests coloured by score (forestscores.ts), so the
// finds and every marker stay on top of it. While forests are coloured by
// score its own fill is off: the forest's colour is then its score's.

import type maplibregl from "maplibre-gl";
import { shapeToGeoJSON, type ForestShape } from "./forestoutlines";
import { mapColors } from "./palette";

const SOURCE_ID = "forest-outline";
const FILL_ID = "forest-outline-fill";
const HALO_ID = "forest-outline-halo";
const LINE_ID = "forest-outline-line";
const BASEMAP_ID = "basemap"; // map.ts

/** A green the basemap does not use for forest itself: deep on the light
 * map, pale on the dark one. (Raspberry is the finds, amber the pin, teal the
 * forest scores.) */
function colors(): { line: string; halo: string; fill: string; fillOpacity: number } {
  const { dark, halo } = mapColors();
  return dark
    ? { line: "#e2f9dc", halo, fill: "#c9efc4", fillOpacity: 0.13 }
    : { line: "#1d5a36", halo, fill: "#1d5a36", fillOpacity: 0.1 };
}

/** Off while the forests are coloured by score (per map). */
const unfilled = new WeakSet<maplibregl.Map>();
const SCORES_PREFIX = "forest-scores"; // forestscores.ts: drawn below

function paint(map: maplibregl.Map): void {
  const c = colors();
  if (!map.getLayer(LINE_ID)) return;
  map.setPaintProperty(FILL_ID, "fill-color", c.fill);
  map.setPaintProperty(FILL_ID, "fill-opacity", unfilled.has(map) ? 0 : c.fillOpacity);
  map.setPaintProperty(HALO_ID, "line-color", c.halo);
  map.setPaintProperty(LINE_ID, "line-color", c.line);
}

let themeWatched = false;

/** Draw (or move) the outline to `shape`. The map's style must be loaded. */
export function showForestOutline(map: maplibregl.Map, shape: ForestShape): void {
  const data: GeoJSON.Feature = {
    type: "Feature",
    properties: {},
    geometry: shapeToGeoJSON(shape),
  };
  const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    return;
  }
  map.addSource(SOURCE_ID, { type: "geojson", data });
  // directly above the basemap: below everything that was or will be added
  const layers = map.getStyle().layers ?? [];
  let at = layers.findIndex((layer) => layer.id === BASEMAP_ID) + 1;
  while (layers[at]?.id.startsWith(SCORES_PREFIX)) at++; // above the score fills
  const above = layers[at]?.id;
  const c = colors();
  map.addLayer(
    {
      id: FILL_ID,
      type: "fill",
      source: SOURCE_ID,
      paint: { "fill-color": c.fill, "fill-opacity": unfilled.has(map) ? 0 : c.fillOpacity },
    },
    above,
  );
  const width: maplibregl.ExpressionSpecification = [
    "interpolate",
    ["linear"],
    ["zoom"],
    8,
    1.25,
    13,
    2.25,
  ];
  map.addLayer(
    {
      id: HALO_ID,
      type: "line",
      source: SOURCE_ID,
      layout: { "line-join": "round" },
      paint: {
        "line-color": c.halo,
        "line-opacity": 0.75,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 3.25, 13, 5.25],
      },
    },
    above,
  );
  map.addLayer(
    {
      id: LINE_ID,
      type: "line",
      source: SOURCE_ID,
      layout: { "line-join": "round" },
      paint: { "line-color": c.line, "line-width": width },
    },
    above,
  );
  if (!themeWatched) {
    themeWatched = true;
    window
      .matchMedia?.("(prefers-color-scheme: dark)")
      .addEventListener?.("change", () => paint(map));
  }
}

export function clearForestOutline(map: maplibregl.Map): void {
  for (const id of [LINE_ID, HALO_ID, FILL_ID]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

/** Turn the outline's own soft fill on or off; the line stays. */
export function setForestOutlineFilled(map: maplibregl.Map, filled: boolean): void {
  if (filled) unfilled.delete(map);
  else unfilled.add(map);
  paint(map);
}

/** Whether an outline is on the map (for tests and the harness). */
export function hasForestOutline(map: maplibregl.Map): boolean {
  return Boolean(map.getLayer(LINE_ID));
}
