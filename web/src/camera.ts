// Camera helpers shared by the map layers: how much of the map the floating
// UI covers, and moving the camera without tripping MapLibre's duration-0 bug.

import type maplibregl from "maplibre-gl";
import { prefersReducedMotion } from "./palette";

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A custom property counts only when it is a plain pixel length: the shell's
 * stylesheet defaults are `calc()`/`dvh`/`var()` expressions, which a custom
 * property hands back unresolved. */
function px(value: string): number | null {
  const match = /^\s*(-?\d+(?:\.\d+)?)px\s*$/.exec(value);
  return match ? Number(match[1]) : null;
}

/**
 * The covered pixels on each side of the map, from what the shell publishes.
 *
 * `mapPadding` is the padding the shell gave MapLibre (the search field on
 * top, the sheet at its half height below). `liveBottom` is the shell's
 * `--map-inset-bottom`, which follows the sheet as it is dragged, so a sheet
 * folded to its peek frees the map it no longer covers.
 */
export function insetsFrom(mapPadding: Padding, liveBottom: string): Padding {
  return {
    top: mapPadding.top,
    right: mapPadding.right,
    bottom: px(liveBottom) ?? mapPadding.bottom,
    left: mapPadding.left,
  };
}

/** What `pad` asks for beyond `base`, side by side. MapLibre adds the padding
 * passed to a camera call to the map's own padding, so camera calls must pass
 * only the difference or the covered area is counted twice. */
export function beyond(pad: Padding, base: Padding): Padding {
  return {
    top: Math.max(0, pad.top - base.top),
    right: Math.max(0, pad.right - base.right),
    bottom: Math.max(0, pad.bottom - base.bottom),
    left: Math.max(0, pad.left - base.left),
  };
}

/**
 * THE one place that decides which part of the map is covered by the app's
 * own UI, in pixels from each edge of the map container. Everything else
 * (reframing, the find card, the map key, the forest markers) asks here.
 * On the desktop layout the map is a column of its own and nothing covers it.
 */
export function mapInsets(map: maplibregl.Map): Padding {
  const live = getComputedStyle(map.getContainer()).getPropertyValue("--map-inset-bottom");
  return insetsFrom(map.getPadding(), live);
}

export function visibleTest(
  map: maplibregl.Map,
  pad: Padding,
): (point: [number, number]) => boolean {
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  return (point) => {
    const { x, y } = map.project(point);
    return x >= pad.left && x <= w - pad.right && y >= pad.top && y <= h - pad.bottom;
  };
}

/** The coordinate at the middle of the visible part of the map. */
export function visibleCenter(map: maplibregl.Map, pad: Padding): [number, number] {
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  const { lng, lat } = map.unproject([
    (pad.left + w - pad.right) / 2,
    (pad.top + h - pad.bottom) / 2,
  ]);
  return [lng, lat];
}

/**
 * Fit the camera to `bounds`, keeping it clear of the floating UI.
 * `fitBounds`/`flyTo` with duration 0 NaNs the transform, so under
 * `prefers-reduced-motion` the camera is computed and jumped to instead.
 */
export function fitCamera(
  map: maplibregl.Map,
  bounds: [[number, number], [number, number]],
  options: { maxZoom?: number; margin?: number; padding?: Padding } = {},
): void {
  const pad = options.padding ?? mapInsets(map);
  // Breathing room around the bounds, shrunk when the free area is small so
  // the margin never eats the space it is meant to frame.
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  const free = Math.min(w - pad.left - pad.right, h - pad.top - pad.bottom);
  const margin = Math.max(8, Math.min(options.margin ?? 64, free / 6));
  const extra = beyond(pad, map.getPadding()); // MapLibre adds its own padding
  const opts = {
    padding: {
      top: extra.top + margin,
      right: extra.right + margin,
      bottom: extra.bottom + margin,
      left: extra.left + margin,
    },
    // Only when set: an explicit `maxZoom: undefined` overrides MapLibre's own
    // default and the camera comes out NaN.
    ...(options.maxZoom === undefined ? {} : { maxZoom: options.maxZoom }),
  };
  if (prefersReducedMotion()) {
    const camera = map.cameraForBounds(bounds, opts);
    if (camera) map.jumpTo(camera);
  } else {
    map.fitBounds(bounds, { ...opts, duration: 600 });
  }
}
