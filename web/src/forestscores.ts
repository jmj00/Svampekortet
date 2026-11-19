// Forests coloured by today's conditions for the open species: the named
// forests around the pin, each filled in the class colour of its score for
// that species (the score the Skove tab would give the forest with the list
// narrowed to that species: forests.ts's scoreForest). It replaces the
// conditions grid (docs/adr/0021): the unit is a place one can go to, and
// nothing is painted over towns, fields or water.
//
// Shown while a species is open and a pin is set; worked out after the detail
// has painted, a few forests at a time, and drawn in one go. Every tap inside
// a drawn forest says which forest it is, its score and what the score means:
// in a small card at the pin, or, when the tap also hit finds, as the last
// lines of the find card (observations.ts), so the two never compete.
//
// A forest that scored 0 is not drawn, and on a day when no forest in reach
// gets to the second class (30) none is: thin grey edges alone read as a
// parcel map. The key then says so in a sentence.

import type maplibregl from "maplibre-gl";
import { fitCamera } from "./camera";
import {
  bboxDistanceKm,
  pointInShape,
  shapeAreaM2,
  shapeToGeoJSON,
  type ForestOutlines,
  type ForestShape,
} from "./forestoutlines";
import { setForestOutlineFilled } from "./forestshape";
import { scoreForest } from "./forests";
import type { MapBundle } from "./map";
import { legendFor } from "./maplegend";
import type { ModelBundle } from "./model";
import { findCardIsOpen, placeCard, PIN_CARD_OFFSETS, setFindCardExtra } from "./observations";
import { forestRamp, mapColors } from "./palette";
import { ringBounds } from "./pinring";
import { scoreWord } from "./specieslist";
import type { ForestPoint, Manifest } from "./types";

const SOURCE_ID = "forest-scores";
const FILL_ID = "forest-scores-fill";
const LINE_ID = "forest-scores-line";
const BASEMAP_ID = "basemap"; // map.ts
const OUTLINE_PREFIX = "forest-outline"; // forestshape.ts: the pin's own forest, drawn above

/** Forests whose outline comes within this of the pin are scored (km): a
 * short drive, and about what the map shows when a species is opened. */
export const SCORE_RADIUS_KM = 10;
/** ...the nearest of them, at most this many. */
export const MAX_SCORED_FORESTS = 120;

export interface ScoredForest {
  index: number;
  name: string;
  /** 0-100 for the open species at the forest, or null when it has none. */
  score: number | null;
  shape: ForestShape;
  areaM2: number;
}

/** Pure: which class of the ramp a score falls in (0 = the lowest). */
export function scoreClass(score: number, froms: readonly number[]): number {
  let cls = 0;
  froms.forEach((from, i) => {
    if (score >= from) cls = i;
  });
  return cls;
}

/** Pure: the forests to score for a pin: those whose outline (its box, a
 * cheap and never-too-strict stand-in) comes within `radiusKm`, nearest
 * first, at most `limit`. Only forests whose outline is loaded can be drawn,
 * so only those are candidates. */
export function forestsToScore(
  points: readonly ForestPoint[],
  outlines: ForestOutlines,
  [lon, lat]: [number, number],
  radiusKm = SCORE_RADIUS_KM,
  limit = MAX_SCORED_FORESTS,
): { index: number; shape: ForestShape; distanceKm: number }[] {
  const near: { index: number; shape: ForestShape; distanceKm: number }[] = [];
  for (const [index, shape] of outlines.entries()) {
    if (!points[index]) continue;
    const distanceKm = bboxDistanceKm(lon, lat, shape);
    if (distanceKm <= radiusKm) near.push({ index, shape, distanceKm });
  }
  near.sort((a, b) => a.distanceKm - b.distanceKm || a.index - b.index);
  return near.slice(0, limit);
}

/** Pure: the forests worth drawing. A forest with no score or a score of 0
 * says nothing; and unless at least one forest reaches the second class
 * (`froms[1]`, 30) none is drawn, since outlines alone are not a picture of
 * where it is good. */
export function forestsToDraw(
  forests: readonly ScoredForest[],
  froms: readonly number[],
): ScoredForest[] {
  const scored = forests.filter((forest) => forest.score !== null && forest.score > 0);
  const promising = scored.some((forest) => (forest.score as number) >= (froms[1] ?? 0));
  return promising ? scored : [];
}

/** Pure: the map features, largest forest first, so that a named part drawn
 * later lies on top of the forest it is in. Forests without a score are left
 * out. */
export function scoreFeatures(
  forests: readonly ScoredForest[],
  froms: readonly number[],
): GeoJSON.FeatureCollection {
  const drawn = forests
    .filter((forest) => forest.score !== null)
    .sort((a, b) => b.areaM2 - a.areaM2 || a.index - b.index);
  return {
    type: "FeatureCollection",
    features: drawn.map((forest) => ({
      type: "Feature",
      properties: {
        index: forest.index,
        name: forest.name,
        score: forest.score,
        cls: scoreClass(forest.score as number, froms),
      },
      geometry: shapeToGeoJSON(forest.shape),
    })),
  };
}

/** Pure: the scored forest a tap belongs to: the smallest one containing it. */
export function forestAt(
  forests: readonly ScoredForest[],
  lon: number,
  lat: number,
): ScoredForest | null {
  let best: ScoredForest | null = null;
  for (const forest of forests) {
    if (forest.score === null || !pointInShape(lon, lat, forest.shape)) continue;
    if (!best || forest.areaM2 < best.areaM2) best = forest;
  }
  return best;
}

export interface ForestScoresDeps {
  mapReady: Promise<MapBundle>;
  getPin(): [number, number] | null;
  getPoints(): readonly ForestPoint[];
  getOutlines(): ForestOutlines | null;
  /** The species whose page is open, with what is needed to score for it; or
   * null with no species open, no pin, or no conditions model for it. */
  getSpecies(): {
    slug: string;
    name: string;
    manifest: Manifest;
    modelBundle: ModelBundle;
    /** The model's bandwidth: the ring around the pin. */
    radiusKm: number | null;
  } | null;
  /** Taps on the map mean something else just now (the start screen). */
  ignoreClicks?(): boolean;
}

/** What the key says when nothing is drawn: a sentence for the open key and
 * a few words for its closed line. `inReach`: how many forests were scored;
 * with none (at sea) there is nothing to say about conditions. */
export function noForestsNote(
  speciesName: string,
  inReach: number,
): { long: string; short: string } {
  if (inReach === 0) {
    return {
      long: `Ingen skove inden for ${SCORE_RADIUS_KM} km.`,
      short: `ingen skove inden for ${SCORE_RADIUS_KM} km`,
    };
  }
  return {
    long: `Ingen skove inden for ${SCORE_RADIUS_KM} km har middel eller gode forhold for ${speciesName} i dag.`,
    short: "ingen skove med middel/gode forhold",
  };
}

export interface ForestScores {
  /** Look again: the species opened or closed, the pin moved, or more
   * outlines arrived. */
  refresh(): void;
}

type Expr = maplibregl.ExpressionSpecification;

function byClass(values: readonly (string | number)[]): Expr {
  const expr: unknown[] = ["match", ["get", "cls"]];
  values.slice(1).forEach((value, i) => expr.push(i + 1, value));
  expr.push(values[0]);
  return expr as Expr;
}

function paint(map: maplibregl.Map): void {
  if (!map.getLayer(FILL_ID)) return;
  const ramp = forestRamp();
  const colors = mapColors();
  // the lowest class has no tint: an outline says the forest was looked at
  const fallback = ramp.classes.find((cls) => cls.color)?.color ?? colors.ink;
  map.setPaintProperty(
    FILL_ID,
    "fill-color",
    byClass(ramp.classes.map((c) => c.color ?? fallback)),
  );
  map.setPaintProperty(FILL_ID, "fill-opacity", byClass(ramp.classes.map((c) => c.opacity)));
  map.setPaintProperty(LINE_ID, "line-color", byClass(ramp.classes.map((c) => c.line)));
  map.setPaintProperty(
    LINE_ID,
    "line-opacity",
    byClass(ramp.classes.map((c) => (c.color ? 0.9 : 0.8))),
  );
}

/** Re-resolve the theme-dependent colours (the colour scheme flipped). */
export function restyleForestScores(map: maplibregl.Map): void {
  paint(map);
}

function draw(map: maplibregl.Map, data: GeoJSON.FeatureCollection): void {
  const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
  } else {
    map.addSource(SOURCE_ID, { type: "geojson", data });
    // Directly above the basemap, and under the pin's own forest outline if
    // that is already there: under the ring, the finds and every marker.
    const layers = map.getStyle().layers ?? [];
    const outline = layers.find((layer) => layer.id.startsWith(OUTLINE_PREFIX))?.id;
    const basemapAt = layers.findIndex((layer) => layer.id === BASEMAP_ID);
    const before = outline ?? (basemapAt >= 0 ? layers[basemapAt + 1]?.id : layers[0]?.id);
    map.addLayer({ id: FILL_ID, type: "fill", source: SOURCE_ID, paint: {} }, before);
    map.addLayer(
      {
        id: LINE_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-join": "round" },
        paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 13, 1.4] },
      },
      before,
    );
  }
  paint(map);
}

function clearLayers(map: maplibregl.Map): void {
  for (const id of [LINE_ID, FILL_ID]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

let cardSerial = 0;

export function createForestScores(deps: ForestScoresDeps): ForestScores {
  let token = 0;
  let shown: ScoredForest[] = [];
  let shownFor: { slug: string; name: string } | null = null;
  let card: { popup: maplibregl.Popup; lngLat: [number, number] } | null = null;
  /** Scores worked out today, by species and forest: a pin moved a little
   * needs most of the same forests again. */
  const cache = new Map<string, number | null>();
  const day = (): string => new Date().toDateString();

  function closeCard(): void {
    card?.popup.remove();
    card = null;
  }

  function clear(map: maplibregl.Map): void {
    shown = [];
    shownFor = null;
    closeCard();
    clearLayers(map);
    setForestOutlineFilled(map, true);
    legendFor(map).update({ forests: null, forestsNote: null });
  }

  /** "43 · middel forhold" with the class's swatch, and whose number it is. */
  function scoreLines(forest: ScoredForest): HTMLElement[] {
    const score = forest.score as number;
    const ramp = forestRamp();
    const cls =
      ramp.classes[
        scoreClass(
          score,
          ramp.classes.map((c) => c.from),
        )
      ];
    const line = el("p", "forest-card__score");
    const swatch = el("span", "forest-card__swatch");
    if (cls.color) swatch.style.backgroundColor = cls.color;
    swatch.style.setProperty("--edge", cls.line);
    line.append(
      swatch,
      el("strong", undefined, String(score)),
      el("span", undefined, `· ${scoreWord(score).toLowerCase()} forhold`),
    );
    return [
      line,
      el(
        "p",
        "find-card__line find-card__line--muted",
        `Skovens tal for ${shownFor?.name ?? "arten"} i dag. Tallet lige ved nålen kan være et andet.`,
      ),
    ];
  }

  /** The forest at a tap that also hit finds: its lines for the find card. */
  function findCardLines(lngLat: [number, number]): HTMLElement | null {
    if (deps.ignoreClicks?.()) return null;
    const forest = forestAt(shown, lngLat[0], lngLat[1]);
    if (!forest) return null;
    const block = el("div", "forest-card forest-card--in-find");
    block.append(el("p", "forest-card__name", forest.name), ...scoreLines(forest));
    return block;
  }

  function openCard(bundle: MapBundle, forest: ScoredForest, lngLat: [number, number]): void {
    const { map, maplibregl } = bundle;
    const root = el("div", "find-card__content forest-card");
    root.setAttribute("role", "dialog");
    const head = el("div", "find-card__head");
    const title = el("h3", "find-card__title", forest.name);
    title.id = `forest-card-title-${++cardSerial}`;
    root.setAttribute("aria-labelledby", title.id);
    const close = el("button", "find-card__close");
    close.type = "button";
    close.setAttribute("aria-label", "Luk skovens forholdstal");
    close.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
      '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    close.addEventListener("click", closeCard);
    head.append(title, close);
    root.append(head, ...scoreLines(forest));

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      focusAfterOpen: false, // the tap was on the map; don't pull focus off it
      className: "find-card",
      maxWidth: "264px",
      anchor: "bottom",
      offset: PIN_CARD_OFFSETS,
    });
    popup.setDOMContent(root).setLngLat(lngLat).addTo(map);
    popup.getElement()?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeCard();
        map.getCanvas().focus();
      }
    });
    card = { popup, lngLat };
    placeCard(map, card, true);
  }

  async function run(bundle: MapBundle, mine: number): Promise<void> {
    const map = await bundle.loaded;
    if (mine !== token) return;
    const species = deps.getSpecies();
    const pin = deps.getPin();
    const outlines = deps.getOutlines();
    const points = deps.getPoints();
    if (!species || !pin || !outlines || points.length === 0) {
      clear(map);
      return;
    }
    // the outlines for everything within reach of the pin (a band that is
    // not here yet brings us back through refresh() when it arrives)
    const [w, s] = ringBounds(pin, SCORE_RADIUS_KM)[0];
    const [e, n] = ringBounds(pin, SCORE_RADIUS_KM)[1];
    outlines.requestArea(w, s, e, n);
    const started = performance.now();
    const candidates = forestsToScore(points, outlines, pin);
    const slugs = new Set([species.slug]);
    const date = new Date();
    const scored: ScoredForest[] = [];
    let sliceStarted = performance.now();
    for (const { index, shape } of candidates) {
      const point = points[index];
      const key = `${day()}|${species.slug}|${index}`;
      let score = cache.get(key);
      if (score === undefined) {
        try {
          score = (await scoreForest(point, species.manifest, species.modelBundle, slugs, date))
            .score;
        } catch (err) {
          console.error("could not score a forest", err);
          score = null;
        }
        if (mine !== token) return; // the pin or the species has moved on
        cache.set(key, score);
        // give the page a turn every few milliseconds of scoring
        if (performance.now() - sliceStarted > 8) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (mine !== token) return;
          sliceStarted = performance.now();
        }
      }
      scored.push({
        index,
        name: point.name,
        score,
        shape,
        areaM2: point.area_m2 ?? shapeAreaM2(shape),
      });
    }
    const ramp = forestRamp();
    const froms = ramp.classes.map((c) => c.from);
    // only what is drawn can be tapped: a tap in a forest left out is a tap
    // on bare map
    shown = forestsToDraw(scored, froms);
    shownFor = { slug: species.slug, name: species.name };
    draw(map, scoreFeatures(shown, froms));
    // the pin's own forest keeps its outline; where it is drawn its fill is
    // the score's, and its own soft fill would tint it twice
    setForestOutlineFilled(map, shown.length === 0);
    const reach = Math.max(species.radiusKm ?? 0, 3);
    // Nothing drawn: say so, but only when the outlines around the pin were
    // there to be scored (not while they load, and not when they failed).
    const looked = outlines.cover(pin[0], pin[1]) === "ready";
    legendFor(map).update({
      forests:
        shown.length > 0
          ? { zoomTo: () => fitCamera(map, ringBounds(pin, reach), { margin: 24 }) }
          : null,
      forestsNote: shown.length === 0 && looked ? noForestsNote(species.name, scored.length) : null,
    });
    if (import.meta.env.DEV) {
      (window as unknown as { __forestScores?: object }).__forestScores = {
        species: species.slug,
        forests: scored.length,
        drawn: shown.length,
        ms: Math.round(performance.now() - started),
      };
    }
  }

  void deps.mapReady.then((bundle) => {
    const { map } = bundle;
    // A tap that hit finds opens the find card; the forest is named there.
    setFindCardExtra(map, findCardLines);
    // After the app's own click handler has moved the pin and after the find
    // card's: with no finds at the tap the forest gets a card of its own.
    map.on("click", (e) => {
      closeCard();
      if (shown.length === 0 || findCardIsOpen(map) || deps.ignoreClicks?.()) return;
      const forest = forestAt(shown, e.lngLat.lng, e.lngLat.lat);
      if (forest) openCard(bundle, forest, [e.lngLat.lng, e.lngLat.lat]);
    });
    map.on("moveend", () => {
      if (card) placeCard(map, card, false);
    });
  });

  return {
    refresh(): void {
      const mine = ++token;
      const pin = deps.getPin();
      // the card describes the spot the pin was tapped onto
      if (card && (!pin || pin[0] !== card.lngLat[0] || pin[1] !== card.lngLat[1])) closeCard();
      void deps.mapReady.then((bundle) => {
        if (!deps.getSpecies() || !pin) {
          void bundle.loaded.then((map) => {
            if (mine === token) clear(map);
          });
          return;
        }
        // after the species page has painted, not in its way
        window.setTimeout(() => {
          if (mine === token) void run(bundle, mine);
        }, 60);
      });
    },
  };
}
