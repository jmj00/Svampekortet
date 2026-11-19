// Numbered markers for the forests in the "forests near me" result list, so
// the list and the map read as one thing: marker 3 is row 3. Plain DOM markers
// (maplibregl.Marker), not a style layer, so there are no layer or source ids
// to collide with the find dots or the forests coloured by score. Everything is
// added and removed through the functions below; nothing else needs to know.
//
// Forests often lie closer together than a marker is wide (and one of them
// may be where the pin stands), so the markers are laid out in screen space on
// every camera move: rank 1 keeps its true spot, each later marker is nudged
// just clear of the ones before it and of the pin, and a nudged marker draws a
// short leader back to where the forest really is.

import { beyond } from "./camera";
import type { Map as MapLibreMap, Marker } from "maplibre-gl";
import type { MapBundle } from "./map";

export interface ForestMarkerItem {
  name: string;
  lon: number;
  lat: number;
  /** Accessible name, e.g. "1. Hjortemose, forholdstal 48 af 100". */
  label: string;
}

export interface ForestMarkerHandlers {
  onSelect(index: number): void;
  /** Pointer entered (index) or left (null) a marker. */
  onHover(index: number | null): void;
  /** The pin, which the markers keep clear of; null when there is none. */
  getPin(): [number, number] | null;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Centre-to-centre distance at which two markers no longer touch (px). */
const MARKER_GAP = 31;
/** The pin is drawn above its point: a disc around its body to stay out of. */
const PIN_BODY = { dy: -20, radius: 21 };
const MARKER_RADIUS = 15;
/** A marker this near a side edge hangs its name tag inwards. */
const EDGE_ZONE = 100;

/** Screen positions for markers whose true positions are `points` (in rank
 * order), nudged so none sits on an earlier one or on an obstacle disc. The
 * first point only ever moves for an obstacle. Pure, for testing. */
export function spreadPoints(
  points: readonly Point[],
  obstacles: readonly (Point & { radius: number })[] = [],
  gap = MARKER_GAP,
): Point[] {
  const placed = points.map((p) => ({ ...p }));
  const push = (p: Point, from: Point, distance: number, index: number): void => {
    let dx = p.x - from.x;
    let dy = p.y - from.y;
    let length = Math.hypot(dx, dy);
    if (length < 0.01) {
      // coincident: fan out by rank so equal points do not stack again
      const angle = index * 2.4;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
      length = 1;
    }
    p.x = from.x + (dx / length) * distance;
    p.y = from.y + (dy / length) * distance;
  };
  for (let pass = 0; pass < 24; pass++) {
    let moved = false;
    for (let i = 0; i < placed.length; i++) {
      for (const obstacle of obstacles) {
        const reach = obstacle.radius + MARKER_RADIUS;
        if (Math.hypot(placed[i].x - obstacle.x, placed[i].y - obstacle.y) < reach - 0.5) {
          push(placed[i], obstacle, reach, i);
          moved = true;
        }
      }
      for (let j = 0; j < i; j++) {
        if (Math.hypot(placed[i].x - placed[j].x, placed[i].y - placed[j].y) < gap - 0.5) {
          push(placed[i], placed[j], gap, i);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return placed;
}

interface Entry {
  marker: Marker;
  lngLat: [number, number];
  name: string;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const TAG_SIDES = ["below", "above", "right", "left"] as const;
type TagSide = (typeof TAG_SIDES)[number];

/** Roughly where a marker's name tag is drawn on each side of it (px). */
function tagBox(at: Point, side: TagSide, tagWidth: number, mapWidth: number): Box {
  const height = 24;
  if (side === "right") {
    return { left: at.x + 18, right: at.x + 18 + tagWidth, top: at.y - 12, bottom: at.y + 12 };
  }
  if (side === "left") {
    return { left: at.x - 18 - tagWidth, right: at.x - 18, top: at.y - 12, bottom: at.y + 12 };
  }
  // centred under or over the marker, hanging inwards near a side edge
  let left = at.x - tagWidth / 2;
  if (at.x < EDGE_ZONE) left = at.x - 19;
  else if (at.x > mapWidth - EDGE_ZONE) left = at.x + 19 - tagWidth;
  const top = side === "below" ? at.y + 15 : at.y - 15 - height;
  return { left, right: left + tagWidth, top, bottom: top + height };
}

const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** The first side on which marker `index`'s tag covers no other marker and
 * not the pin, and stays inside the map; "below" if none is free. Pure. */
export function pickTagSide(
  index: number,
  placed: readonly Point[],
  tagWidth: number,
  mapWidth: number,
  blocked: readonly Box[] = [],
): TagSide {
  const others: Box[] = [...blocked];
  placed.forEach((p, i) => {
    if (i !== index) {
      others.push({
        left: p.x - MARKER_RADIUS,
        right: p.x + MARKER_RADIUS,
        top: p.y - MARKER_RADIUS,
        bottom: p.y + MARKER_RADIUS,
      });
    }
  });
  for (const side of TAG_SIDES) {
    const box = tagBox(placed[index], side, tagWidth, mapWidth);
    if (box.left < 2 || box.right > mapWidth - 2) continue;
    if (!others.some((other) => overlaps(box, other))) return side;
  }
  return "below";
}

let entries: Entry[] = [];
let originMarker: Marker | null = null;
let layoutMap: MapLibreMap | null = null;
let currentPin: () => [number, number] | null = () => null;

/** Re-run the screen-space layout (camera moved, or the pin did). */
export function layoutForestMarkers(): void {
  const map = layoutMap;
  if (!map || entries.length === 0) return;
  const truePoints = entries.map(({ lngLat }) => map.project(lngLat));
  const pin = currentPin();
  const obstacles: (Point & { radius: number })[] = [];
  if (pin) {
    const p = map.project(pin);
    obstacles.push({ x: p.x, y: p.y + PIN_BODY.dy, radius: PIN_BODY.radius });
  }
  const placed = spreadPoints(truePoints, obstacles);
  const width = map.getContainer().clientWidth;
  const blocked: Box[] = [];
  if (pin) {
    const p = map.project(pin);
    blocked.push({ left: p.x - 15, right: p.x + 15, top: p.y - 42, bottom: p.y + 2 });
  }
  entries.forEach(({ marker, name }, index) => {
    const dx = placed[index].x - truePoints[index].x;
    const dy = placed[index].y - truePoints[index].y;
    const element = marker.getElement();
    const moved = Math.hypot(dx, dy) > 1;
    marker.setOffset([dx, dy]);
    element.dataset.moved = String(moved);
    if (moved) {
      element.style.setProperty("--stem-length", `${Math.hypot(dx, dy).toFixed(1)}px`);
      element.style.setProperty("--stem-angle", `${Math.atan2(-dy, -dx).toFixed(3)}rad`);
    }
    const x = placed[index].x;
    if (x < EDGE_ZONE) element.dataset.edge = "left";
    else if (x > width - EDGE_ZONE) element.dataset.edge = "right";
    else delete element.dataset.edge;
    // the name tag goes on the side where it covers no neighbour and not the pin
    const tagWidth = Math.min(192, name.length * 7.4 + 18);
    element.dataset.tag = pickTagSide(index, placed, tagWidth, width, blocked);
  });
}

/** Replace the current forest markers with one numbered marker per item. */
export function showForestMarkers(
  { map, maplibregl }: MapBundle,
  items: readonly ForestMarkerItem[],
  handlers: ForestMarkerHandlers,
): void {
  clearForestMarkers();
  entries = items.map((item, index) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "forest-marker";
    element.tabIndex = -1; // the result list is the keyboard route to the same action
    element.setAttribute("aria-label", item.label);
    const stem = document.createElement("span");
    stem.className = "forest-marker__stem";
    const dot = document.createElement("span");
    dot.className = "forest-marker__dot";
    dot.textContent = String(index + 1);
    const tag = document.createElement("span");
    tag.className = "forest-marker__tag";
    tag.textContent = item.name;
    element.append(stem, dot, tag);
    element.addEventListener("click", (event) => {
      event.stopPropagation(); // not a map click: do not drop the pin underneath
      handlers.onSelect(index);
    });
    element.addEventListener("pointerenter", () => handlers.onHover(index));
    element.addEventListener("pointerleave", () => handlers.onHover(null));
    const lngLat: [number, number] = [item.lon, item.lat];
    const marker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(lngLat);
    return { marker, lngLat, name: item.name };
  });
  // Stacking is by document order, not z-index (the map has no stacking
  // context of its own, so a z-index here would compete with the panels over
  // the map): added last-first, rank 1 ends up on top, and the pin, which is
  // re-added whenever it moves, stays above them all.
  for (let i = entries.length - 1; i >= 0; i--) entries[i].marker.addTo(map);
  layoutMap = map;
  currentPin = handlers.getPin;
  map.on("move", layoutForestMarkers);
  layoutForestMarkers();
}

/** Mark where the search was centred, once the pin has moved on from there. */
export function showForestOrigin({ map, maplibregl }: MapBundle, lngLat: [number, number]): void {
  clearForestOrigin();
  const element = document.createElement("div");
  element.className = "forest-origin";
  element.title = "Her søgte du fra";
  originMarker = new maplibregl.Marker({ element, anchor: "center" }).setLngLat(lngLat).addTo(map);
}

export function clearForestOrigin(): void {
  originMarker?.remove();
  originMarker = null;
}

export function clearForestMarkers(): void {
  layoutMap?.off("move", layoutForestMarkers);
  layoutMap = null;
  for (const { marker } of entries) marker.remove();
  entries = [];
  clearForestOrigin();
}

/** Reflect the list's hover/focus (`active`) and choice (`selected`) on the map. */
export function setForestMarkerState(active: number | null, selected: number | null): void {
  entries.forEach(({ marker }, index) => {
    const element = marker.getElement();
    element.classList.toggle("is-active", index === active);
    element.classList.toggle("is-selected", index === selected);
  });
}

/** Whether a point is inside the padded viewport. */
export function isInView({ map }: MapBundle, point: [number, number], padding: Padding): boolean {
  const { clientWidth: width, clientHeight: height } = map.getContainer();
  const { x, y } = map.project(point);
  return (
    x >= padding.left &&
    x <= width - padding.right &&
    y >= padding.top &&
    y <= height - padding.bottom
  );
}

/** True when every point is inside the padded viewport and they are spread
 * far enough apart on screen to be told from one another. */
function alreadyFramed(
  map: MapLibreMap,
  points: readonly [number, number][],
  padding: Padding,
): boolean {
  const { clientWidth: width, clientHeight: height } = map.getContainer();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    const { x, y } = map.project(point);
    if (
      x < padding.left ||
      x > width - padding.right ||
      y < padding.top ||
      y > height - padding.bottom
    ) {
      return false;
    }
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return points.length < 2 || Math.max(maxX - minX, maxY - minY) >= 140;
}

/** Move the camera so all `points` are visible inside `padding`, unless they
 * already are. `animate: false` jumps (reduced motion). */
export function frameForests(
  { map, maplibregl }: MapBundle,
  points: readonly [number, number][],
  padding: Padding,
  animate: boolean,
): void {
  if (points.length === 0) return;
  // Never let the padding swallow the whole canvas: cameraForBounds cannot
  // fit anything into a non-positive box.
  const { clientWidth: width, clientHeight: height } = map.getContainer();
  const safe: Padding = { ...padding };
  if (width - safe.left - safe.right < 160) {
    safe.left = 24;
    safe.right = 24;
  }
  if (height - safe.top - safe.bottom < 160) {
    safe.top = 24;
    safe.bottom = 24;
  }
  if (alreadyFramed(map, points, safe)) return;

  const bounds = new maplibregl.LngLatBounds(points[0], points[0]);
  for (const point of points) bounds.extend(point);
  // `safe` is measured from the map's edges; MapLibre adds its own padding.
  const extra = beyond(safe, map.getPadding());
  const camera = map.cameraForBounds(bounds, { padding: extra, maxZoom: 14 });
  if (!camera || camera.zoom === undefined || !Number.isFinite(camera.zoom)) return;
  if (animate) {
    // easeTo, not flyTo: a zero-length flight divides by zero in flyTo's maths.
    map.easeTo({ ...camera, duration: 700 });
  } else {
    map.jumpTo(camera);
  }
}
