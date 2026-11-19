// The "my location" button: one position per press, and nothing else. It
// asks the browser once, shows the answer as a dot and announces it; it does
// not move the camera. The app (main.ts) decides what an answer may do -- set
// the pin and fly there, or nothing at all when the user has chosen a spot of
// their own while waiting (locate.ts). MapLibre's own GeolocateControl was
// tried first: in follow mode it kept re-setting the pin, and even without
// it, it flies to every answer before telling anyone, so a slow cold-start
// fix took the view away from a forest the user had tapped meanwhile.
//
// It looks like MapLibre's control (same classes, so the same icon and the
// "waiting" pulse) and answers to the same three calls the app made of it:
// on("geolocate" | "error"), off(...), trigger().

import type { IControl, Map as MapLibreMap, Marker } from "maplibre-gl";

type Listener = (event: GeolocationPosition | GeolocationPositionError) => void;

export interface LocateControlOptions {
  positionOptions?: PositionOptions;
  /** For the dot (a Marker), without a second static import of MapLibre. */
  makeMarker: (element: HTMLElement) => Marker;
}

export class LocateControl implements IControl {
  private map: MapLibreMap | null = null;
  private container: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private dot: Marker | null = null;
  private pending = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly options: LocateControlOptions) {}

  onAdd(map: MapLibreMap): HTMLElement {
    this.map = map;
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "maplibregl-ctrl-geolocate";
    button.title = "Find min placering";
    button.setAttribute("aria-label", "Find min placering");
    const icon = document.createElement("span");
    icon.className = "maplibregl-ctrl-icon";
    icon.setAttribute("aria-hidden", "true");
    button.append(icon);
    if (!("geolocation" in navigator)) button.disabled = true;
    button.addEventListener("click", () => this.trigger());
    container.append(button);
    this.container = container;
    this.button = button;
    return container;
  }

  onRemove(): void {
    this.dot?.remove();
    this.container?.remove();
    this.map = null;
  }

  on(type: "geolocate" | "error", listener: Listener): this {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
    return this;
  }

  off(type: "geolocate" | "error", listener: Listener): this {
    this.listeners.get(type)?.delete(listener);
    return this;
  }

  private fire(type: string, event: GeolocationPosition | GeolocationPositionError): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  /** Ask for the position once. False when it cannot be asked at all. */
  trigger(): boolean {
    if (!this.map || !("geolocation" in navigator)) return false;
    if (this.pending) return true; // one question at a time; its answer serves both
    this.pending = true;
    this.button?.classList.add("maplibregl-ctrl-geolocate-waiting");
    this.button?.setAttribute("aria-busy", "true");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        this.settle(null);
        this.showDot(position);
        this.fire("geolocate", position);
      },
      (error) => {
        this.settle(error);
        this.fire("error", error);
      },
      this.options.positionOptions,
    );
    return true;
  }

  private settle(error: GeolocationPositionError | null): void {
    this.pending = false;
    this.button?.classList.remove("maplibregl-ctrl-geolocate-waiting");
    this.button?.removeAttribute("aria-busy");
    // a refusal is shown on the button as MapLibre's control does
    this.button?.classList.toggle("maplibregl-ctrl-geolocate-active-error", error?.code === 1);
  }

  private showDot(position: GeolocationPosition): void {
    if (!this.map) return;
    const at: [number, number] = [position.coords.longitude, position.coords.latitude];
    if (!this.dot) {
      const element = document.createElement("div");
      element.className = "maplibregl-user-location-dot";
      this.dot = this.options.makeMarker(element);
    }
    this.dot.setLngLat(at).addTo(this.map);
  }
}
