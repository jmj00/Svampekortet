// The basemap: OpenStreetMap data as vector tiles from OpenFreeMap (no key,
// OpenMapTiles schema), drawn with a style of our own in an OSM-like look. A
// short style rather than a published one: only what a mushroom map needs
// (forest, heath, bog, water, roads, forest tracks and paths, place names), with
// Danish names and colours that leave raspberry (finds), amber (pin) and teal
// (forest scores) free. See docs/adr/0024-vector-basemap-openfreemap.md.
//
// The layers come in two parts around one invisible marker layer, BASEMAP_ID:
// the ground (land cover, water, buildings) below it, roads and labels above
// it. Data layers that should sit on the ground -- the forests coloured by
// score, the pin's forest outline (forestscores.ts, forestshape.ts) -- go in
// directly above the marker, so roads and names stay readable on top of them.

import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  FilterSpecification,
  LayerSpecification,
  SourceSpecification,
} from "maplibre-gl";

export const VECTOR_SOURCE_ID = "openmaptiles";
/** Invisible marker between the ground and the roads; data goes above it. */
export const BASEMAP_ID = "basemap";
/** Every basemap layer id but the backdrop carries this prefix. */
export const BASEMAP_PREFIX = "bm-";

export const VECTOR_SOURCE: SourceSpecification = {
  type: "vector",
  url: "https://tiles.openfreemap.org/planet",
  attribution:
    '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap</a> · ' +
    '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> · ' +
    '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
};

export const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

const REGULAR = ["Noto Sans Regular"];
const BOLD = ["Noto Sans Bold"];
const ITALIC = ["Noto Sans Italic"];

export interface BasemapPalette {
  land: string;
  residential: string;
  wood: string;
  grass: string;
  heath: string;
  wetland: string;
  sand: string;
  water: string;
  building: string;
  buildingLine: string;
  casing: string;
  motorway: string;
  primary: string;
  secondary: string;
  minor: string;
  track: string;
  path: string;
  rail: string;
  boundary: string;
  label: string;
  labelMuted: string;
  waterLabel: string;
  forestLabel: string;
  halo: string;
}

/** OSM's palette (openstreetmap-carto), with the pink motorways turned
 * orange: raspberry is the finds' colour. */
export const LIGHT: BasemapPalette = {
  land: "#f4f3ee",
  residential: "#e6e2da",
  wood: "#add19e",
  grass: "#cdebb0",
  heath: "#d6d99f",
  wetland: "#d4e6d6",
  sand: "#f2e6c3",
  water: "#aad3df",
  building: "#d9d0c9",
  buildingLine: "#c4b6ab",
  casing: "#c7c2b8",
  motorway: "#e9a46a",
  primary: "#f8cf8f",
  secondary: "#f7f0b5",
  minor: "#ffffff",
  track: "#996633",
  path: "#b5704f",
  rail: "#8d8d8d",
  boundary: "#9e8fa8",
  label: "#2b2b28",
  labelMuted: "#55554f",
  waterLabel: "#3f6f99",
  forestLabel: "#2f5a2a",
  halo: "#ffffff",
};

/** The same map at night: dark land, forests a deep green, light names. */
export const DARK: BasemapPalette = {
  land: "#191b16",
  residential: "#24251f",
  wood: "#22372a",
  grass: "#26321f",
  heath: "#30331f",
  wetland: "#1f2f2c",
  sand: "#34301f",
  water: "#1d3340",
  building: "#2f2d28",
  buildingLine: "#3b3933",
  casing: "#14160f",
  motorway: "#9a6a43",
  primary: "#7c6845",
  secondary: "#5c5a43",
  minor: "#4a4a42",
  track: "#b8915e",
  path: "#c48d6f",
  rail: "#6c6c66",
  boundary: "#7d7186",
  label: "#e4e2d6",
  labelMuted: "#b6b4a8",
  waterLabel: "#8fbad6",
  forestLabel: "#a9d29a",
  halo: "#14160f",
};

/** Danish name first: OSM's name:da, else the local name. */
const NAME: ExpressionSpecification = ["coalesce", ["get", "name:da"], ["get", "name"]];

const byZoom = (...stops: number[]): ExpressionSpecification => [
  "interpolate",
  ["exponential", 1.5],
  ["zoom"],
  ...stops,
];

const roadClass = (...classes: string[]): ExpressionSpecification => [
  "match",
  ["get", "class"],
  classes,
  true,
  false,
];

const isLine: ExpressionSpecification = [
  "match",
  ["geometry-type"],
  ["LineString", "MultiLineString"],
  true,
  false,
];

const fill = (
  id: string,
  sourceLayer: string,
  filter: FilterSpecification | undefined,
  color: string,
  opacity: number | ExpressionSpecification = 1,
  minzoom = 0,
): LayerSpecification => ({
  id: BASEMAP_PREFIX + id,
  type: "fill",
  source: VECTOR_SOURCE_ID,
  "source-layer": sourceLayer,
  minzoom,
  ...(filter ? { filter } : {}),
  paint: { "fill-color": color, "fill-opacity": opacity },
});

interface RoadSpec {
  id: string;
  classes: string[];
  color: string;
  width: ExpressionSpecification;
  casing?: ExpressionSpecification;
  minzoom: number;
  dash?: number[];
}

function roadLayers(p: BasemapPalette): LayerSpecification[] {
  const roads: RoadSpec[] = [
    {
      id: "minor",
      classes: ["minor", "service"],
      color: p.minor,
      width: byZoom(12, 0.5, 14, 2, 16, 5, 18, 12),
      casing: byZoom(12, 0.9, 14, 3.2, 16, 6.8, 18, 14.5),
      minzoom: 12,
    },
    {
      id: "secondary",
      classes: ["secondary", "tertiary"],
      color: p.secondary,
      width: byZoom(8, 0.5, 11, 1.2, 14, 3.5, 16, 7, 18, 16),
      casing: byZoom(8, 0.9, 11, 2, 14, 5, 16, 9, 18, 19),
      minzoom: 8,
    },
    {
      id: "primary",
      classes: ["primary", "trunk"],
      color: p.primary,
      width: byZoom(6, 0.6, 10, 1.6, 14, 4.5, 16, 8, 18, 18),
      casing: byZoom(6, 1, 10, 2.6, 14, 6, 16, 10, 18, 21),
      minzoom: 5,
    },
    {
      id: "motorway",
      classes: ["motorway"],
      color: p.motorway,
      width: byZoom(5, 0.8, 10, 2, 14, 5, 16, 9, 18, 19),
      casing: byZoom(5, 1.2, 10, 3, 14, 6.6, 16, 11, 18, 22),
      minzoom: 5,
    },
  ];
  const casings: LayerSpecification[] = roads.map((r) => ({
    id: `${BASEMAP_PREFIX}road-${r.id}-casing`,
    type: "line",
    source: VECTOR_SOURCE_ID,
    "source-layer": "transportation",
    minzoom: r.minzoom,
    filter: ["all", isLine, roadClass(...r.classes)],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": p.casing, "line-width": r.casing as ExpressionSpecification },
  }));
  const fills: LayerSpecification[] = roads.map((r) => ({
    id: `${BASEMAP_PREFIX}road-${r.id}`,
    type: "line",
    source: VECTOR_SOURCE_ID,
    "source-layer": "transportation",
    minzoom: r.minzoom,
    filter: ["all", isLine, roadClass(...r.classes)],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": r.color, "line-width": r.width },
  }));
  // Forest tracks and paths: what a mushroom hunter walks on. Brown and dashed
  // like OSM's, under the roads so a road always reads as the bigger way.
  const track: LayerSpecification = {
    id: `${BASEMAP_PREFIX}track`,
    type: "line",
    source: VECTOR_SOURCE_ID,
    "source-layer": "transportation",
    minzoom: 12,
    filter: ["all", isLine, roadClass("track")],
    paint: {
      "line-color": p.track,
      "line-width": byZoom(12, 0.7, 15, 1.6, 18, 3),
      "line-dasharray": [3, 1.5],
    },
  };
  const path: LayerSpecification = {
    id: `${BASEMAP_PREFIX}path`,
    type: "line",
    source: VECTOR_SOURCE_ID,
    "source-layer": "transportation",
    minzoom: 13,
    filter: ["all", isLine, roadClass("path")],
    paint: {
      "line-color": p.path,
      "line-width": byZoom(13, 0.6, 15, 1.2, 18, 2.4),
      "line-dasharray": [1.5, 1.5],
    },
  };
  const rail: LayerSpecification = {
    id: `${BASEMAP_PREFIX}rail`,
    type: "line",
    source: VECTOR_SOURCE_ID,
    "source-layer": "transportation",
    minzoom: 8,
    filter: ["all", isLine, roadClass("rail")],
    paint: { "line-color": p.rail, "line-width": byZoom(8, 0.6, 14, 1.5, 18, 3) },
  };
  return [track, path, ...casings, rail, ...fills];
}

function labelLayers(p: BasemapPalette): LayerSpecification[] {
  const halo = { "text-halo-color": p.halo, "text-halo-width": 1.4, "text-halo-blur": 0.4 };
  const place = (
    id: string,
    classes: string[],
    minzoom: number,
    size: DataDrivenPropertyValueSpecification<number>,
    font: string[],
    color: string,
    maxzoom = 24,
  ): LayerSpecification => ({
    id: `${BASEMAP_PREFIX}place-${id}`,
    type: "symbol",
    source: VECTOR_SOURCE_ID,
    "source-layer": "place",
    minzoom,
    maxzoom,
    filter: roadClass(...classes),
    layout: {
      "text-field": NAME,
      "text-font": font,
      "text-size": size,
      "text-max-width": 8,
      "symbol-sort-key": ["get", "rank"],
    },
    paint: { "text-color": color, ...halo },
  });
  return [
    {
      id: `${BASEMAP_PREFIX}water-name`,
      type: "symbol",
      source: VECTOR_SOURCE_ID,
      "source-layer": "water_name",
      minzoom: 9,
      layout: {
        "text-field": NAME,
        "text-font": ITALIC,
        "text-size": 12,
        "text-max-width": 6,
        "symbol-placement": "point",
      },
      paint: { "text-color": p.waterLabel, ...halo },
    },
    {
      id: `${BASEMAP_PREFIX}waterway-name`,
      type: "symbol",
      source: VECTOR_SOURCE_ID,
      "source-layer": "waterway",
      minzoom: 13,
      filter: isLine,
      layout: {
        "text-field": NAME,
        "text-font": ITALIC,
        "text-size": 11.5,
        "symbol-placement": "line",
        "text-letter-spacing": 0.08,
      },
      paint: { "text-color": p.waterLabel, ...halo },
    },
    {
      id: `${BASEMAP_PREFIX}road-name`,
      type: "symbol",
      source: VECTOR_SOURCE_ID,
      "source-layer": "transportation_name",
      minzoom: 13,
      filter: roadClass(
        "motorway",
        "trunk",
        "primary",
        "secondary",
        "tertiary",
        "minor",
        "service",
        "track",
        "path",
      ),
      layout: {
        "text-field": NAME,
        "text-font": REGULAR,
        "text-size": byZoom(13, 10.5, 17, 13),
        "symbol-placement": "line",
        "text-rotation-alignment": "map",
      },
      paint: { "text-color": p.labelMuted, ...halo },
    },
    place(
      "other",
      ["hamlet", "suburb", "neighbourhood", "quarter", "isolated_dwelling", "locality"],
      12.5,
      11,
      REGULAR,
      p.labelMuted,
    ),
    place("village", ["village"], 9.5, byZoom(10, 11, 14, 13.5), REGULAR, p.label),
    place("town", ["town"], 5.5, byZoom(6, 10.5, 10, 13, 14, 16), REGULAR, p.label),
    place("city", ["city"], 4, byZoom(4, 12, 8, 15, 12, 19), BOLD, p.label),
    place("country", ["country"], 3, 13, BOLD, p.labelMuted, 6.5),
  ];
}

/** The whole basemap, bottom to top (the backdrop is the map's own layer). */
export function basemapLayers(p: BasemapPalette): LayerSpecification[] {
  return [
    fill(
      "residential",
      "landuse",
      roadClass("residential", "commercial", "industrial", "retail"),
      p.residential,
      byZoom(9, 0.5, 12, 1),
    ),
    fill(
      "heath",
      "landcover",
      [
        "all",
        ["==", ["get", "class"], "grass"],
        ["match", ["get", "subclass"], ["heath", "scrub"], true, false],
      ],
      p.heath,
    ),
    fill(
      "grass",
      "landcover",
      [
        "all",
        ["==", ["get", "class"], "grass"],
        ["match", ["get", "subclass"], ["heath", "scrub"], false, true],
      ],
      p.grass,
      0.8,
    ),
    fill("wetland", "landcover", ["==", ["get", "class"], "wetland"], p.wetland),
    fill("sand", "landcover", ["==", ["get", "class"], "sand"], p.sand),
    fill("wood", "landcover", ["==", ["get", "class"], "wood"], p.wood),
    {
      id: `${BASEMAP_PREFIX}waterway`,
      type: "line",
      source: VECTOR_SOURCE_ID,
      "source-layer": "waterway",
      minzoom: 9,
      filter: ["!=", ["get", "brunnel"], "tunnel"],
      paint: {
        "line-color": p.water,
        "line-width": [
          "interpolate",
          ["exponential", 1.5],
          ["zoom"],
          9,
          ["match", ["get", "class"], ["river", "canal"], 0.8, 0],
          14,
          ["match", ["get", "class"], ["river", "canal"], 2.5, 1.2],
          18,
          ["match", ["get", "class"], ["river", "canal"], 8, 3],
        ],
      },
    },
    fill("water", "water", ["!=", ["get", "brunnel"], "tunnel"], p.water),
    {
      id: `${BASEMAP_PREFIX}building`,
      type: "fill",
      source: VECTOR_SOURCE_ID,
      "source-layer": "building",
      minzoom: 14,
      paint: { "fill-color": p.building, "fill-outline-color": p.buildingLine },
    },
    // The marker: data goes in directly above it (see the top of this file).
    { id: BASEMAP_ID, type: "background", layout: { visibility: "none" } },
    ...roadLayers(p),
    {
      id: `${BASEMAP_PREFIX}boundary`,
      type: "line",
      source: VECTOR_SOURCE_ID,
      "source-layer": "boundary",
      filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
      paint: {
        "line-color": p.boundary,
        "line-width": byZoom(4, 0.8, 10, 1.6),
        "line-dasharray": [3, 2],
      },
    },
    ...labelLayers(p),
  ];
}

/** Recolour the basemap in place (the colour scheme flipped): every paint
 * property of every basemap layer, from the given palette. */
export function paintBasemap(
  map: {
    getLayer(id: string): unknown;
    setPaintProperty(id: string, name: string, value: unknown): void;
  },
  p: BasemapPalette,
): void {
  for (const layer of basemapLayers(p)) {
    if (!("paint" in layer) || !layer.paint || !map.getLayer(layer.id)) continue;
    for (const [name, value] of Object.entries(layer.paint)) {
      map.setPaintProperty(layer.id, name, value);
    }
  }
}
