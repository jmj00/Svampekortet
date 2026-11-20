// Colours for everything drawn on the map.
//
// Shared between observations.ts (the map dots) and panel.ts (the legend that
// explains them) -- species within one taxonomic group used to share a single
// colour on the map, so a multi-species search/chip filter (e.g. "kantarel")
// needs its own per-species palette to actually distinguish them. Cycles if
// there are more matched species than colours.
const SPECIES_PALETTE = [
  "#d98a2b", // amber
  "#4a7fb5", // blue
  "#5f9e56", // green
  "#b5476a", // rose
  "#7a5cc4", // purple
  "#c4622b", // burnt orange
  "#2b9e9e", // teal
  "#a67c00", // gold
  "#8a5a2b", // brown
  "#4a4a52", // slate
];

/** The colour a multi-species view gives the species at this position in its
 * doc list -- both the map dots and the legend that explains them read off
 * the same list order, so this is the one place that assignment is made. */
export function speciesColor(index: number): string {
  return SPECIES_PALETTE[index % SPECIES_PALETTE.length];
}

/** True when the page is rendering its dark theme (style.css switches on the
 * same media query, so the map follows the panels). */
export function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false)
  );
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}

let probe: CanvasRenderingContext2D | null | undefined;

/**
 * The current value of a CSS colour token as `#rrggbb`, for MapLibre paint
 * expressions (which can't read CSS variables). Reading the token at runtime
 * rather than copying its hex keeps the map in step with style.css in both
 * themes; the value is painted to a 1px canvas so any CSS colour syntax
 * (`color-mix()`, `oklch()`...) comes back as plain sRGB. `fallback` is used
 * when there is no DOM (unit tests) or the token is missing.
 */
export function cssColor(token: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    if (!value) return fallback;
    if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
    if (probe === undefined) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      probe = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!probe) return fallback;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000";
    probe.fillStyle = value; // an unparsable value leaves the previous fillStyle
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    return "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
  } catch {
    return fallback;
  }
}

/** `#rrggbb` + alpha -> `rgba()`, for ramps that fade a colour in. */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * A multi-species view colours each species only while the colours can still
 * be told apart: up to this many species *that have finds*. Each keeps
 * `speciesColor(i)` for its position `i` in the matched list (zero-find
 * species keep their index but are never drawn or listed), so the palette
 * never cycles on the map. Above it, every find is drawn in the one find
 * colour with a density layer ("Fund af 50 arter") and the pin's card names
 * the species.
 */
export const MAX_COLOURED_SPECIES = 8;

/** One class of the forest scores. `color: null` is "outline only". */
export interface ScoreClass {
  /** Lowest score in the class. */
  from: number;
  label: string;
  color: string | null;
  opacity: number;
  /** The forest's edge in this class. */
  line: string;
}

/**
 * The scale the forests are coloured by (forestscores.ts): one hue (teal),
 * lightness-monotonic, so a class reads the same under colour-vision
 * deficiency; in light mode darker is better, in dark mode brighter is
 * better. The lowest class has no tint, only a thin grey edge: "looked at,
 * nothing much today". The breaks at 30 and 60 are the score pills' bands
 * (score.ts scoreBand); 80 splits the top band. The colours are the ones the
 * conditions grid used (ADR-0021), painted straight over the basemap's forest
 * green without the grid's wash.
 */
export interface ForestRamp {
  classes: ScoreClass[];
  /** The basemap's forest colour, backing the legend swatches. */
  backing: string;
}

const FOREST_LIGHT: ForestRamp = {
  classes: [
    { from: 0, label: "0–29", color: null, opacity: 0, line: "#5f665c" },
    { from: 30, label: "30–59", color: "#6cbba2", opacity: 0.72, line: "#2f8a71" },
    { from: 60, label: "60–79", color: "#27866d", opacity: 0.8, line: "#14594a" },
    { from: 80, label: "80+", color: "#083f35", opacity: 0.8, line: "#04241e" },
  ],
  backing: "#add19e", // basemapstyle.ts LIGHT.wood
};

const FOREST_DARK: ForestRamp = {
  classes: [
    { from: 0, label: "0–29", color: null, opacity: 0, line: "#a3a99c" },
    { from: 30, label: "30–59", color: "#2e6c5c", opacity: 0.78, line: "#4f9a86" },
    { from: 60, label: "60–79", color: "#4fb096", opacity: 0.82, line: "#8fdcc6" },
    { from: 80, label: "80+", color: "#b9f7e3", opacity: 0.88, line: "#eafff8" },
  ],
  backing: "#22372a", // basemapstyle.ts DARK.wood
};

export function forestRamp(): ForestRamp {
  return prefersDark() ? FOREST_DARK : FOREST_LIGHT;
}

export interface MapColors {
  dark: boolean;
  /** One species' finds. Raspberry: the one hue family the basemap (yellow
   * land, blue water, green forest, red roads), the pin (amber) and the
   * forest scores (teal) all leave free. */
  find: string;
  /** Deep end of the find-density ramp. */
  findDeep: string;
  /** Thin outline that lifts a dot off the basemap. */
  halo: string;
  /** Text colour on the map (the ring around the pin). */
  ink: string;
  /** Fill behind the basemap raster (shows while tiles load). */
  backdrop: string;
}

// Keep in step with --find / --find-deep in style.css (map tokens).
const FIND_LIGHT = "#b3306b";
const FIND_LIGHT_DEEP = "#7d1747";
const FIND_DARK = "#f0679f";
const FIND_DARK_DEEP = "#ff9cc4";

export function mapColors(): MapColors {
  const dark = prefersDark();
  return {
    dark,
    find: dark ? FIND_DARK : FIND_LIGHT,
    findDeep: dark ? FIND_DARK_DEEP : FIND_LIGHT_DEEP,
    halo: dark ? "#14160f" : "#ffffff",
    ink: cssColor("--ink", dark ? "#eceade" : "#232620"),
    backdrop: cssColor("--bg", dark ? "#191b16" : "#f4f3ee"),
  };
}
