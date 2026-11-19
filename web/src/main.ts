import type maplibregl from "maplibre-gl";
import "./style.css";
import "./start.css";
import { aboutControl, openAbout, type AboutSection } from "./about";
import { fitCamera } from "./camera";
import { fitChipName, type ChipName } from "./chipname";
import { loadForestOutlineFile, loadForests, loadManifest, loadSpecies } from "./data";
import { initForestFinder } from "./forestfinder";
import { ForestOutlines } from "./forestoutlines";
import { createForestScores } from "./forestscores";
import { forestAtPin, pinForest } from "./forests";
import { createMap, type MapBundle } from "./map";
import { loadModelBundle, type ModelBundle } from "./model";
import { createPinMarker, labelPinMarker } from "./mappin";
import {
  clearObservations,
  showObservations,
  showObservationsForSpecies,
  syncFindCard,
} from "./observations";
import { SpeciesPanel } from "./panel";
import { clearPinRing, showPinRing } from "./pinring";
import { attachPlaceSearch, type PlaceKind } from "./placesearch";
import { registerServiceWorker } from "./register-sw";
import { initErrorMonitoring } from "./sentry";
import { initSheet } from "./sheet";
import { initStart, type Landing, type LocateResult } from "./start";
import {
  matchForests,
  MY_LOCATION_LABEL,
  readStoredPin,
  restoredLabel,
  shouldShowStart,
  writeStoredPin,
} from "./startstate";
import type { ForestPoint, Manifest } from "./types";

initErrorMonitoring();
registerServiceWorker();

// The pin from the last visit, remembered on this device only (startstate.ts).
// With one, the app opens on the map around it; without, on the start screen.
const storedPin = readStoredPin();
/** Close enough to read the forests around a restored pin. */
const RESTORED_ZOOM = 11;

// MapLibre is its own chunk; everything that touches the map waits on this.
const mapReady: Promise<MapBundle> = createMap(
  "map",
  storedPin ? { center: storedPin.lngLat, zoom: RESTORED_ZOOM } : undefined,
);

/** Where a pin came from: decides what the camera still has to do. */
type PinSource = "map" | "locate" | "address";

// `trackUserLocation: true` keeps re-firing "geolocate" on every GPS update, so
// without this a manually-placed pin gets overwritten by the next fix. Stop the
// watch (same as clicking the control's button again) whenever the user asserts
// a different spot themselves, and track its on/off state to know when to.
let geolocateActive = false;

mapReady
  .then(({ map, geolocate, loaded }) => {
    // Shell: keep the camera's idea of "centre" inside the part of the map the
    // phone sheet leaves visible, and show the compass only while it is needed.
    applyMapPadding(map);
    onShellLayout = () => applyMapPadding(map);
    const markRotated = (): void => {
      appRoot.toggleAttribute("data-map-rotated", map.getBearing() !== 0 || map.getPitch() !== 0);
    };
    map.on("rotate", markRotated);
    map.on("pitch", markRotated);
    // The attribution opens expanded and folds to its "i" on the first map
    // drag. On a narrow map (phone, or beside the sidebar in landscape) it
    // is as wide as the map, so fold it after a few seconds regardless.
    const foldAttribution = (): void => {
      if (map.getContainer().clientWidth >= 600) return;
      const attribution = map.getContainer().querySelector(".maplibregl-ctrl-attrib");
      attribution?.classList.remove("maplibregl-compact-show");
      attribution?.removeAttribute("open");
    };
    // Behind the start screen a phone shows only a band of map: fold it at
    // once there (it opens on a tap, and About lists the sources in full).
    if (start.isOpen() && sheet.isActive())
      void loaded.then(() => window.setTimeout(foldAttribution, 400));
    else window.setTimeout(foldAttribution, 6000);

    // "?" in the map's control stack: help, the score, safety and data sources.
    map.addControl(
      aboutControl(() => showAbout()),
      "top-right",
    );
    geolocate.on("trackuserlocationstart", () => {
      geolocateActive = true;
    });
    geolocate.on("trackuserlocationend", () => {
      geolocateActive = false;
    });
    // A refusal switches the control off without a "trackuserlocationend".
    geolocate.on("error", (e) => {
      if ((e as unknown as GeolocationPositionError).code === 1) geolocateActive = false;
    });
    map.on("moveend", () => prefetchOutlines(map));
    map.on("click", (e) => {
      // The start screen's species step asks for a species, not a place.
      if (start.ignoresMapClicks()) return;
      if (geolocateActive) geolocate.trigger(); // user picked a spot themselves; stop following
      const { lng, lat } = e.lngLat;
      setPin([lng, lat]); // named after the nearest forest, see describePin
      // no camera animation here, so the forest finder need not wait
      afterPin("map", [lng, lat]);
    });
    // "Near me": the geolocate control's fix drops the pin too
    geolocate.on("geolocate", (e) => {
      const { longitude, latitude } = (e as GeolocationPosition).coords;
      setPin([longitude, latitude], MY_LOCATION_LABEL);
      afterPin("locate", [longitude, latitude]);
    });
  })
  .catch((err) => console.error("map failed to load", err));

let panel: SpeciesPanel | null = null;
let pinLngLat: [number, number] | null = null;
/** The open species, while it has a score at the pin (panel.ts): the map
 * then draws the ring and colours the forests by their score for it. */
let conditionsSlug: string | null = null;
let forestPoints: ForestPoint[] = [];
/** The forests' outlines, fetched a band of the country at a time as pins
 * land there. Null until the manifest is in, and for a payload without them. */
let forestOutlines: ForestOutlines | null = null;

/** Set up the outline store once the manifest says which files there are, and
 * ask for the band under a pin that is already set (a restored one). */
function useManifestOutlines(manifest: Manifest): void {
  if (forestOutlines || !manifest.forest_outlines?.length) return;
  forestOutlines = new ForestOutlines(manifest.forest_outlines, loadForestOutlineFile, () => {
    // a band arrived or failed: name the pin again
    if (pinLngLat && !pinLabel) showLocation(pinLngLat, undefined);
    forestFinder.outlinesChanged();
    forestScores.refresh(); // more forests can be coloured, or fewer
  });
  if (pinLngLat) forestOutlines.request(pinLngLat[0], pinLngLat[1]);
  void mapReady.then(({ map, loaded }) => loaded.then(() => prefetchOutlines(map)));
}

/** From this zoom in, the map shows a region rather than the country: one
 * band of outlines, sometimes two. Further out it would be all of them. */
const OUTLINE_PREFETCH_ZOOM = 10;

/** Fetch the outlines for the part of the country the map is showing, ahead
 * of a pin, so a pin dropped there has its forest at once. In idle time, and
 * only once the view is regional: a fresh visit looking at all of Denmark
 * fetches nothing until a pin or a closer view says where. */
function prefetchOutlines(map: MapBundle["map"]): void {
  if (!forestOutlines || map.getZoom() < OUTLINE_PREFETCH_ZOOM) return;
  const bounds = map.getBounds();
  const ask = (): void =>
    forestOutlines?.requestArea(
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    );
  if ("requestIdleCallback" in window) window.requestIdleCallback(ask, { timeout: 1500 });
  else setTimeout(ask, 200);
}

/** The extent of the forest the pin stands on, when that forest was chosen
 * by name and its outline is loaded: the camera then frames the whole forest
 * instead of flying to a point in the middle of it. */
function chosenForestBounds([lon, lat]: [number, number]):
  [[number, number], [number, number]] | null {
  const forest = forestAtPin(forestPoints, lon, lat, forestOutlines);
  const shape = forest?.chosen ? (forestOutlines?.shape(forest.index) ?? null) : null;
  if (!shape) return null;
  const [west, south, east, north] = shape.bbox;
  return [
    [west, south],
    [east, north],
  ];
}

/** Fly to a searched place: to the whole forest when it is one whose outline
 * is known (chosenForestBounds), else to the point at `zoom`. */
function flyToPlace(lngLat: [number, number], zoom: number): Promise<void> {
  const bounds = chosenForestBounds(lngLat);
  if (!bounds) return flyTo(lngLat, zoom);
  sheet.atMost("half");
  return mapReady.then(({ map }) => {
    // no closer than a flight to the forest's point would go
    fitCamera(map, bounds, { maxZoom: zoom, margin: 40 });
    if (prefersReducedMotion()) return;
    return new Promise<void>((resolve) => {
      const done = window.setTimeout(resolve, 1500); // a fit that needs no move fires nothing
      map.once("moveend", () => {
        window.clearTimeout(done);
        resolve();
      });
    });
  });
}
/** The species data or the conditions model failed to load (this attempt). */
let panelFailed = false;
let appManifest: Manifest | null = null;
let appModelBundle: ModelBundle | null = null;

// One fetch of the manifest, shared by the species panel and the start screen.
// Both are `let`: reloadPayload() replaces them after a failed load.
let manifestReady: Promise<Manifest> = loadManifest();

// --- species picker + observation layer + conditions model ---
// Renders as soon as the payload loads; the map layers wait on `mapReady`.
let panelReady: Promise<SpeciesPanel> = buildPanel(manifestReady);

function buildPanel(manifestLoading: Promise<Manifest>): Promise<SpeciesPanel> {
  const building = Promise.all([manifestLoading, loadModelBundle()]).then(
    ([manifest, modelBundle]) => {
      appManifest = manifest;
      useManifestOutlines(manifest);
      appModelBundle = modelBundle;
      const container = document.getElementById("panel") as HTMLElement;
      const onMap = (fn: (map: MapBundle["map"]) => void) =>
        void mapReady.then(({ loaded }) => loaded.then(fn));
      const created = new SpeciesPanel(
        container,
        manifest,
        modelBundle,
        (doc) => onMap((map) => showObservations(map, doc, { pin: pinLngLat })),
        (slug) => {
          conditionsSlug = slug;
          // The ring around the pin: how far away finds count towards the score.
          const radiusKm = (slug && modelBundle?.bySlug.get(slug)?.bandwidth_km) || null;
          const center = pinLngLat;
          onMap((map) =>
            center && radiusKm ? showPinRing(map, center, radiusKm) : clearPinRing(map),
          );
          forestScores.refresh();
        },
        (docs) =>
          onMap((map) =>
            docs.length > 0 ? showObservationsForSpecies(map, docs) : clearObservations(map),
          ),
      );
      panel = created;
      if (pinLngLat) created.setPin(pinLngLat);
      void loadForests(manifest.forests)
        .then((points) => {
          forestPoints = points;
          // A pin dropped before the forests arrived can now be named after one.
          if (pinLngLat && !pinLabel) showLocation(pinLngLat, undefined);
          forestScores.refresh();
        })
        .catch(() => {}); // the finder reports a failed load itself
      return created;
    },
  );
  building.then(
    () => (panelFailed = false),
    () => (panelFailed = true),
  );
  building.catch((err) => {
    console.error(err);
    const container = document.getElementById("panel");
    if (container) container.textContent = "Kunne ikke indlæse svampedata.";
  });
  return building;
}

/** The manifest could not be fetched and the user asks again (the start
 * screen's species step): fetch it anew and build the panel from it. */
function reloadPayload(): Promise<Manifest> {
  const container = document.getElementById("panel");
  if (container && !panel) container.textContent = "Indlæser…";
  manifestReady = loadManifest();
  panelReady = buildPanel(manifestReady);
  return manifestReady;
}
const readout = document.getElementById("readout") as HTMLParagraphElement;
const input = document.getElementById("q") as HTMLInputElement;
const results = document.getElementById("results") as HTMLUListElement;

let marker: maplibregl.Marker | null = null;

// --- app shell: the sheet/sidebar, the location chip, the map's padding ---
const appRoot = document.getElementById("app") as HTMLElement;
const locationChip = document.getElementById("location") as HTMLElement;
const clearPinButton = document.getElementById("clear-pin") as HTMLButtonElement;
const panelEl = document.getElementById("panel") as HTMLElement;
let onShellLayout: () => void = () => {};
/** The name the pin was given (address, forest, "Min placering"); null for a
 * plain map click, which is named after the nearest forest instead. */
let pinLabel: string | null = null;

const sheet = initSheet({
  app: appRoot,
  sheet: document.getElementById("sheet") as HTMLElement,
  header: document.getElementById("sheet-header") as HTMLElement,
  handle: document.getElementById("sheet-handle") as HTMLButtonElement,
  body: document.getElementById("sheet-body") as HTMLElement,
  onLayout: () => onShellLayout(),
});

/** On the phone the sheet covers the lower part of the map and the search the
 * top. Padding tells MapLibre where the visible middle is, so the opening
 * view, a flight to an address or forest, and the geolocate control's own
 * camera move all land in view rather than behind the sheet. It follows the
 * half snap and is only re-applied when the layout really changes -- changing
 * it shifts the map, which must not happen just because the sheet was dragged. */
let appliedPadding = { top: -1, bottom: -1 };
function applyMapPadding(
  map: MapBundle["map"],
  /** `ease`: slide to the new padding instead of jumping. `center`: also put
   * this point in the middle of what is left visible. */
  move: { ease?: boolean; center?: [number, number]; zoom?: number } = {},
): void {
  // While the start screen lies over the map (phone), it decides what shows.
  const cover = start.mapCover();
  const bottom = cover ? cover.bottom : sheet.halfHeight();
  const top = cover ? cover.top : sheet.isActive() ? input.getBoundingClientRect().bottom + 8 : 0;
  const unchanged =
    Math.abs(bottom - appliedPadding.bottom) < 40 && Math.abs(top - appliedPadding.top) < 40;
  if (unchanged && !move.center) return;
  appliedPadding = { top, bottom };
  const camera = {
    padding: { top, bottom, left: 0, right: 0 },
    ...(move.center ? { center: move.center } : {}),
    ...(move.zoom !== undefined ? { zoom: move.zoom } : {}),
  };
  // (never a zero-duration animation: see flyTo below)
  if (move.ease && !prefersReducedMotion()) {
    map.easeTo({ ...camera, duration: move.zoom !== undefined ? 900 : 350 });
  } else {
    map.jumpTo(camera);
  }
}

/** Re-aim the map after the start screen opened, closed or changed view. */
function syncMapToStart(
  move: { ease?: boolean; center?: [number, number]; zoom?: number } = {},
): void {
  void mapReady.then(
    ({ map }) => applyMapPadding(map, move),
    () => {},
  );
}

// A status, not an instruction: the species list right below already explains
// how to set a pin, and says it once.
const EMPTY_PROMPT = "Ingen nål sat endnu";

/** "56,1420° N, 9,5179° Ø" -- four decimals is about ten metres. */
function formatCoords([lon, lat]: [number, number]): string {
  const part = (value: number, positive: string, negative: string): string =>
    `${Math.abs(value).toFixed(4).replace(".", ",")}° ${value >= 0 ? positive : negative}`;
  return `${part(lat, "N", "S")}, ${part(lon, "Ø", "V")}`;
}

/** A plain map click has no name of its own: borrow the nearest named forest
 * when the pin is in or right beside one. */
/** The pin's name for the chip: `long` places a named part in its forest
 * ("I Mølleskov i Rold Skov"); `short` is the part alone, for a chip too
 * narrow for both. */
function describePin([lon, lat]: [number, number]): { long: string; short: string } {
  // the rule the forest tab uses too; "pending" while the outlines for this
  // part of the country are on their way (the name follows when they arrive)
  const forest = pinForest(forestPoints, lon, lat, forestOutlines);
  const plain = (text: string): { long: string; short: string } => ({ long: text, short: text });
  if (forest === "pending" || !forest) return plain("Nål på kortet");
  if (!forest.inside) return plain(`Ved ${forest.name}`);
  const short = `I ${forest.name}`;
  // a named part of a larger forest: place it ("I Mølleskov i Rold Skov")
  return { long: forest.partOf ? `${short} i ${forest.partOf.name}` : short, short };
}

/** Fill the location chip: a name on the first line, tidy coordinates below. */
function showLocation(lngLat: [number, number], label: string | undefined): void {
  const title = document.createElement("span");
  title.className = "loc-title";
  // A searched address is long ("Rådhuspladsen 1, 1550 København V"): its
  // short form is the street part, before the first comma.
  chipName =
    label === undefined
      ? describePin(lngLat)
      : { long: label, short: label.split(",")[0].trim() || label };
  const sub = document.createElement("span");
  sub.className = "loc-sub";
  sub.textContent = formatCoords(lngLat);
  readout.replaceChildren(title, sub);
  locationChip.dataset.state = "pin";
  clearPinButton.hidden = false;
  // Last, with the chip laid out as it will stay: the clear button, shown
  // just above, takes room from the name.
  fitChip();
}

/** The name the chip is showing a form of, or null with no pin. */
let chipName: ChipName | null = null;

/** THE one step that writes the chip's name: the long form where it fits the
 * line, the short one where it would be cut (chipname.ts). Run for every new
 * name, and again whenever the chip's width changes -- the clear button
 * appearing, the phone turned, the window resized, sheet or sidebar. */
function fitChip(): void {
  const title = readout.querySelector<HTMLElement>(".loc-title");
  if (title && chipName) fitChipName(title, chipName);
}
if ("ResizeObserver" in window) new ResizeObserver(fitChip).observe(readout);

function clearPin(): void {
  pinLngLat = null;
  pinLabel = null;
  writeStoredPin(null);
  panel?.setPin(null);
  void mapReady.then(({ geolocate }) => {
    if (geolocateActive) geolocate.trigger(); // or the next GPS fix puts it straight back
    marker?.remove();
    marker = null;
  });
  forestFinder.pinMoved(); // no pin: the finder drops its results and markers
  input.value = "";
  chipName = null;
  readout.textContent = EMPTY_PROMPT;
  locationChip.dataset.state = "empty";
  clearPinButton.hidden = true;
  // Focus would otherwise fall to <body> when the button hides itself. (Not to
  // the address field: on a phone that would throw up the keyboard.)
  document.querySelector<HTMLElement>('#mobile-tabs button[aria-pressed="true"]')?.focus();
}
clearPinButton.addEventListener("click", clearPin);

// A new view starts from its top rather than wherever the last one was
// scrolled. Opening a species also brings the phone sheet to half height: its
// finds and conditions have just been drawn on the map, so show both.
// Going back to the list puts the sheet back where the reader had it.
let lastView = panelEl.dataset.view;
let fullBeforeDetail = false;
new MutationObserver(() => {
  const view = panelEl.dataset.view;
  const from = lastView;
  lastView = view;
  if (view === from) return; // a re-render of the same view
  if (view === "detail") {
    fullBeforeDetail = sheet.snap() === "full";
    panelEl.scrollTop = 0;
    sheet.snapTo("half");
  } else if (from === "detail" && fullBeforeDetail && sheet.snap() === "half") {
    sheet.snapTo("full");
  }
}).observe(panelEl, { attributes: true, attributeFilter: ["data-view"] });

/** Set the pin/marker. `label` names the spot (an address, a forest, "Min
 * placering"); leave it out for a bare map position. Does *not* re-search
 * forests itself -- callers do that via `forestFinder.pinMoved()`, and *when*
 * matters: straight away for a caller with no camera animation in flight (a
 * map click, geolocate), but only once `flyTo` resolves for one that flies,
 * since the per-forest scoring competes with the animation for the main thread. */
function setPin(lngLat: [number, number], label?: string): void {
  // The search field keeps the place that was searched for only while the pin
  // stands there: a pin moved elsewhere leaves no stale address in it.
  if (input.value && input.value !== label) input.value = "";
  forestOutlines?.request(lngLat[0], lngLat[1]); // before the pin is named
  pinLabel = label ?? null;
  showLocation(lngLat, label);
  pinLngLat = lngLat;
  writeStoredPin({ lngLat, label: pinLabel }); // on this device only; see About, "Privatliv"
  panel?.setPin(lngLat);
  void mapReady.then(({ map, maplibregl }) => {
    syncFindCard(map, lngLat); // a card about another spot no longer applies
    marker?.remove();
    marker = createPinMarker(maplibregl).setLngLat(lngLat).addTo(map);
    labelPinMarker(marker);
  });
}

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Resolves once the camera actually lands -- `moveend` for a real flight,
 * immediately for the reduced-motion jump (there's nothing to wait for). */
function flyTo(
  center: [number, number],
  zoom: number,
  /** Where `center` should land, in px from the middle of the map. */
  offset: [number, number] = [0, 0],
): Promise<void> {
  sheet.atMost("half"); // a fully open sheet would hide the map it is flying over
  return mapReady.then(({ map }) => {
    // `flyTo({ duration: 0 })` divides by the duration in its flight-path math and
    // leaves the transform NaN; jump instead when motion is reduced (jumpTo
    // takes no offset, so shift the centre by it first).
    if (prefersReducedMotion()) {
      map.jumpTo({ center, zoom });
      if (offset[0] !== 0 || offset[1] !== 0) {
        const middle = map.project(map.getCenter());
        map.jumpTo({ center: map.unproject([middle.x - offset[0], middle.y - offset[1]]) });
      }
      return;
    }
    return new Promise<void>((resolve) => {
      map.once("moveend", () => resolve());
      map.flyTo({ center, zoom, offset });
    });
  });
}

// --- Svampe / Skove switch (#mobile-tabs): #panel and #forest-finder share the
// sheet (phone) or sidebar (desktop) and only one is shown, picked by
// data-mobile-tab on #app. On the phone, tapping the tab that is already
// showing folds the sheet away or brings it back, as in most map apps. ---
const tabButtons = [...document.querySelectorAll<HTMLButtonElement>("#mobile-tabs button")];

/** Show one of the two views, with the phone sheet open far enough to see it. */
function showTab(tab: "svampe" | "skove"): void {
  sheet.atLeast("half");
  appRoot.dataset.mobileTab = tab;
  for (const button of tabButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.tab === tab));
  }
}

for (const button of tabButtons) {
  button.addEventListener("click", () => {
    const tab = button.dataset.tab;
    if (tab !== "svampe" && tab !== "skove") return;
    if (appRoot.dataset.mobileTab === tab && sheet.isActive()) {
      sheet.snapTo(sheet.snap() === "peek" ? "half" : "peek");
      return;
    }
    showTab(tab);
  });
}

// --- "forests near me" (forestfinder.ts fills #forest-finder and puts the
// numbered forest markers on the map) ---
function triggerGeolocate(): void {
  void mapReady.then(({ geolocate }) => {
    if (!geolocateActive) geolocate.trigger();
  });
}

/** Ask for the position through the map's own control (so its dot and its
 * button stay in step) and report how it went. A position that arrives sets
 * the pin through the control's "geolocate" handler above. */
function locate(): Promise<LocateResult> {
  if (!("geolocation" in navigator)) return Promise.resolve("unavailable");
  return mapReady.then(
    ({ geolocate }) =>
      new Promise<LocateResult>((resolve) => {
        const done = (result: LocateResult): void => {
          geolocate.off("geolocate", onFix);
          geolocate.off("error", onError);
          resolve(result);
        };
        const onFix = (): void => done("ok");
        const onError = (e: unknown): void =>
          done((e as GeolocationPositionError).code === 1 ? "denied" : "unavailable");
        geolocate.on("geolocate", onFix);
        geolocate.on("error", onError);
        if (geolocateActive) geolocate.trigger(); // already following: start afresh
        if (!geolocate.trigger()) done("unavailable");
      }),
    () => "unavailable",
  );
}

function cancelLocate(): void {
  void mapReady.then(
    ({ geolocate }) => {
      if (geolocateActive) geolocate.trigger();
    },
    () => {},
  );
}

function showAbout(section?: AboutSection): void {
  if (appManifest) openAbout(appManifest, section);
  else void loadManifest().then((manifest) => openAbout(manifest, section), console.error);
}

const forestFinder = initForestFinder({
  mapReady,
  getPin: () => pinLngLat,
  // Asked for on every search, so a failed load can be retried.
  getOutlines: () => forestOutlines,
  loadPoints: async (): Promise<ForestPoint[]> => {
    const manifest = appManifest ?? (await loadManifest());
    useManifestOutlines(manifest);
    const points = await loadForests(manifest.forests);
    if (forestPoints !== points) {
      // (also after a first load that failed: the chip can now name the forest)
      forestPoints = points;
      if (pinLngLat && !pinLabel) showLocation(pinLngLat, undefined);
    }
    return points;
  },
  rankingFailed: () => (panelFailed ? "offline" : appManifest && !appModelBundle ? "none" : null),
  getRanking: () => {
    // Rank against whatever the panel is currently showing (e.g. only kantarel
    // species if that is what is searched), not always every core species.
    const slugs = panel?.getRankableSlugs();
    if (!appManifest || !appModelBundle || !slugs) return null;
    const coreCount = appManifest.species.filter((s) => s.tier === "core").length;
    return {
      manifest: appManifest,
      modelBundle: appModelBundle,
      slugs,
      filtered: slugs.size < coreCount,
    };
  },
  goToForest: (forest, camera) => {
    void mapReady.then(({ geolocate }) => {
      if (geolocateActive) geolocate.trigger(); // user picked a spot themselves; stop following
    });
    const target: [number, number] = [forest.lon, forest.lat];
    setPin(target, forest.name); // pin appears right away; the camera catches up
    sheet.atMost("half"); // a fully open phone sheet would hide the forest just chosen
    // The list stays as searched (the chosen row and its marker stay marked),
    // so no forestFinder.pinMoved() here.
    if (camera) void flyTo(target, camera.zoom, camera.offset);
  },
  locate: triggerGeolocate,
  openScoreHelp: () => showAbout("tallet"),
});

// --- forests coloured by today's score for the open species (forestscores.ts) ---
const forestScores = createForestScores({
  mapReady,
  getPin: () => pinLngLat,
  getPoints: () => forestPoints,
  getOutlines: () => forestOutlines,
  getSpecies: () => {
    const slug = conditionsSlug;
    if (!slug || !appManifest || !appModelBundle) return null;
    return {
      slug,
      name: appManifest.species.find((s) => s.slug === slug)?.danish_name ?? "arten",
      manifest: appManifest,
      modelBundle: appModelBundle,
      radiusKm: appModelBundle.bySlug.get(slug)?.bandwidth_km ?? null,
    };
  },
  ignoreClicks: () => start.ignoresMapClicks(),
});

// --- address autocomplete (addresscombo.ts): the search field of the main
// interface here, and the one in the start screen's "where?" step (which
// lists named forests as well) ---
const ADDRESS_ZOOM = 14;
/** A named forest is a bigger thing than an address: stand further back. */
const FOREST_ZOOM = 12.5;

function choosePlace(target: [number, number], text: string, zoom = ADDRESS_ZOOM): void {
  void mapReady.then(({ geolocate }) => {
    if (geolocateActive) geolocate.trigger(); // user picked a place; stop following location
  });
  setPin(target, text);
  afterPin("address", target, zoom);
}

/** A forest or an address was chosen, in either search field. */
function onPlaceChosen(target: [number, number], text: string, kind: PlaceKind): void {
  choosePlace(target, text, kind === "forest" ? FOREST_ZOOM : ADDRESS_ZOOM);
}
const searchForests = (query: string): ForestPoint[] => matchForests(forestPoints, query);

const searchStatus = document.getElementById("search-status") as HTMLElement;
attachPlaceSearch({
  input,
  listbox: results,
  status: searchStatus,
  searchForests,
  onPlace: onPlaceChosen,
  // In the sidebar the message takes room of its own under the field, so it
  // pushes the location chip down instead of lying over it (style.css).
  onStatusChange: () => {
    const height = searchStatus.hidden ? 0 : searchStatus.offsetHeight + 6;
    appRoot.style.setProperty("--search-status-h", `${height}px`);
  },
});
document.getElementById("search")?.addEventListener("submit", (e) => e.preventDefault());

// --- start screen (start.ts): four ways in, each landing in the interface
// above already set up for the task ---

/** A pin was set by the user. Inside the main interface that keeps an open
 * forest list current; from the start screen it completes the flow that was
 * waiting for a place (or, with none waiting, the plain "what is here?").
 * `zoom`: how close to go for a searched place. */
function afterPin(source: PinSource, lngLat: [number, number], zoom = ADDRESS_ZOOM): void {
  if (start.isOpen()) {
    landWithPin(start.pendingFlow() ?? "here", source, lngLat, zoom);
    return;
  }
  if (source === "address") void flyToPlace(lngLat, zoom).then(() => forestFinder.pinMoved());
  else forestFinder.pinMoved();
}

/** Leave the start screen, and aim the map at what the main interface leaves
 * visible (on a phone the layer covered a different part of it). */
function leaveStart(): void {
  start.close();
  syncMapToStart();
}

/** A tap on the map from further out than this says "about here", not
 * "exactly here": the country fits on the screen and a finger covers 20 km. */
const MAP_TAP_FAR_ZOOM = 9;
/** Where such a tap is taken to: close enough to see the forests round the
 * pin and to move it with a second tap. */
const MAP_TAP_ZOOM = 10.5;

function landWithPin(
  flow: "here" | "forests",
  source: PinSource | null,
  lngLat: [number, number],
  zoom = ADDRESS_ZOOM,
): void {
  const phone = sheet.isActive();
  start.close();
  showTab(flow === "forests" ? "skove" : "svampe");
  sheet.snapTo("half");

  // The camera. The forest search frames its own results, so only "here"
  // flies to a searched place or closes in on a far-out tap.
  void mapReady.then(
    ({ map }) => {
      if (source === "map") {
        const closeIn =
          flow === "here" && map.getZoom() < MAP_TAP_FAR_ZOOM ? MAP_TAP_ZOOM : undefined;
        // On a phone the sheet now covers the lower half: one move brings the
        // pin into what is left (and closer, if the tap was from far out).
        if (phone) {
          applyMapPadding(map, { ease: true, center: lngLat, zoom: closeIn });
        } else {
          applyMapPadding(map);
          if (closeIn !== undefined) void flyTo(lngLat, closeIn);
        }
        return;
      }
      applyMapPadding(map);
      if (flow !== "here") return;
      if (source === "address") void flyToPlace(lngLat, zoom);
      // On a phone, re-aiming the map just now stopped the geolocate control's
      // own flight to the position: fly there ourselves.
      else if (source === "locate" && phone) void flyTo(lngLat, ADDRESS_ZOOM);
    },
    () => {},
  );

  if (flow === "here") {
    void panelReady.then(
      (p) => {
        p.showList();
        p.focusList();
      },
      () => {},
    );
    return;
  }
  // Forests: rank against every species, not a filter left over from before.
  void panelReady
    .then(
      (p) => p.showList(),
      () => {},
    )
    .then(() => forestFinder.search({ focus: true }));
}

function enterFromStart(landing: Landing): void | Promise<boolean> {
  switch (landing.kind) {
    case "map":
      leaveStart();
      tabButtons.find((b) => b.getAttribute("aria-pressed") === "true")?.focus();
      return;
    case "here":
    case "forests":
      if (pinLngLat) landWithPin(landing.kind, null, pinLngLat);
      return;
    case "season":
      leaveStart();
      showTab("svampe");
      sheet.snapTo("half");
      void panelReady.then(
        (p) => {
          p.showList({ seasonOnly: landing.filter });
          p.focusList();
        },
        () => {},
      );
      return;
    case "species":
      return openSpeciesFromStart(landing.slug);
  }
}

/** The start screen stays up until the species' document is here, so the
 * switch to its page is one step, not list-then-page. */
async function openSpeciesFromStart(slug: string): Promise<boolean> {
  try {
    const [p, manifest] = await Promise.all([panelReady, manifestReady]);
    const species = manifest.species.find((s) => s.slug === slug);
    if (!species) return false;
    await loadSpecies(species.file); // cached: the panel's own load is then immediate
    if (!start.isOpen()) return true; // the user went elsewhere meanwhile
    leaveStart();
    showTab("svampe");
    return await p.openSpecies(slug); // focuses the page's back button
  } catch (err) {
    console.error(err);
    return false;
  }
}

const start = initStart({
  app: appRoot,
  behind: {
    search: document.getElementById("search") as HTMLElement,
    sheet: document.getElementById("sheet") as HTMLElement,
    map: document.getElementById("map") as HTMLElement,
  },
  manifest: manifestReady,
  reloadManifest: reloadPayload,
  getPinLabel: () =>
    pinLngLat ? (readout.querySelector(".loc-title")?.textContent ?? "Nål på kortet") : null,
  locate,
  cancelLocate,
  searchForests,
  onPlace: onPlaceChosen,
  enter: enterFromStart,
  onViewChange: () => syncMapToStart({ ease: true }),
});

// "Home": the wordmark (desktop), the mark in the search field (phone) and the
// house button beside the Svampe/Skove switch all open the start screen.
for (const button of document.querySelectorAll<HTMLElement>("[data-home]")) {
  button.addEventListener("click", () => {
    start.open({ fromMain: true });
    syncMapToStart();
  });
}

if (storedPin) setPin(storedPin.lngLat, restoredLabel(storedPin.label));
// The inline script in index.html made the same call before the first paint;
// this settles it (it differs only if what was stored turned out unusable).
if (shouldShowStart(window.location.search, storedPin)) start.open();
else start.close();
