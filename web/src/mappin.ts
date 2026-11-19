// The user's pin: an HTML marker, so it is styled from the design tokens in
// style.css (.map-pin) and follows the theme without any paint-expression hex.

import type maplibregl from "maplibre-gl";

const PIN_SVG =
  '<svg class="map-pin__body" viewBox="0 0 34 44" width="34" height="44" aria-hidden="true" focusable="false">' +
  '<path class="map-pin__shape" d="M17 1.5c-8.6 0-15.5 6.8-15.5 15.2 0 10.9 12.6 22.3 14.7 25.3a1 1 0 0 0 1.6 0c2.1-3 14.7-14.4 14.7-25.3C32.5 8.3 25.6 1.5 17 1.5z"/>' +
  '<circle class="map-pin__eye" cx="17" cy="16.5" r="5.6"/>' +
  "</svg>";

/**
 * Build the pin marker. The marker's own element is positioned by MapLibre
 * (it owns that element's transform), so everything that animates lives on
 * children: the pin body drops in, and a ring ripples out once from the spot
 * it marks. Both are switched off under `prefers-reduced-motion` in the CSS.
 */
export function createPinMarker(lib: Pick<typeof maplibregl, "Marker">): maplibregl.Marker {
  const element = document.createElement("div");
  element.className = "map-pin";
  element.innerHTML =
    '<span class="map-pin__ripple"></span><span class="map-pin__ground"></span>' + PIN_SVG;
  return new lib.Marker({ element, anchor: "bottom" });
}

/** Give the placed marker a Danish accessible name (MapLibre's is "Map marker"). */
export function labelPinMarker(marker: maplibregl.Marker): void {
  const element = marker.getElement();
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", "Din nål");
}
