// The finds on the map. One GeoJSON source, drawn density-first: at national
// zoom a soft heat layer plus pin-prick dots show where a species turns up
// without burying the basemap labels; zooming in, the heat fades and the dots
// grow into separate marks. Fill tells the season: solid dots were found at
// this time of year, pale rings at some other time.
//
// A tap on the map always places the pin (main.ts). When finds lie within
// reach of that tap, a card attached to the pin summarises them.

import type maplibregl from "maplibre-gl";
import { fitCamera, mapInsets, visibleCenter, visibleTest } from "./camera";
import { INSPECT_ZOOM, legendFor, seasonWindowLabel } from "./maplegend";
import {
  MAX_COLOURED_SPECIES,
  mapColors,
  prefersReducedMotion,
  speciesColor,
  withAlpha,
} from "./palette";
import type { ObservationPoint, SpeciesDoc } from "./types";

const SOURCE_ID = "observations";
const HEAT_ID = "observations-heat";
const LAYER_ID = "observations-circles";
/** The heat layer is gone by this zoom. */
const HEAT_MAX_ZOOM = 10;

const MONTHS = [
  "januar",
  "februar",
  "marts",
  "april",
  "maj",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "december",
];
const MONTH_INITIALS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

/** A find counts as "this time of year" when its month is the current month
 * or one either side (December and January are neighbours). */
export function inSeason(month: number, currentMonth: number): boolean {
  const gap = Math.abs(month - currentMonth);
  return Math.min(gap, 12 - gap) <= 1;
}

interface ShownSpecies {
  name: string;
  color: string;
}

/**
 * - `single`: one open species, in the find colour, with the density layer.
 * - `species`: a search matching a few species, one palette colour each.
 * - `many`: a search matching more species than can be told apart by colour;
 *   all in the find colour with the density layer.
 */
type Mode = "single" | "species" | "many";

interface State {
  mode: Mode;
  /** The species that have finds; feature property `k` indexes this list. */
  species: ShownSpecies[];
  month: number;
  /** Identifies the set of finds on the map, to spot a no-op update. */
  signature: string;
}

const states = new WeakMap<maplibregl.Map, State>();

function currentMonth(): number {
  return new Date().getMonth() + 1;
}

/** Which matched species get drawn, and how. Species without finds are left
 * out entirely; the rest keep the palette colour of their position in the
 * matched list (what the panel's own legend shows) until there are more than
 * MAX_COLOURED_SPECIES of them. */
export function planSpecies(
  docs: readonly { danish_name: string; observations: readonly unknown[] }[],
  findColor: string,
): { mode: Mode; species: ShownSpecies[]; shown: number[] } {
  const shown = docs.map((_, i) => i).filter((i) => docs[i].observations.length > 0);
  const coloured = shown.length <= MAX_COLOURED_SPECIES;
  return {
    mode: coloured ? "species" : "many",
    shown,
    species: shown.map((i) => ({
      name: docs[i].danish_name,
      color: coloured ? speciesColor(i) : findColor,
    })),
  };
}

/** Feature properties: `m` month, `s` 1 when in season, `k` index into the
 * shown species, `i` a running id used to de-duplicate hit-test results. */
function toFeatureCollection(
  groups: readonly (readonly ObservationPoint[])[],
  month: number,
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  groups.forEach((points, k) => {
    for (const [lon, lat, m] of points) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: { m, s: inSeason(m, month) ? 1 : 0, k, i: features.length },
      });
    }
  });
  return { type: "FeatureCollection", features };
}

export interface Framing {
  bounds: [[number, number], [number, number]];
  maxZoom: number;
}

interface MapView {
  center: [number, number];
  zoom: number;
  contains: (point: [number, number]) => boolean;
}

/**
 * Decide how to reframe the map when a species' finds load.
 *
 * Returns `null` to leave the camera where it is — a find is already on screen,
 * so the user keeps their zoom and their pin. Otherwise returns a bounds that
 * spans `center` (the pin when it is in view, else the middle of the visible
 * map) and the nearest find, with `maxZoom` pinned to the current zoom: the
 * map only ever zooms *out*, just far enough to bring a find into view, and
 * never jumps to the national extent.
 */
export function framingForNearest(view: MapView, points: ObservationPoint[]): Framing | null {
  if (points.length === 0) return null;
  if (points.some(([lon, lat]) => view.contains([lon, lat]))) return null;

  const [cx, cy] = view.center;
  // Degrees of longitude are shorter than degrees of latitude this far north;
  // without the correction "nearest" leans towards finds due north or south.
  const kx = Math.cos((cy * Math.PI) / 180);
  let nearest = points[0];
  let best = Infinity;
  for (const point of points) {
    const d = ((point[0] - cx) * kx) ** 2 + (point[1] - cy) ** 2;
    if (d < best) {
      best = d;
      nearest = point;
    }
  }

  return {
    bounds: [
      [Math.min(cx, nearest[0]), Math.min(cy, nearest[1])],
      [Math.max(cx, nearest[0]), Math.max(cy, nearest[1])],
    ],
    maxZoom: view.zoom,
  };
}

/**
 * Reframe for a newly opened species. "On screen" means the part of the map
 * the floating UI leaves free, so a find hidden under the phone's bottom sheet
 * doesn't count; and the framing is anchored on the user's pin when they can
 * see it, so bringing a find into view never pushes the pin out of it.
 */
function frameToNearest(
  map: maplibregl.Map,
  points: ObservationPoint[],
  pin: [number, number] | null,
): void {
  const padding = mapInsets(map);
  const contains = visibleTest(map, padding);
  const center = pin && contains(pin) ? pin : visibleCenter(map, padding);
  const framing = framingForNearest({ center, zoom: map.getZoom(), contains }, points);
  if (!framing) return;
  fitCamera(map, framing.bounds, { maxZoom: framing.maxZoom, padding });
}

type Expr = maplibregl.ExpressionSpecification;

function colorExpression(state: State): Expr | string {
  if (state.mode !== "species" || state.species.length === 1) return state.species[0].color;
  const match: unknown[] = ["match", ["get", "k"]];
  state.species.forEach((species, k) => match.push(k, species.color));
  match.push(state.species[0].color); // unreachable: every feature's k is listed
  return match as Expr;
}

/** (Re)apply every paint property that depends on the mode or the theme. */
function applyPaint(map: maplibregl.Map, state: State): void {
  const colors = mapColors();
  const color = colorExpression(state);
  const season: Expr = ["==", ["get", "s"], 1];
  const density = state.mode !== "species";

  map.setPaintProperty(LAYER_ID, "circle-color", color);
  // In-season dots get a halo that lifts them off the basemap; off-season ones
  // are a ring in their own colour around a pale fill.
  map.setPaintProperty(LAYER_ID, "circle-stroke-color", ["case", season, colors.halo, color]);

  const base = state.species[0].color;
  map.setPaintProperty(HEAT_ID, "heatmap-color", [
    "interpolate",
    ["linear"],
    ["heatmap-density"],
    0,
    withAlpha(base, 0),
    0.12,
    withAlpha(base, 0.2),
    0.45,
    withAlpha(base, 0.42),
    1,
    withAlpha(colors.findDeep, 0.62),
  ]);
  map.setLayoutProperty(HEAT_ID, "visibility", density ? "visible" : "none");
  // Fifty species stack far more finds on a spot than one does.
  const weight = state.mode === "many" ? 0.07 : 1;
  map.setPaintProperty(HEAT_ID, "heatmap-intensity", [
    "interpolate",
    ["linear"],
    ["zoom"],
    5,
    0.35 * weight,
    7,
    0.6 * weight,
    9,
    1 * weight,
  ]);

  // With the density layer carrying the national picture the dots start as
  // pin-pricks. Species told apart by colour have only their dots, so those
  // start larger and firmer.
  const many = state.mode === "many";
  const far = many ? [1, 2] : density ? [1.3, 2.4] : [1.9, 3];
  // Dozens of species at national zoom: let the density layer speak and keep
  // the dots faint, or they close into a solid blanket.
  const farOpacity = many ? [0.4, 0.18] : density ? [0.8, 0.4] : [0.95, 0.6];
  map.setPaintProperty(LAYER_ID, "circle-radius", [
    "interpolate",
    ["linear"],
    ["zoom"],
    5,
    far[0],
    8,
    far[1],
    10,
    4.2,
    13,
    6,
    16,
    8,
  ]);
  map.setPaintProperty(LAYER_ID, "circle-opacity", [
    "interpolate",
    ["linear"],
    ["zoom"],
    6,
    ["case", season, farOpacity[0], farOpacity[1]],
    INSPECT_ZOOM,
    ["case", season, 0.95, 0.3],
    12,
    ["case", season, 0.95, 0.2],
  ]);
}

function ensureLayers(map: maplibregl.Map, data: GeoJSON.FeatureCollection): void {
  const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    return;
  }
  map.addSource(SOURCE_ID, { type: "geojson", data });
  const season: Expr = ["==", ["get", "s"], 1];

  map.addLayer({
    id: HEAT_ID,
    type: "heatmap",
    source: SOURCE_ID,
    maxzoom: HEAT_MAX_ZOOM,
    paint: {
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 5, 5, 7, 11, 9, 20],
      "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 8, 1, HEAT_MAX_ZOOM, 0],
    },
  });
  map.addLayer({
    id: LAYER_ID,
    type: "circle",
    source: SOURCE_ID,
    layout: { "circle-sort-key": ["get", "s"] }, // in-season finds on top
    paint: {
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 7, 0, INSPECT_ZOOM, 1, 13, 1.6],
      "circle-stroke-opacity": ["case", season, 0.95, 0.9],
    },
  });
}

function updateLegend(map: maplibregl.Map, state: State): void {
  const many = state.mode === "many";
  legendFor(map).update({
    finds: {
      title:
        state.mode === "single"
          ? `Fund af ${state.species[0].name}`
          : many
            ? `Fund af ${state.species.length} arter`
            : "Fund",
      species: state.mode === "species" ? state.species : [],
      color: state.mode === "species" ? null : state.species[0].color,
      month: state.month,
      density: state.mode !== "species",
    },
  });
}

function show(
  map: maplibregl.Map,
  mode: Mode,
  species: ShownSpecies[],
  groups: readonly (readonly ObservationPoint[])[],
): void {
  const month = currentMonth();
  const signature = [
    mode,
    month,
    ...species.map((sp, k) => `${sp.name}:${sp.color}:${groups[k].length}`),
  ].join("|");
  // The panel sends the same search result again every time the pin moves.
  // Nothing on the map changes then: keep the layers (rebuilding tens of
  // thousands of features per tap would be felt) and keep the find card,
  // which that very tap may just have opened.
  if (states.get(map)?.signature === signature && map.getSource(SOURCE_ID)) return;

  closeFindCard(map); // it described the previous set of finds
  const state: State = { mode, species, month, signature };
  states.set(map, state);
  ensureLayers(map, toFeatureCollection(groups, month));
  applyPaint(map, state);
  updateLegend(map, state);
}

/**
 * Show (or update) the observation layer for one species and frame it. Pass
 * the user's pin so the reframing keeps it in view.
 */
export function showObservations(
  map: maplibregl.Map,
  doc: SpeciesDoc,
  options: { pin?: [number, number] | null } = {},
): void {
  show(map, "single", [{ name: doc.danish_name, color: mapColors().find }], [doc.observations]);
  frameToNearest(map, doc.observations, options.pin ?? null);
}

/**
 * Show every species in `docs` at once (a search like "kantarel" can match
 * several): one colour per species while they can be told apart, one colour
 * and a density layer beyond that — see planSpecies. For a search/chip
 * filter, not a single open species: does not reframe the camera, since that
 * would fire on every keystroke.
 */
export function showObservationsForSpecies(map: maplibregl.Map, docs: readonly SpeciesDoc[]): void {
  const plan = planSpecies(docs, mapColors().find);
  if (plan.species.length === 0) {
    clearObservations(map);
    return;
  }
  show(
    map,
    plan.mode,
    plan.species,
    plan.shown.map((i) => docs[i].observations),
  );
}

export function clearObservations(map: maplibregl.Map): void {
  closeFindCard(map);
  states.delete(map);
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  if (map.getLayer(HEAT_ID)) map.removeLayer(HEAT_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  legendFor(map).update({ finds: null });
}

/** Re-resolve theme-dependent colours (called when the colour scheme flips). */
export function restyleObservations(map: maplibregl.Map): void {
  const state = states.get(map);
  if (!state || !map.getLayer(LAYER_ID)) return;
  if (state.mode !== "species") {
    const find = mapColors().find;
    for (const species of state.species) species.color = find;
  }
  applyPaint(map, state);
  updateLegend(map, state);
}

// --- the find card: what was found where the pin was just placed ---

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface Hit {
  month: number;
  species: number;
}

/** "september (2), oktober (3)" */
function monthSummary(counts: readonly number[]): string {
  return counts
    .map((n, i) => (n > 0 ? `${MONTHS[i]} (${n})` : null))
    .filter((part) => part !== null)
    .join(", ");
}

function monthStrip(counts: readonly number[], month: number): HTMLElement {
  const strip = el("div", "find-card__months");
  strip.setAttribute("role", "img");
  strip.setAttribute("aria-label", `Fund pr. måned: ${monthSummary(counts)}`);
  const max = Math.max(1, ...counts);
  counts.forEach((count, i) => {
    const cell = el("span", "find-card__month");
    if (inSeason(i + 1, month)) cell.dataset.now = "true";
    if (count > 0) cell.dataset.found = "true";
    const bar = el("span", "find-card__bar");
    bar.style.setProperty("--h", count > 0 ? `${Math.max(22, (count / max) * 100)}%` : "0%");
    cell.append(bar, el("span", "find-card__initial", MONTH_INITIALS[i]));
    strip.append(cell);
  });
  return strip;
}

const MAX_CARD_SPECIES = 5;
let cardSerial = 0;

function cardContent(state: State, hits: readonly Hit[], onClose: () => void): HTMLElement {
  const root = el("div", "find-card__content");
  const counts = new Array<number>(12).fill(0);
  const perSpecies = new Map<number, number>();
  for (const hit of hits) {
    counts[hit.month - 1] += 1;
    perSpecies.set(hit.species, (perSpecies.get(hit.species) ?? 0) + 1);
  }
  const ranked = [...perSpecies].sort((a, b) => b[1] - a[1]);
  const onlySpecies = ranked.length === 1 ? state.species[ranked[0][0]] : undefined;
  // One species at the spot: its colour runs through the card. Several: the
  // swatches carry the colours and the month bars stay in the find colour.
  if (onlySpecies) root.style.setProperty("--c", onlySpecies.color);

  const head = el("div", "find-card__head");
  const close = el("button", "find-card__close");
  close.type = "button";
  close.setAttribute("aria-label", "Luk fund ved nålen");
  close.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
    '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  close.addEventListener("click", onClose);

  const single = hits.length === 1;
  const title = el(
    "h3",
    "find-card__title",
    single ? (onlySpecies?.name ?? "Fund") : `${hits.length} fund ved nålen`,
  );
  title.id = `find-card-title-${++cardSerial}`;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-labelledby", title.id);
  head.append(title, close);
  root.append(head);

  if (single) {
    const month = hits[0].month;
    root.append(el("p", "find-card__line", `Fundet ved nålen i ${MONTHS[month - 1]}`));
    const now = inSeason(month, state.month);
    const badge = el(
      "p",
      "find-card__badge",
      now ? "Samme tid på året som nu" : "En anden tid på året end nu",
    );
    badge.dataset.now = String(now);
    root.append(badge);
  } else {
    const list = el("ul", "find-card__species");
    for (const [k, n] of ranked.slice(0, MAX_CARD_SPECIES)) {
      const species = state.species[k];
      if (!species) continue;
      const item = el("li");
      if (state.mode === "species") {
        // a swatch only where colour tells the species apart on the map
        const swatch = el("span", "find-card__swatch");
        swatch.style.setProperty("--c", species.color);
        item.append(swatch);
      }
      item.append(el("span", "find-card__name", species.name), el("span", "", `${n}`));
      list.append(item);
    }
    const rest = ranked.slice(MAX_CARD_SPECIES);
    if (rest.length > 0) {
      const item = el("li", "find-card__more");
      const n = rest.reduce((sum, [, count]) => sum + count, 0);
      item.append(
        el(
          "span",
          "find-card__name",
          `+ ${rest.length} ${rest.length === 1 ? "art" : "arter"} mere`,
        ),
        el("span", "", `${n}`),
      );
      list.append(item);
    }
    root.append(list, monthStrip(counts, state.month));
    const inWindow = hits.filter((hit) => inSeason(hit.month, state.month)).length;
    root.append(
      el(
        "p",
        "find-card__line find-card__line--muted",
        inWindow > 0
          ? `${inWindow} af dem ${seasonWindowLabel(state.month)}, som nu`
          : `Ingen af dem ${seasonWindowLabel(state.month)}, som nu`,
      ),
    );
  }
  return root;
}

export interface Card {
  popup: maplibregl.Popup;
  lngLat: [number, number];
}

const cards = new WeakMap<maplibregl.Map, Card>();

/** Height of the pin above its tip, plus a little air (mappin.ts / map.css). */
const PIN_CLEARANCE = 50;
export const PIN_CARD_OFFSETS: Record<maplibregl.PositionAnchor, [number, number]> = {
  center: [0, 0],
  left: [20, -22],
  right: [-20, -22],
  bottom: [0, -PIN_CLEARANCE],
  "bottom-left": [0, -PIN_CLEARANCE],
  "bottom-right": [0, -PIN_CLEARANCE],
  top: [0, 14],
  "top-left": [0, 14],
  "top-right": [0, 14],
};

type CardAnchor = "bottom" | "bottom-left" | "bottom-right" | "top" | "top-left" | "top-right";

/**
 * Where the card goes relative to the pin so that it stays on the free part
 * of the map: above the pin when there is room, else below; centred on the
 * pin unless that would cross a side edge, in which case it hangs to the
 * inside. Pure, so it can be tested: all arguments are in map-container
 * pixels.
 */
export function chooseCardAnchor(
  pin: { x: number; y: number },
  card: { width: number; height: number },
  free: { left: number; top: number; right: number; bottom: number },
): CardAnchor {
  const tip = 12;
  const above = pin.y - PIN_CLEARANCE - free.top;
  const below = free.bottom - pin.y - 14;
  const need = card.height + tip;
  const vertical =
    above >= need ? "bottom" : below >= need ? "top" : above >= below ? "bottom" : "top";
  const half = card.width / 2;
  if (pin.x - half < free.left) return `${vertical}-left`;
  if (pin.x + half > free.right) return `${vertical}-right`;
  return vertical;
}

function freeRect(map: maplibregl.Map): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const pad = mapInsets(map);
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  const gap = 8;
  const free = {
    left: pad.left + gap,
    top: pad.top + gap,
    right: w - pad.right - gap,
    bottom: h - pad.bottom - gap,
  };
  // The map key sits in a bottom corner of the free map. While it is a low
  // strip (its one-line form, or the line plus the zoom button) the card
  // stays above it. A tall but narrow key (desktop's open card in the right
  // corner) is passed on its inside. A key both tall and wide (opened on a
  // phone) cannot be steered around and is left to the user, who opened it.
  // On a phone the closed key steps aside while a card is open (map.css) and
  // then takes no room here.
  const frame = map.getContainer().getBoundingClientRect();
  let keyTop = Infinity;
  let keyLeft = Infinity;
  let keyRight = -Infinity;
  for (const part of map.getContainer().querySelectorAll(".map-key > *")) {
    const box = part.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (getComputedStyle(part).visibility === "hidden") continue;
    keyTop = Math.min(keyTop, box.top - frame.top);
    keyLeft = Math.min(keyLeft, box.left - frame.left);
    keyRight = Math.max(keyRight, box.right - frame.left);
  }
  if (keyTop === Infinity) return free;
  const width = free.right - free.left;
  if (free.bottom - keyTop < (free.bottom - free.top) * 0.4) {
    free.bottom = Math.min(free.bottom, keyTop - gap);
  } else if (keyRight - keyLeft < width * 0.4) {
    if (keyLeft - free.left > free.right - keyRight)
      free.right = Math.min(free.right, keyLeft - gap);
    else free.left = Math.max(free.left, keyRight + gap);
  }
  return free;
}

/** Room the pin takes beside the card in the worse case, the card below it:
 * the pin's height above its tip, then the gap under the tip and the card's
 * own pointer (10px) before the card starts. */
const PIN_ROOM = PIN_CLEARANCE + 14 + 12;

/** Put the card on the free part of the map; `pan` also nudges the map when
 * no anchor alone gets it clear (only right after a tap, never on its own). */
export function placeCard(map: maplibregl.Map, card: Card, pan: boolean): void {
  const content = card.popup.getElement()?.querySelector<HTMLElement>(".maplibregl-popup-content");
  if (!content) return;
  const free = freeRect(map);
  // Never taller than the free map less the pin it hangs on: a longer card
  // scrolls inside (its heading and close button stay put, map.css), so that
  // with the map nudged the whole card is on the free map, pin included.
  content.style.maxHeight = `${Math.max(96, Math.floor(free.bottom - free.top - PIN_ROOM))}px`;
  const pin = map.project(card.lngLat);
  const anchor = chooseCardAnchor(
    pin,
    { width: content.offsetWidth, height: content.offsetHeight },
    free,
  );
  if (card.popup.options.anchor !== anchor) {
    card.popup.options.anchor = anchor;
    card.popup.setLngLat(card.lngLat); // re-runs the popup's own placement
  }
  if (!pan) return;

  const frame = map.getContainer().getBoundingClientRect();
  const box = content.getBoundingClientRect();
  const left = box.left - frame.left;
  const top = box.top - frame.top;
  let dx = 0;
  let dy = 0;
  if (box.width <= free.right - free.left) {
    if (left < free.left) dx = left - free.left;
    else if (left + box.width > free.right) dx = left + box.width - free.right;
  }
  if (box.height <= free.bottom - free.top) {
    if (top < free.top) dy = top - free.top;
    else if (top + box.height > free.bottom) dy = top + box.height - free.bottom;
  }
  // ...and the pin it hangs on: its head when the card is below it (a tap
  // right under the search field), its tip when the card is above. The
  // card's height limit above leaves the room.
  if (box.height <= free.bottom - free.top) {
    const head = pin.y - PIN_CLEARANCE;
    if (head - dy < free.top) dy = head - free.top;
    else if (pin.y - dy > free.bottom) dy = pin.y - free.bottom;
  }
  if (dx === 0 && dy === 0) return;
  if (prefersReducedMotion()) {
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    map.jumpTo({ center: map.unproject([w / 2 + dx, h / 2 + dy]) });
  } else {
    map.panBy([dx, dy], { duration: 250 });
  }
}

/** More to say about the spot of a find card (the forest it lies in). */
type FindCardExtra = (lngLat: [number, number]) => HTMLElement | null;
const extras = new WeakMap<maplibregl.Map, FindCardExtra>();

/** Let another layer add its lines to the end of each find card. */
export function setFindCardExtra(map: maplibregl.Map, extra: FindCardExtra): void {
  extras.set(map, extra);
}

/** Whether the find card is open (the forest card then stays away). */
export function findCardIsOpen(map: maplibregl.Map): boolean {
  return cards.has(map);
}

/** Close the find card, if one is open. Never touches the pin. */
export function closeFindCard(map: maplibregl.Map): void {
  const card = cards.get(map);
  if (!card) return;
  cards.delete(map);
  card.popup.remove();
}

/**
 * Tell the card where the pin now is. The card describes the spot the pin was
 * tapped onto; when the pin goes anywhere else (an address, a forest, the
 * user's location, or no pin at all) the card no longer applies and closes.
 */
export function syncFindCard(map: maplibregl.Map, pin: [number, number] | null): void {
  const card = cards.get(map);
  if (!card) return;
  if (!pin || pin[0] !== card.lngLat[0] || pin[1] !== card.lngLat[1]) closeFindCard(map);
}

/**
 * Summarise the finds around each tap in a card attached to the pin. This
 * only ever adds the card: placing the pin is the app's own click handler,
 * which runs for every tap regardless of what is under it.
 */
export function enableFindCard(map: maplibregl.Map, lib: Pick<typeof maplibregl, "Popup">): void {
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const reach = coarse ? 14 : 8;

  map.on("click", (e) => {
    closeFindCard(map);
    const state = states.get(map);
    if (!state || map.getZoom() < INSPECT_ZOOM || !map.getLayer(LAYER_ID)) return;
    const features = map.queryRenderedFeatures(
      [
        [e.point.x - reach, e.point.y - reach],
        [e.point.x + reach, e.point.y + reach],
      ],
      { layers: [LAYER_ID] },
    );
    const seen = new Set<number>();
    const hits: Hit[] = [];
    for (const feature of features) {
      const props = feature.properties as { m: number; k: number; i: number };
      if (seen.has(props.i)) continue;
      seen.add(props.i);
      hits.push({ month: props.m, species: props.k });
    }
    if (hits.length === 0) return;

    const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat]; // where the pin lands
    const popup = new lib.Popup({
      closeButton: false,
      closeOnClick: false, // this handler owns the card's lifetime
      focusAfterOpen: false, // the tap was on the map; don't pull focus off it
      className: "find-card",
      maxWidth: "264px",
      anchor: "bottom",
      offset: PIN_CARD_OFFSETS,
    });
    const card: Card = { popup, lngLat };
    const content = cardContent(state, hits, () => closeFindCard(map));
    const extra = extras.get(map)?.(lngLat);
    if (extra) content.append(extra);
    popup.setDOMContent(content);
    popup.setLngLat(lngLat).addTo(map);
    popup.getElement()?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeFindCard(map);
        map.getCanvas().focus();
      }
    });
    cards.set(map, card);
    placeCard(map, card, true);
  });

  // Zoomed out past the point where finds are separate marks, "the finds at
  // the pin" no longer describes anything on screen.
  map.on("zoom", () => {
    if (cards.has(map) && map.getZoom() < INSPECT_ZOOM) closeFindCard(map);
  });

  // The user panning or the sheet moving can bring the card to an edge.
  map.on("moveend", () => {
    const card = cards.get(map);
    if (card) placeCard(map, card, false);
  });
}
