import type {
  Map as MapLibreMap,
  GeolocateControl,
  RasterLayerSpecification,
  RasterSourceSpecification,
  StyleSpecification,
} from "maplibre-gl";
import "./map.css";
import { restyleForestScores } from "./forestscores";
import { legendFor } from "./maplegend";
import { enableFindCard, restyleObservations } from "./observations";
import { mapColors, prefersReducedMotion } from "./palette";
import { restylePinRing } from "./pinring";

type RasterPaint = NonNullable<RasterLayerSpecification["paint"]>;

/**
 * The basemap is a full-colour road map; under data it has to step back. The
 * raster is desaturated and softened in light mode. In dark mode it is
 * inverted (brightness min above max) and its hues rotated back by 180
 * degrees, which turns the same tiles into a dark map with light labels, so
 * the map no longer glares beside the dark panels. The dark map is also taken
 * most of the way to grey: inverted, the motorways and railways come out
 * pink, and pink belongs to the finds.
 */
function basemapPaint(): RasterPaint {
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

/** The one raster layer; its source is Skærmkort or, failing that, OSM. */
const BASEMAP_ID = "basemap";

function applyBasemapTheme(map: MapLibreMap): void {
  if (map.getLayer(BASEMAP_ID)) {
    for (const [name, value] of Object.entries(basemapPaint())) {
      map.setPaintProperty(BASEMAP_ID, name, value);
    }
  }
  if (map.getLayer("backdrop")) {
    map.setPaintProperty("backdrop", "background-color", mapColors().backdrop);
  }
}

function restyleAll(map: MapLibreMap): void {
  applyBasemapTheme(map);
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
 * Only one basemap is ever requested: Skærmkort when there is a key for it,
 * OpenStreetMap otherwise. (Both used to load, one over the other, which
 * doubled the tile traffic and let OSM tiles show through while Skærmkort
 * tiles were still on their way.)
 */
function initialStyle(): StyleSpecification {
  const source = SDFI_TOKEN ? "sdfi" : "osm";
  return {
    version: 8,
    sources: { [source]: SDFI_TOKEN ? sdfiSource(SDFI_TOKEN) : OSM_SOURCE },
    layers: [
      { id: "backdrop", type: "background", paint: { "background-color": mapColors().backdrop } },
      { id: BASEMAP_ID, type: "raster", source, paint: basemapPaint() },
    ],
  };
}

/**
 * If Skærmkort fails -- a rejected request answers with an XML
 * ServiceException at HTTP 200, which surfaces as a tile that cannot be
 * decoded (e.g. an invalid/expired key) -- swap the one basemap layer over to
 * OpenStreetMap on the first error, instead of flooding decode errors.
 */
function fallBackToOsmOnError(map: MapLibreMap): void {
  if (!SDFI_TOKEN) return;
  const onError = (e: { error?: Error; sourceId?: string }): void => {
    const decodeError = /could not be decoded/i.test(String(e?.error?.message ?? ""));
    if (e?.sourceId !== "sdfi" && !decodeError) return;
    if (!map.getSource("sdfi")) return;
    console.warn("SDFI basemap unavailable — falling back to OpenStreetMap", e?.error);
    map.off("error", onError);
    const swap = (): void => {
      if (!map.getSource("sdfi")) return;
      // back in directly above the backdrop, under any data layers
      const layers = map.getStyle().layers;
      const above = layers[layers.findIndex((layer) => layer.id === BASEMAP_ID) + 1]?.id;
      map.removeLayer(BASEMAP_ID);
      map.removeSource("sdfi");
      map.addSource("osm", OSM_SOURCE);
      map.addLayer({ id: BASEMAP_ID, type: "raster", source: "osm", paint: basemapPaint() }, above);
    };
    // an error can arrive before the style has finished loading
    if (map.isStyleLoaded()) swap();
    else void map.once("idle", swap);
  };
  map.on("error", onError);
}

export interface MapBundle {
  map: MapLibreMap;
  geolocate: GeolocateControl;
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

  const geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
  });

  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.addControl(geolocate, "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }));

  fallBackToOsmOnError(map);

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
