import type {
  Map as MapLibreMap,
  RasterLayerSpecification,
  RasterSourceSpecification,
  StyleSpecification,
} from "maplibre-gl";
import "./map.css";
import {
  BASEMAP_ID,
  BASEMAP_PREFIX,
  DARK,
  GLYPHS,
  LIGHT,
  VECTOR_SOURCE,
  VECTOR_SOURCE_ID,
  basemapLayers,
  paintBasemap,
  type BasemapPalette,
} from "./basemapstyle";
import { restyleForestLabels } from "./forestlabels";
import { LocateControl } from "./locatecontrol";
import { restyleForestScores } from "./forestscores";
import { legendFor } from "./maplegend";
import { enableFindCard, restyleObservations } from "./observations";
import { mapColors, prefersReducedMotion } from "./palette";
import { restylePinRing } from "./pinring";

type RasterPaint = NonNullable<RasterLayerSpecification["paint"]>;

/**
 * The fallback basemaps (Skærmkort, OSM) are raster road maps; under data
 * they have to step back. The raster is desaturated and softened in light
 * mode. In dark mode it is inverted (brightness min above max) and its hues
 * rotated back by 180 degrees, which turns the same tiles into a dark map with
 * light labels. The dark map is also taken most of the way to grey: inverted,
 * the motorways and railways come out pink, and pink belongs to the finds.
 * (The vector basemap needs none of this: basemapstyle.ts has a palette per
 * theme.)
 */
function rasterPaint(): RasterPaint {
  const fade = prefersReducedMotion() ? 0 : 300;
  return mapColors().dark
    ? {
        "raster-brightness-min": 0.8,
        "raster-brightness-max": 0.1,
        "raster-hue-rotate": 180,
        "raster-saturation": -0.78,
        "raster-contrast": -0.08,
        "raster-fade-duration": fade,
      }
    : {
        "raster-brightness-min": 0.06,
        "raster-brightness-max": 1,
        "raster-hue-rotate": 0,
        "raster-saturation": -0.5,
        "raster-contrast": -0.12,
        "raster-fade-duration": fade,
      };
}

function palette(): BasemapPalette {
  return mapColors().dark ? DARK : LIGHT;
}

/** The raster layer that replaces the vector basemap if that fails. */
const RASTER_ID = "basemap-raster";

function applyBasemapTheme(map: MapLibreMap): void {
  if (map.getLayer("backdrop")) {
    map.setPaintProperty("backdrop", "background-color", palette().land);
  }
  if (map.getLayer(RASTER_ID)) {
    for (const [name, value] of Object.entries(rasterPaint())) {
      map.setPaintProperty(RASTER_ID, name, value);
    }
  } else {
    paintBasemap(map, palette());
  }
}

function restyleAll(map: MapLibreMap): void {
  applyBasemapTheme(map);
  restyleForestLabels(map);
  restyleObservations(map);
  restylePinRing(map);
  restyleForestScores(map);
  legendFor(map).refresh(); // its swatches are theme-specific
}

const OSM_SOURCE: RasterSourceSpecification = {
  type: "raster",
  tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
  tileSize: 256,
  maxzoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
};

// Roughly the centre of Denmark (Storebælt), so the opening view frames the
// whole country from Jutland to Bornholm.
const DENMARK_CENTER: [number, number] = [10.9, 55.9];

const SDFI_TOKEN = import.meta.env.VITE_DATAFORDELER_API_KEY;

// GeoDanmark Skaermkort, CC BY 4.0. Must be shown to the user (map + an "Om data"
// screen). See docs/data-sources.md.
const SDFI_ATTRIBUTION =
  'Kort: <a href="https://www.geodanmark.dk" target="_blank" rel="noopener">GeoDanmark</a> ' +
  '(<a href="https://creativecommons.org/licenses/by/4.0/deed.da" target="_blank" rel="noopener">CC BY 4.0</a>), ' +
  '<a href="https://datafordeler.dk" target="_blank" rel="noopener">Datafordeler</a>';

/**
 * Klimadatastyrelsens "Skærmkort" via its Datafordeler WMS (the WMTS is
 * UTM32N-only). Same underlying map as before this moved off DAWA/legacy
 * Dataforsyningen (docs/data-sources.md) -- same layer name, same on-the-fly
 * EPSG:3857 reprojection, so MapLibre can use it as a raster source with the
 * {bbox-epsg-3857} token unchanged.
 *
 * Note: this WMS enforces the WMS 1.3.0 spelling of TRANSPARENT (uppercase
 * TRUE/FALSE) and rejects `transparent=false` outright, so the parameter is
 * omitted -- its default is FALSE, which is what an opaque basemap wants.
 */
function sdfiSource(token: string): RasterSourceSpecification {
  return {
    type: "raster",
    tiles: [
      "https://wms.datafordeler.dk/Dkskaermkort/topo_skaermkort/1.0.0/wms?service=WMS&version=1.3.0" +
        "&request=GetMap&layers=dtk_skaermkort&styles=&format=image/png" +
        `&crs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}&apikey=${token}`,
    ],
    tileSize: 256,
    attribution: SDFI_ATTRIBUTION,
  };
}

/**
 * The basemap is OpenStreetMap data as vector tiles from OpenFreeMap, drawn
 * with our own style (basemapstyle.ts). Glyphs come from the same host and
 * are kept even if the basemap falls back, so the forest names still draw.
 */
function initialStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: { [VECTOR_SOURCE_ID]: VECTOR_SOURCE },
    layers: [
      { id: "backdrop", type: "background", paint: { "background-color": palette().land } },
      ...basemapLayers(palette()),
    ],
  };
}

/** Skærmkort when there is a key for it, OpenStreetMap's raster otherwise. */
function rasterSource(): { id: string; spec: RasterSourceSpecification } {
  return SDFI_TOKEN
    ? { id: "sdfi", spec: sdfiSource(SDFI_TOKEN) }
    : { id: "osm", spec: OSM_SOURCE };
}

/** Swap the basemap for a raster one: the vector layers out, the raster in
 * directly below the marker, so every data layer keeps its place. */
function useRaster(
  map: MapLibreMap,
  source: { id: string; spec: RasterSourceSpecification },
): void {
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.id.startsWith(BASEMAP_PREFIX) || layer.id === RASTER_ID) map.removeLayer(layer.id);
  }
  for (const id of [VECTOR_SOURCE_ID, "sdfi", "osm"]) {
    if (map.getSource(id)) map.removeSource(id);
  }
  map.addSource(source.id, source.spec);
  map.addLayer(
    { id: RASTER_ID, type: "raster", source: source.id, paint: rasterPaint() },
    BASEMAP_ID,
  );
}

/**
 * Fallbacks, each on the first error of the map in use: the vector basemap
 * (OpenFreeMap down or blocked, before any of its tiles arrived) gives way to
 * Skærmkort, and Skærmkort to OpenStreetMap. Skærmkort fails in its own way --
 * a rejected request answers with an XML ServiceException at HTTP 200, which
 * surfaces as a tile that cannot be decoded (e.g. an invalid/expired key).
 * Once vector tiles have arrived, a later error (no signal in the forest) is
 * left alone: a raster map would not load either.
 */
function installFallbacks(map: MapLibreMap): void {
  let vectorArrived = false;
  const onData = (e: { sourceId?: string; tile?: unknown }): void => {
    if (e.sourceId === VECTOR_SOURCE_ID && e.tile) {
      vectorArrived = true;
      map.off("sourcedata", onData);
    }
  };
  map.on("sourcedata", onData);

  // Not map.isStyleLoaded(): that waits for every source, and the failed one
  // never finishes -- nor would the map's "load". Swap as soon as the style
  // itself is in place (an error can arrive before it is), and the map then
  // loads on the raster.
  const whenReady = (fn: () => void): void => {
    try {
      fn();
    } catch {
      void map.once("styledata", () => whenReady(fn));
    }
  };

  const onError = (e: { error?: Error; sourceId?: string }): void => {
    const message = String(e?.error?.message ?? "");
    if (e?.sourceId === VECTOR_SOURCE_ID || (!e?.sourceId && /openfreemap/i.test(message))) {
      if (vectorArrived || !map.getSource(VECTOR_SOURCE_ID)) return;
      console.warn("Vector basemap unavailable — falling back to a raster map", e?.error);
      map.off("sourcedata", onData);
      whenReady(() => {
        if (map.getSource(VECTOR_SOURCE_ID)) useRaster(map, rasterSource());
      });
      return;
    }
    const decodeError = /could not be decoded/i.test(message);
    if ((e?.sourceId === "sdfi" || decodeError) && map.getSource("sdfi")) {
      console.warn("SDFI basemap unavailable — falling back to OpenStreetMap", e?.error);
      whenReady(() => {
        if (map.getSource("sdfi")) useRaster(map, { id: "osm", spec: OSM_SOURCE });
      });
    }
  };
  map.on("error", onError);
}

export interface MapBundle {
  map: MapLibreMap;
  geolocate: LocateControl;
  /** The loaded module namespace, so callers can `new maplibregl.Marker(...)`
   *  without a second static import of the library. */
  maplibregl: typeof import("maplibre-gl");
  /** Resolves once the style has loaded for the first time; layers can be
   *  added from then on. (`map.isStyleLoaded()` is no use as that test: it
   *  goes false again whenever a source or paint property has just changed.) */
  loaded: Promise<MapLibreMap>;
}

/**
 * Load MapLibre (its own ~800 kB chunk) and build the map. Async so the library
 * stays out of the entry bundle — the species panel renders from the payload
 * while this resolves.
 */
export async function createMap(
  container: string,
  /** Where to open instead of the whole country (a pin restored from last time). */
  initial?: { center: [number, number]; zoom: number },
): Promise<MapBundle> {
  const maplibregl = await import("maplibre-gl");
  await import("maplibre-gl/dist/maplibre-gl.css");

  const map = new maplibregl.Map({
    container,
    style: initialStyle(),
    center: initial?.center ?? DENMARK_CENTER,
    zoom: initial?.zoom ?? 6.4,
    attributionControl: { compact: true },
  });

  // One position per press, not a follow mode, and no camera move of its own
  // (locatecontrol.ts, locate.ts): the app flies to an answer it takes.
  const geolocate = new LocateControl({
    positionOptions: { enableHighAccuracy: true, timeout: 20000 },
    makeMarker: (element) => new maplibregl.Marker({ element }),
  });

  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.addControl(geolocate, "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }));

  installFallbacks(map);

  const loaded = new Promise<MapLibreMap>((resolve) => {
    map.once("load", () => resolve(map));
  });

  // The page's theme follows the OS setting; keep the map's colours with it.
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    void loaded.then(restyleAll);
  });

  enableFindCard(map, maplibregl);

  // Dev server only (dropped from production builds): lets the screenshot
  // harness and the console drive the camera.
  if (import.meta.env.DEV) (window as unknown as { __map?: MapLibreMap }).__map = map;

  return { map, geolocate, maplibregl, loaded };
}
