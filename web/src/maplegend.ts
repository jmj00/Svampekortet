// The map key: explains whichever data layers are on the map right now (find
// marks, find density, the forests coloured by score, the pin's radius). The layer
// modules push their state in through `legendFor(map).update(...)`; with no
// layers it hides.
//
// It is a self-contained element inside the map container, placed from the
// `--map-inset-*` custom properties (see map.css): on a phone a slim one-line
// key at the bottom left of the visible map, on desktop a compact card at the
// bottom right above the attribution. Tapping the line opens the full key.

import type maplibregl from "maplibre-gl";
import { mapInsets } from "./camera";
import { forestRamp, type ForestRamp } from "./palette";

/** From this zoom the finds are separate marks and a tap near them opens the
 * find card; below it they read as density. Shared with observations.ts. */
export const INSPECT_ZOOM = 9;
/** Below this the forests around the pin are too small to tell apart. */
const FORESTS_ZOOM = 9.5;

const MONTHS_SHORT = [
  "jan",
  "feb",
  "mar",
  "apr",
  "maj",
  "jun",
  "jul",
  "aug",
  "sep",
  "okt",
  "nov",
  "dec",
];

export interface LegendFinds {
  /** "Fund af Tragt-Kantarel", "Fund af 50 arter" or plain "Fund". */
  title: string;
  /** One row per species when each has its own colour; else empty. */
  species: { name: string; color: string }[];
  /** The one colour all finds share, or null when coloured per species. */
  color: string | null;
  /** Month (1-12) the "this time of year" window is centred on. */
  month: number;
  /** Whether the density (heat) layer is drawn at low zoom. */
  density: boolean;
}

/** Forests are coloured by score around the pin. */
export interface LegendForests {
  /** Bring the pin and the forests around it into view. */
  zoomTo: () => void;
}

/** The dashed ring around the pin. */
export interface LegendRing {
  /** How far away finds count towards the score at the pin (km). */
  radiusKm: number;
}

interface LegendState {
  finds: LegendFinds | null;
  forests: LegendForests | null;
  /** Said in place of the classes when forests were scored and none is
   * drawn (a day with nothing promising in reach). */
  forestsNote: { long: string; short: string } | null;
  ring: LegendRing | null;
}

const STORAGE_KEY = "svampekortet.legend";

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

/** "okt–dec" for a window centred on `month` (1-12). */
export function seasonWindowLabel(month: number): string {
  const prev = MONTHS_SHORT[(month + 10) % 12];
  const next = MONTHS_SHORT[month % 12];
  return `${prev}–${next}`;
}

function readStoredOpen(): boolean | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "open" ? true : stored === "closed" ? false : null;
  } catch {
    return null;
  }
}

function storeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, open ? "open" : "closed");
  } catch {
    // private mode / blocked storage: the choice just doesn't persist
  }
}

/** `#rrggbb` + alpha as a flat CSS image layer. */
function layer(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const rgba = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  return `linear-gradient(${rgba}, ${rgba})`;
}

/**
 * The score classes as swatches, painted the way the map paints them: the
 * class tint over the basemap's forest colour with the class's edge, so a
 * swatch looks like the forest it stands for in either theme. The lowest
 * class is the bare forest with a thin grey edge.
 */
function rampSwatches(ramp: ForestRamp, className: string): HTMLElement {
  const row = el("span", className);
  for (const cls of ramp.classes) {
    const swatch = el("span");
    const layers = [layer(ramp.backing, 1)];
    if (cls.color) layers.unshift(layer(cls.color, cls.opacity));
    swatch.style.backgroundImage = layers.join(", ");
    swatch.style.setProperty("--edge", cls.line);
    row.append(swatch);
  }
  return row;
}

const ZOOM_ICON =
  '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">' +
  '<circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
  '<path d="M12.8 12.8L17 17M8.5 6v5M6 8.5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

export class MapLegend {
  private state: LegendState = { finds: null, forests: null, forestsNote: null, ring: null };
  private readonly root: HTMLDivElement;
  private readonly zoom: HTMLButtonElement;
  private readonly toggle: HTMLButtonElement;
  private readonly summary: HTMLSpanElement;
  private readonly panel: HTMLDivElement;
  private open: boolean;

  constructor(private readonly map: maplibregl.Map) {
    this.root = el("div", "map-key");
    this.root.hidden = true;

    this.panel = el("div", "map-key__panel");
    this.panel.id = "map-key-panel";
    this.panel.setAttribute("role", "region");
    this.panel.setAttribute("aria-label", "Signaturforklaring");

    // "Zoom ind til nålen": its own map button, reachable without opening
    // the key, shown only while the coloured forests are too small to read.
    this.zoom = el("button", "map-key__zoom");
    this.zoom.type = "button";
    this.zoom.innerHTML = ZOOM_ICON;
    // (beside the open key on a phone there is room for the first two words)
    this.zoom.setAttribute("aria-label", "Zoom ind til nålen");
    this.zoom.append(
      el("span", undefined, "Zoom ind"),
      el("span", "map-key__zoom-rest", " til nålen"),
    );
    this.zoom.addEventListener("click", () => this.state.forests?.zoomTo());

    this.toggle = el("button", "map-key__toggle");
    this.toggle.type = "button";
    this.toggle.setAttribute("aria-controls", this.panel.id);
    this.summary = el("span", "map-key__summary");
    const chevron = el("span", "map-key__chevron");
    chevron.setAttribute("aria-hidden", "true");
    this.toggle.append(this.summary, el("span", "map-key__name", "Signaturforklaring"), chevron);

    const narrow = window.matchMedia?.("(max-width: 719.98px)").matches ?? false;
    this.open = readStoredOpen() ?? !narrow;
    this.toggle.addEventListener("click", () => {
      this.open = !this.open;
      storeOpen(this.open);
      this.applyOpen();
    });

    this.root.append(this.zoom, this.panel, this.toggle);
    this.applyOpen();

    map.getContainer().append(this.root);
    map.on("zoom", this.onZoom);
    this.onZoom();
    this.trackInsets();
  }

  update(patch: Partial<LegendState>): void {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  /** Redraw after a theme change (the score swatches are theme-specific). */
  refresh(): void {
    this.render();
  }

  private applyOpen(): void {
    this.root.dataset.open = String(this.open);
    this.toggle.setAttribute("aria-expanded", String(this.open));
    this.panel.hidden = !this.open;
  }

  private readonly onZoom = (): void => {
    const zoom = this.map.getZoom();
    const finds = zoom < INSPECT_ZOOM ? "far" : "near";
    const forests = zoom < FORESTS_ZOOM ? "far" : "near";
    if (this.root.dataset.finds !== finds) this.root.dataset.finds = finds;
    if (this.root.dataset.forests !== forests) this.root.dataset.forests = forests;
  };

  /**
   * Fallback for layouts without the shell's `--map-inset-*` properties: keep
   * `--map-key-bottom` / `--map-key-left` (which map.css falls back to) equal
   * to what mapInsets() measures, so the key rides the top of the bottom
   * sheet. With the shell's properties present the CSS never reads these.
   */
  private trackInsets(): void {
    const apply = (): void => {
      const pad = mapInsets(this.map);
      this.root.style.setProperty("--map-key-bottom", `${Math.round(pad.bottom)}px`);
      this.root.style.setProperty("--map-key-left", `${Math.round(pad.left)}px`);
    };
    apply();
    const parent = this.map.getContainer().parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(this.map.getContainer());
    for (const sibling of parent.children) observer.observe(sibling);
    // siblings shown/hidden by attribute (the phone's tab switch) don't always
    // resize, so watch for those too
    new MutationObserver(apply).observe(parent, {
      attributes: true,
      subtree: true,
      attributeFilter: ["data-mobile-tab", "data-view", "hidden", "class"],
    });
  }

  private render(): void {
    const { finds, forests, forestsNote, ring: pinRing } = this.state;
    this.root.hidden = !finds && !forests && !forestsNote && !pinRing;
    this.zoom.hidden = !forests;
    this.panel.replaceChildren();
    this.summary.replaceChildren();
    const ramp = forestRamp();

    if (finds) {
      this.panel.append(this.findsSection(finds));
      const span = seasonWindowLabel(finds.month);
      const solid = el("span", "map-key__dot");
      const ring = el("span", "map-key__dot map-key__dot--ring");
      if (finds.color) {
        solid.style.setProperty("--c", finds.color);
        ring.style.setProperty("--c", finds.color);
      }
      this.summary.append(
        solid,
        el("span", undefined, span),
        ring,
        el("span", undefined, "resten af året"),
      );
    }
    if (forests || forestsNote || pinRing) {
      this.panel.append(
        this.pinSection(Boolean(forests), forestsNote?.long ?? null, pinRing, ramp),
      );
    }
    if (forests) {
      // a group of its own, so that it goes to a second line where the
      // finds' marks already fill the first (a phone)
      const group = el("span", "map-key__summary-group");
      group.append(
        rampSwatches(ramp, "map-key__mini-ramp"),
        el("span", undefined, "skovenes forhold"),
      );
      this.summary.append(group);
    } else if (forestsNote) {
      // the same place on a day with nothing to colour, so that the closed
      // key says why the map is bare
      const group = el("span", "map-key__summary-group map-key__summary-note");
      group.append(el("span", undefined, forestsNote.short));
      this.summary.append(group);
    }

    const parts: string[] = [];
    if (finds) parts.push(finds.title);
    if (forests) parts.push("forhold i skovene i dag");
    else if (forestsNote) parts.push(forestsNote.short);
    this.toggle.setAttribute("aria-label", `Signaturforklaring: ${parts.join(", ")}`);
  }

  private findsSection(finds: LegendFinds): HTMLElement {
    const section = el("section", "map-key__section");
    section.append(el("h3", "map-key__title", finds.title));

    if (finds.species.length > 1) {
      // dropped on phones (map.css): the panel's own list names the species
      const list = el("ul", "map-key__list map-key__species");
      for (const species of finds.species) {
        const item = el("li", "map-key__row");
        const dot = el("span", "map-key__dot");
        dot.style.setProperty("--c", species.color);
        item.append(dot, el("span", undefined, species.name));
        list.append(item);
      }
      section.append(list);
    }

    const season = el("ul", "map-key__list");
    const now = el("li", "map-key__row");
    const solid = el("span", "map-key__dot");
    const then = el("li", "map-key__row");
    const ring = el("span", "map-key__dot map-key__dot--ring");
    const color = finds.color ?? (finds.species.length === 1 ? finds.species[0].color : null);
    if (color) {
      solid.style.setProperty("--c", color);
      ring.style.setProperty("--c", color);
    }
    now.append(solid, el("span", undefined, `Fundet ${seasonWindowLabel(finds.month)}, som nu`));
    then.append(ring, el("span", undefined, "Fundet resten af året"));
    season.append(now, then);
    section.append(season);

    if (finds.density && finds.color) {
      const density = el("div", "map-key__density");
      const bar = el("span", "map-key__density-bar");
      bar.style.setProperty("--c", finds.color);
      density.append(el("span", undefined, "Få fund"), bar, el("span", undefined, "mange"));
      section.append(density);
    }

    section.append(
      el("p", "map-key__hint map-key__hint--far", "Zoom ind for at se de enkelte fund."),
      el("p", "map-key__hint map-key__hint--near", "Sæt nålen ved et fund for at se art og måned."),
    );
    return section;
  }

  /** What is drawn around the pin for the open species: the forests in the
   * colour of their score (when there are any) and the ring. */
  private pinSection(
    colored: boolean,
    note: string | null,
    ring: LegendRing | null,
    ramp: ForestRamp,
  ): HTMLElement {
    const section = el("section", "map-key__section");
    section.append(
      el("h3", "map-key__title", colored || note ? "Forhold i skovene i dag" : "Omkring nålen"),
    );

    if (colored) {
      const swatches = rampSwatches(ramp, "map-key__ramp");
      swatches.setAttribute("role", "img");
      swatches.setAttribute(
        "aria-label",
        `Skovene er farvet i fire trin efter forholdstal, fra lave til gode forhold: ${ramp.classes.map((c) => c.label).join(", ")}`,
      );
      const labels = el("div", "map-key__ramp-labels");
      labels.setAttribute("aria-hidden", "true");
      for (const cls of ramp.classes) labels.append(el("span", undefined, cls.label));
      const direction = el("div", "map-key__ramp-direction");
      direction.setAttribute("aria-hidden", "true");
      direction.append(
        el("span", undefined, "lave forhold"),
        el("span", undefined, "gode forhold"),
      );
      section.append(swatches, labels, direction);
    }

    if (!colored && note) section.append(el("p", "map-key__note", note));

    if (ring) {
      const notes = el("ul", "map-key__list map-key__notes");
      const row = el("li", "map-key__row");
      // whole kilometres, as the conditions card in the panel words it
      const km = Math.max(1, Math.round(ring.radiusKm));
      row.append(
        el("span", "map-key__ring"),
        el("span", undefined, `Fund inden for ${km} km tæller med ved nålen`),
      );
      notes.append(row);
      section.append(notes);
    }
    if (colored) {
      section.append(el("p", "map-key__hint", "Sæt nålen i en farvet skov for at se dens tal."));
    }
    return section;
  }
}

const legends = new WeakMap<maplibregl.Map, MapLegend>();

/** The map's key, created on first use. */
export function legendFor(map: maplibregl.Map): MapLegend {
  let legend = legends.get(map);
  if (!legend) {
    legend = new MapLegend(map);
    legends.set(map, legend);
  }
  return legend;
}
