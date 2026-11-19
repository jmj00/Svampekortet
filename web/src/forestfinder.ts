// "Forests near me": the contents of #forest-finder. A ranked list of named
// forests around the pin, paired with numbered markers on the map
// (forestmarkers.ts) so each row has a visible place. Ranked by the best
// conditions score any species reaches there today when a model is available,
// by plain distance otherwise.
//
// The outer container (#forest-finder: a floating card on desktop, a bottom
// sheet on phones) belongs to the app shell; this module only fills it, and
// drives its states through `data-state` on it:
//   idle | needs-pin | loading | results | empty | error

import { beyond, fitCamera, mapInsets } from "./camera";
import { h, icon } from "./dom";
import { ZERO_SCORE_TITLE, createForestHere, type HereStatus } from "./foresthere";
import {
  clearForestMarkers,
  clearForestOrigin,
  frameForests,
  isInView,
  layoutForestMarkers,
  setForestMarkerState,
  showForestMarkers,
  showForestOrigin,
  type Padding,
} from "./forestmarkers";
import {
  MAX_CANDIDATES_TO_SCORE,
  MAX_RESULTS,
  compassDa,
  countWithin,
  nearestForests,
  rankForestsByScore,
  sameForest,
  type NearbyForest,
  type RankedForest,
} from "./forests";
import type { ForestOutlines, ForestShape } from "./forestoutlines";
import { clearForestOutline, showForestOutline } from "./forestshape";
import type { MapBundle } from "./map";
import type { ModelBundle } from "./model";
import { haversineKm, scoreBand } from "./score";
import { describeScore, scoreExplainer } from "./scoreinfo";
import type { ForestPoint, Manifest } from "./types";

export interface ForestFinderDeps {
  mapReady: Promise<MapBundle>;
  /** The current pin, or null before one is set. */
  getPin(): [number, number] | null;
  /** The forest points payload (may still be loading when first asked). */
  loadPoints(): Promise<readonly ForestPoint[]>;
  /** The forest outlines fetched so far, or null when none are published. */
  getOutlines(): ForestOutlines | null;
  /** What to rank with, or null when there is no conditions model: `slugs` is
   * the species the list is currently showing, `filtered` whether that is a
   * narrowed-down search rather than every scored species. */
  getRanking(): {
    manifest: Manifest;
    modelBundle: ModelBundle;
    slugs: Set<string>;
    filtered: boolean;
  } | null;
  /** Move the pin to a chosen forest. With `camera`, also fly there: to
   * that zoom, with the forest `offset` px from the map's centre (so it lands
   * in the part of the map that is not covered). */
  goToForest(
    forest: { name: string; lon: number; lat: number },
    camera: { zoom: number; offset: [number, number] } | null,
  ): void;
  /** "offline" when the conditions model failed to load, "none" when the
   * data set has no model, null while it may still arrive. */
  rankingFailed?(): "offline" | "none" | null;
  /** Start the browser's geolocation (the map's "find me" control). */
  locate(): void;
  /** Open the long explanation of the score. */
  openScoreHelp(): void;
}

export interface ForestFinder {
  /** The user moved the pin (map click, address, geolocation): keep an open
   * result list current. Not for a pin move caused by choosing a forest. */
  pinMoved(): void;
  /** A band of forest outlines has arrived (or failed): the forest at the pin
   * may now be known, or known better. */
  outlinesChanged(): void;
  /** Run the search from the current pin, as the "Find skove" button does
   * (without a pin it asks for one). `focus` hands keyboard focus to the
   * outcome: the first forest, or whatever is shown instead. */
  search(options?: { focus?: boolean }): void;
}

type Item = NearbyForest | RankedForest;
type State = "idle" | "needs-pin" | "loading" | "results" | "empty" | "error";

/** Eight markers need about this much room across to be told apart (px). */
const MIN_RESULTS_PX = 120;

/** From here in, a forest and its surroundings can be read off the map. */
const READABLE_ZOOM = 11.5;

/** The idle lead once the pin's own forest is shown above it. */
const LEAD_OTHERS = "Eller se, hvilke andre skove i nærheden der har de bedste forhold i dag.";

/** Long enough for the loading rows to register instead of flickering past. */
const MIN_LOADING_MS = 350;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const km = new Intl.NumberFormat("da-DK", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function scoreOf(item: Item): number | null {
  return "score" in item ? item.score : null;
}

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function initForestFinder(deps: ForestFinderDeps): ForestFinder {
  const root = document.getElementById("forest-finder") as HTMLElement;
  const cta = document.getElementById("find-forests") as HTMLButtonElement;
  const ctaLabel = cta.querySelector<HTMLElement>(".ff__cta-label") as HTMLElement;
  const radius = document.getElementById("forest-radius") as HTMLFieldSetElement;
  const closeButton = root.querySelector<HTMLButtonElement>(".ff__close") as HTMLButtonElement;
  const status = root.querySelector<HTMLElement>(".ff__status") as HTMLElement;
  const list = document.getElementById("forest-results") as HTMLUListElement;
  const lead = root.querySelector<HTMLElement>(".ff__lead") as HTMLElement;
  const leadDefault = (lead.textContent ?? "").replace(/\s+/g, " ").trim();
  const app = document.getElementById("app");

  let token = 0;
  /** Once asked for, the list follows the pin instead of going stale. */
  let armed = false;
  let items: Item[] = [];
  /** Where the shown results were searched from. */
  let origin: [number, number] | null = null;
  let searchedRadius = 0;
  /** How many forests the shown list was picked from (the nearest ones). */
  let comparedCount = 0;
  let selected: number | null = null;
  /** The species the shown results were ranked for, or null if by distance. */
  let rankedWith: Set<string> | null = null;
  let explainerOpen = false;
  /** The search button was used from the keyboard (it had focus) and then
   * stepped aside: carry focus on to whatever the search produces. */
  let carryFocus = false;

  /** Hand the carried focus to the outcome of the search, once. */
  function landFocus(target: HTMLElement | null | undefined): void {
    if (!carryFocus) return;
    carryFocus = false;
    target?.focus({ preventScroll: true });
  }

  const radiusKm = (): number =>
    Number(radius.querySelector<HTMLInputElement>("input:checked")?.value ?? 20);

  function setState(state: State): void {
    root.dataset.state = state;
    closeButton.hidden = state === "idle";
  }

  /** The pin no longer stands where the list was searched from. */
  function isStale(): boolean {
    const pin = deps.getPin();
    if (!pin || !origin) return false;
    return haversineKm(origin[1], origin[0], pin[1], pin[0]) > 0.15;
  }

  function updateCta(): void {
    const stale = root.dataset.state === "results" && isStale();
    // With the pin's own forest shown on top, the search is for the others.
    const others = here.status().kind === "forest";
    cta.dataset.mode = stale ? "again" : "find";
    cta.title = stale ? "Søg igen med nålen som udgangspunkt" : "";
    ctaLabel.textContent = stale
      ? "Søg herfra"
      : others
        ? "Find andre skove i nærheden"
        : "Find skove i nærheden";
    lead.textContent = others ? LEAD_OTHERS : leadDefault;
    root.dataset.stale = String(stale);
  }

  // --- the pin's own forest ("Ved din nål", foresthere.ts) ---------------

  /** The forest tab is the one on screen (it shares its place with the
   * species list, on the phone and in the sidebar alike). */
  const tabShowing = (): boolean => app?.dataset.mobileTab !== "svampe";

  function showSpecies(): void {
    const tab = document.querySelector<HTMLButtonElement>('#mobile-tabs [data-tab="svampe"]');
    if (!tab) return;
    if (app?.dataset.mobileTab !== "svampe") tab.click();
    tab.focus(); // the button just pressed is about to be hidden with its tab
  }

  /** Draw the outline of the forest the pin stands in (which is also the
   * forest just chosen from the list: the pin moves there), or take it away
   * when there is none -- the pin cleared, or not in a forest. */
  let outlineDrawn = 0;
  /** The forest whose outline is on the map (its index), or null. */
  let outlined: number | null = null;
  /** The forest last picked from the result list (its index), or null once
   * the pin has been moved some other way. */
  let listChoice: number | null = null;
  function drawOutline(): void {
    const mine = ++outlineDrawn;
    void deps.mapReady.then((bundle) =>
      bundle.loaded.then((map) => {
        if (mine !== outlineDrawn) return; // a newer call decides
        const status = here.status();
        const forest = status.kind === "forest" ? status.forest : null;
        const shape = forest ? (deps.getOutlines()?.shape(forest.index) ?? null) : null;
        if (!forest || !shape) {
          clearForestOutline(map);
          outlined = null;
          return;
        }
        showForestOutline(map, shape);
        const isNew = outlined !== forest.index;
        outlined = forest.index ?? null;
        // A forest chosen by name that does not fit the view where the camera
        // went: step back to show the whole of it. Inside a large forest the
        // soft fill alone says little; its boundary says where the pin is.
        // (Not for a forest picked from the result list: there the camera
        // stays with the results, so the other forests remain in view.)
        if (isNew && forest.chosen && forest.index !== listChoice) {
          revealOutline(bundle, shape, mine);
        }
      }),
    );
  }

  /** Bring the whole outline into view unless it already is, once any camera
   * move under way has landed. */
  function revealOutline(bundle: MapBundle, shape: ForestShape, drawn: number): void {
    const { map } = bundle;
    const run = (): void => {
      if (drawn !== outlineDrawn) return; // the pin has moved on since
      const padding = cameraPadding(bundle);
      const [w, s0, e, n] = shape.bbox;
      // the whole of it already in view: nothing to do
      if (isInView(bundle, [w, n], padding) && isInView(bundle, [e, s0], padding)) return;
      const [west, south, east, north] = shape.bbox;
      fitCamera(
        map,
        [
          [west, south],
          [east, north],
        ],
        // step back to show it, never closer: the zoom the flight chose stands
        { maxZoom: Math.min(14, map.getZoom()), margin: 24, padding },
      );
    };
    if (map.isMoving()) map.once("moveend", () => window.setTimeout(run, 0));
    else run();
  }

  /** Mark the result row, if any, that is the forest the pin stands at, and
   * give it the card's number: the card scores the pin itself, a row its
   * forest's point, and the same forest must not show two numbers. */
  function markHereRow(status: HereStatus): void {
    const forest = status.kind === "forest" ? status.forest : null;
    const atPin = here.score();
    list.querySelectorAll<HTMLElement>(".forest-item").forEach((li, i) => {
      const item = items[i];
      const isHere = Boolean(forest && item && sameForest(item, forest));
      li.classList.toggle("is-here", isHere);
      if (!item) return;
      const own = "score" in item ? { score: item.score, scoreSpecies: item.scoreSpecies } : null;
      paintRowScore(li, item, isHere && atPin && atPin.score !== null ? atPin : own);
    });
  }

  /** Where a row's forest lies from the searched spot, in words. */
  function whereText(item: Item): string {
    const direction = origin ? compassDa(origin[0], origin[1], item.lon, item.lat) : "";
    return item.distanceKm < 0.1
      ? "ved nålen"
      : `${km.format(item.distanceKm)} km${direction ? ` mod ${direction}` : ""}`;
  }

  /** Fill in a row's score pill and the species it is best for. */
  function paintRowScore(
    li: HTMLElement,
    item: Item,
    score: { score: number | null; scoreSpecies: string | null } | null,
  ): void {
    const meta = li.querySelector<HTMLElement>(".forest-row__meta");
    const pill = li.querySelector<HTMLElement>(".forest-row__score");
    const where = whereText(item);
    // a top score of 0 has no "best" species worth naming
    const best = score?.score ? score.scoreSpecies : null;
    if (meta) meta.textContent = best ? `${where} · bedst for ${best}` : where;
    if (!pill) return;
    const value = score?.score ?? null;
    pill.hidden = value === null;
    if (value === null) return;
    pill.textContent = String(value);
    pill.dataset.band = scoreBand(value);
    pill.title = value === 0 ? ZERO_SCORE_TITLE : `Forholdstal ${describeScore(value)}`;
    pill.setAttribute("aria-label", `forholdstal ${describeScore(value)}`);
  }

  const here = createForestHere({
    getPin: deps.getPin,
    loadPoints: deps.loadPoints,
    getOutlines: deps.getOutlines,
    getRanking: deps.getRanking,
    rankingFailed: deps.rankingFailed,
    isShowing: tabShowing,
    moveTo: (forest) => {
      listChoice = null;
      void deps.mapReady.then((bundle) => {
        goTo(bundle, forest);
        here.refresh();
        // the shortcut button is gone with the old card: on to the new one's action
        here.focusAction();
        layoutForestMarkers();
        updateCta();
      });
    },
    showSpecies,
    onChange: (status) => {
      root.dataset.here = status.kind;
      markHereRow(status);
      updateCta();
      drawOutline();
    },
    onScore: () => markHereRow(here.status()),
  });
  root.querySelector(".ff__head")?.after(here.element);
  root.dataset.here = "unknown";

  // --- states ---------------------------------------------------------

  function showNeedsPin(): void {
    clearForestMarkers();
    list.replaceChildren();
    const hint = h("div", "ff-hint");
    const text = h("div", "ff-hint__text");
    text.append(
      h("strong", undefined, "Sæt først en nål"),
      h(
        "span",
        undefined,
        "Tryk på kortet eller søg en adresse – så finder vi skovene omkring stedet med det samme.",
      ),
    );
    const locate = h("button", "ff-hint__action");
    locate.type = "button";
    locate.append(icon("locate"), h("span", undefined, "Brug min placering"));
    locate.addEventListener("click", () => deps.locate());
    hint.append(icon("pin", "sk-icon ff-hint__icon"), text, locate);
    status.replaceChildren(hint);
    setState("needs-pin");
    updateCta();
    landFocus(locate);
  }

  /** The forest data could not be fetched: say so, and offer to try again. */
  function showError(): void {
    clearForestMarkers();
    items = [];
    list.removeAttribute("aria-busy");
    list.replaceChildren();
    const box = h("div", "ff-error");
    box.setAttribute("role", "alert");
    const text = h("div", "ff-hint__text");
    text.append(
      h("strong", undefined, "Kunne ikke hente skovene"),
      h("span", undefined, "Tjek forbindelsen, og prøv igen."),
    );
    const retry = h("button", "ff-hint__action", "Prøv igen");
    retry.type = "button";
    retry.addEventListener("click", () => {
      carryFocus = true;
      search();
    });
    box.append(icon("warning", "sk-icon ff-hint__icon"), text, retry);
    status.replaceChildren(box);
    setState("error");
    updateCta();
    landFocus(retry);
  }

  function showLoading(): void {
    status.replaceChildren(
      h("p", "ff-summary ff-summary--busy", "Beregner dagens forhold i skovene omkring nålen …"),
    );
    list.replaceChildren();
    list.setAttribute("aria-busy", "true");
    for (let i = 0; i < 4; i++) {
      const row = h("li", "forest-skeleton");
      row.setAttribute("aria-hidden", "true");
      row.append(h("span", "forest-skeleton__dot"), h("span", "forest-skeleton__lines"));
      list.append(row);
    }
    setState("loading");
    updateCta();
    root.scrollTop = 0; // the radius and close row sits below the stuck card, in view
    // The button that had focus has just stepped aside: hold focus on the
    // list until the outcome is known, so it never falls back to the page.
    if (carryFocus) list.focus({ preventScroll: true });
  }

  /** Says what the list is. Only the nearest forests are compared, so a
   * wider radius often gives the same list: name that, do not imply the
   * whole radius was searched. */
  function summaryText(ranked: boolean): string {
    const n = items.length;
    const count = n === 1 ? "1 skov" : `${n} skove`;
    const picked = comparedCount > n;
    if (!ranked) return picked ? `De ${n} nærmeste skove` : `${count} · nærmeste først`;
    const ranking = deps.getRanking();
    const species = ranking?.filtered ? ranking.slugs.size : 0;
    const forWhat =
      species === 0 ? "" : ` for ${species === 1 ? "arten" : `de ${species} arter`} i din søgning`;
    return picked
      ? `De ${n} bedste af de ${comparedCount} nærmeste skove${forWhat}`
      : `${count} inden for ${searchedRadius} km · bedste forhold${forWhat} øverst`;
  }

  /** The summary line above the list. Returns the explainer it toggles (a
   * first, non-row item of the list, so it scrolls with the rows wherever
   * the card is short), or null when the list is not ranked by score. */
  function renderSummary(ranked: boolean): HTMLElement | null {
    const summary = h("p", "ff-summary");
    summary.append(h("span", "ff-summary__text", summaryText(ranked)));
    status.replaceChildren(summary);
    if (!ranked) return null;
    {
      const toggle = h("button", "ff-summary__help");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(explainerOpen));
      toggle.setAttribute("aria-controls", "ff-explainer");
      toggle.append(icon("help"), h("span", undefined, "Om tallet"));

      const explainer = h("li", "ff-explainer");
      explainer.id = "ff-explainer";
      explainer.hidden = !explainerOpen;
      explainer.append(
        scoreExplainer(deps.openScoreHelp),
        h(
          "p",
          "ff-explainer__note",
          "Tallet ved hver skov er dagens højeste forholdstal blandt arterne – arten står under " +
            `skovens navn. Vi sammenligner de ${MAX_CANDIDATES_TO_SCORE} nærmeste navngivne skove ` +
            `inden for afstanden og viser de ${MAX_RESULTS} med de højeste tal.`,
        ),
      );
      toggle.addEventListener("click", () => {
        explainerOpen = !explainerOpen;
        explainer.hidden = !explainerOpen;
        toggle.setAttribute("aria-expanded", String(explainerOpen));
        if (explainerOpen) list.scrollTop = 0;
      });
      summary.append(toggle);
      return explainer;
    }
  }

  function forestRow(item: Item, index: number): HTMLLIElement {
    const li = h("li", "forest-item");
    const button = h("button", "forest-row");
    button.type = "button";

    const text = h("span", "forest-row__text");
    const name = h("span", "forest-row__name");
    // shown (by CSS) on the row that is the forest the pin stands at
    const pinMark = h("span", "forest-row__here");
    pinMark.append(icon("pin"), h("span", undefined, "Din nål"));
    name.append(h("span", "forest-row__name-text", item.name), pinMark);
    text.append(name, h("span", "forest-row__meta"));

    const rank = h("span", "forest-row__rank", String(index + 1));
    rank.setAttribute("aria-hidden", "true");
    button.append(rank, text);

    if ("score" in item) button.append(h("span", "forest-row__score"));
    // (markHereRow, called once the rows are in, fills in the number and the species)

    button.addEventListener("click", () => select(index));
    button.addEventListener("pointerenter", () => setActive(index));
    button.addEventListener("pointerleave", () => setActive(null));
    button.addEventListener("focus", () => setActive(index));
    button.addEventListener("blur", () => setActive(null));

    // The way on to the species ranking for a chosen forest is the "Ved din
    // nål" card, which follows the pin and stays in view above the list.
    li.append(button);
    return li;
  }

  function markerLabel(item: Item, index: number): string {
    const score = scoreOf(item);
    return `${index + 1}. ${item.name}${score !== null ? `, forholdstal ${describeScore(score)}` : ""}`;
  }

  function showResults(found: Item[], radiusUsed: number): void {
    items = found;
    selected = null;
    list.removeAttribute("aria-busy");
    list.replaceChildren();
    clearForestMarkers();

    if (items.length === 0) {
      const empty = h("div", "ff-empty");
      empty.append(
        h("strong", undefined, `Ingen navngivne skove inden for ${radiusUsed} km`),
        h("span", undefined, "Prøv en større afstand, eller flyt nålen."),
      );
      status.replaceChildren(empty);
      setState("empty");
      updateCta();
      landFocus(radius.querySelector<HTMLInputElement>("input:checked"));
      return;
    }

    const ranked = items.some((item) => scoreOf(item) !== null);
    const explainer = renderSummary(ranked);
    if (explainer) list.append(explainer);
    items.forEach((item, index) => list.append(forestRow(item, index)));
    list.scrollTop = 0;
    // The rows' scores are the same numbers the "Ved din nål" card shows for
    // a forest: hand them over, so choosing a row fills the card at once.
    for (const item of items) {
      if (rankedWith && "score" in item) {
        here.remember(item, rankedWith, { score: item.score, scoreSpecies: item.scoreSpecies });
      }
    }
    here.refresh(); // a pin standing on one of these points gets its number at once
    markHereRow(here.status());
    setState("results");
    updateCta();
    root.scrollTop = 0;
    // Keyboard users who pressed the button land on the first result.
    landFocus(rowButton(0));

    const searchOrigin = origin;
    const thisSearch = token;
    void deps.mapReady.then((bundle) => {
      if (thisSearch !== token || root.dataset.state !== "results") return;
      showForestMarkers(
        bundle,
        items.map((item, index) => ({
          name: item.name,
          lon: item.lon,
          lat: item.lat,
          label: markerLabel(item, index),
        })),
        {
          onSelect: (index) => select(index),
          onHover: (index) => setActive(index, false),
          getPin: deps.getPin,
        },
      );
      const points = items.map((item): [number, number] => [item.lon, item.lat]);
      if (searchOrigin) points.push(searchOrigin);
      // Searched from a forest chosen by name: keep its outline in the frame
      // with the results, or the forest just asked for is lost from view.
      const status = here.status();
      const chosenShape =
        status.kind === "forest" && status.forest.chosen
          ? (deps.getOutlines()?.shape(status.forest.index) ?? null)
          : null;
      if (chosenShape) {
        const [west, south, east, north] = chosenShape.bbox;
        // ...unless that would shrink the results to a knot: Rold Skov is
        // 20 km across, its nearest forests a few. Where the map is too small
        // to show both (a phone), the results are framed and the outline runs
        // off the edge; a wide map shows the whole forest and the results in it.
        const lons = points.map((point) => point[0]);
        const lats = points.map((point) => point[1]);
        const resultSpan = Math.max(
          haversineKm(lats[0], Math.min(...lons), lats[0], Math.max(...lons)),
          haversineKm(Math.min(...lats), lons[0], Math.max(...lats), lons[0]),
        );
        const forestSpan = Math.max(
          haversineKm(south, west, south, east),
          haversineKm(south, west, north, west),
        );
        const pad = cameraPadding(bundle);
        const { clientWidth, clientHeight } = bundle.map.getContainer();
        const room = Math.min(
          clientWidth - pad.left - pad.right,
          clientHeight - pad.top - pad.bottom,
        );
        // the room the results would be left with, in px, were the forest framed
        const resultsPx = (resultSpan / Math.max(forestSpan, resultSpan)) * room;
        if (resultsPx >= MIN_RESULTS_PX) points.push([west, south], [east, north]);
      }
      frameForests(bundle, points, cameraPadding(bundle), !prefersReducedMotion());
    });
  }

  const rowButton = (index: number): HTMLButtonElement | null =>
    list.querySelectorAll<HTMLButtonElement>(".forest-row")[index] ?? null;

  /** Hover/focus link between a row and its marker, in both directions. */
  function setActive(index: number | null, fromList = true): void {
    setForestMarkerState(index, selected);
    if (fromList) return;
    list.querySelectorAll(".forest-row").forEach((row, i) => {
      row.classList.toggle("is-active", i === index);
    });
  }

  function select(index: number): void {
    const item = items[index];
    if (!item) return;
    selected = index;
    listChoice = item.index ?? null;
    list.querySelectorAll(".forest-item").forEach((li, i) => {
      li.classList.toggle("is-selected", i === index);
      const row = li.querySelector(".forest-row");
      if (i === index) row?.setAttribute("aria-current", "true");
      else row?.removeAttribute("aria-current");
    });
    setForestMarkerState(null, selected);
    scrollRowIntoView(index);
    const searchOrigin = origin;
    void deps.mapReady.then((bundle) => {
      if (selected !== index || origin !== searchOrigin) return;
      goTo(bundle, item, true);
      here.refresh(); // the "Ved din nål" card follows the pin to this forest
      // A fully open phone sheet folds to half to show the forest on the map:
      // once it has settled, make sure the chosen row is still in view.
      window.setTimeout(() => {
        if (selected === index) scrollRowIntoView(index);
      }, 450);
      layoutForestMarkers(); // the pin now stands on this forest: keep it uncovered
      if (searchOrigin) showForestOrigin(bundle, searchOrigin);
      updateCta(); // the pin has moved off the searched spot: offer "Søg herfra"
    });
    updateCta();
  }

  /** Bring a row into view below the "Ved din nål" card, which stays stuck to
   * the top of the scrolling tab while a list is showing. */
  function scrollRowIntoView(index: number): void {
    const row = rowButton(index)?.closest("li");
    if (!row) return;
    const view = root.getBoundingClientRect();
    const card = here.element.hidden ? null : here.element.getBoundingClientRect();
    const top = Math.max(view.top, card && card.bottom > view.top ? card.bottom : view.top) + 4;
    const rect = row.getBoundingClientRect();
    if (rect.top < top) root.scrollTop -= top - rect.top;
    else if (rect.bottom > view.bottom - 4) root.scrollTop += rect.bottom - (view.bottom - 4);
  }

  /** Move the pin to a forest. One that is already in plain view at a
   * readable zoom keeps the camera where it is, so its neighbours and their
   * numbers stay put; otherwise fly to it. */
  function goTo(bundle: MapBundle, forest: NearbyForest, fromList = false): void {
    const point: [number, number] = [forest.lon, forest.lat];
    const padding = cameraPadding(bundle);
    const zoom = bundle.map.getZoom();
    const readable = zoom >= READABLE_ZOOM;
    // (a little slack: framed results sit exactly on the padding's edge)
    const slack = (n: number): number => Math.max(0, n - 24);
    const frame = {
      top: slack(padding.top),
      right: slack(padding.right),
      bottom: slack(padding.bottom),
      left: slack(padding.left),
    };
    // A forest picked from the result list is in the frame the results were
    // given: the camera stays, however far out that frame is (a small screen
    // frames the same results further out), so every result stays in view.
    if ((readable || fromList) && isInView(bundle, point, frame)) {
      deps.goToForest(forest, null);
    } else {
      // Land in the middle of the uncovered part of the map, and keep the
      // zoom when it already reads well, so the neighbours stay in view.
      deps.goToForest(forest, {
        zoom: readable ? zoom : 12.5,
        offset: flightOffset(bundle, padding),
      });
    }
  }

  // --- searching ------------------------------------------------------

  /** Search around the pin, or around `from` (to redo a list where it was
   * searched from, when the pin has since moved on to one of its forests). */
  function search(from?: [number, number]): void {
    const pin = from ?? deps.getPin();
    if (!pin) {
      armed = true; // run as soon as there is a pin
      showNeedsPin();
      return;
    }
    armed = true;
    const radiusUsed = radiusKm();
    const [lon, lat] = pin;
    const thisSearch = ++token;
    origin = pin;
    searchedRadius = radiusUsed;
    clearForestMarkers();
    showLoading();

    const ranking = deps.getRanking();
    rankedWith = ranking ? new Set(ranking.slugs) : null;
    const shownFor = delay(MIN_LOADING_MS);
    void deps
      .loadPoints()
      .then(
        (points): readonly ForestPoint[] | null => points,
        (err) => {
          console.error("forest points failed to load", err);
          return null;
        },
      )
      .then(async (points) => {
        if (thisSearch !== token) return; // superseded by a newer search
        if (!points) {
          await shownFor;
          if (thisSearch === token) showError();
          return;
        }
        here.refresh(); // the forest data is here now, if it was not before
        const within = countWithin(points, lon, lat, radiusUsed);
        comparedCount = ranking ? Math.min(MAX_CANDIDATES_TO_SCORE, within) : within;
        let found: Item[];
        if (ranking) {
          try {
            found = await rankForestsByScore(
              points,
              ranking.manifest,
              ranking.modelBundle,
              ranking.slugs,
              lon,
              lat,
              radiusUsed,
              new Date(),
            );
          } catch (err) {
            console.error("forest ranking failed", err);
            found = nearestForests(points, lon, lat, radiusUsed);
          }
        } else {
          found = nearestForests(points, lon, lat, radiusUsed);
        }
        await shownFor;
        if (thisSearch !== token) return;
        showResults(found, radiusUsed);
      });
  }

  function close(): void {
    token++;
    armed = false;
    carryFocus = false;
    items = [];
    origin = null;
    selected = null;
    explainerOpen = false;
    clearForestMarkers();
    list.removeAttribute("aria-busy");
    list.replaceChildren();
    status.replaceChildren();
    setState("idle");
    updateCta();
    cta.focus();
  }

  // --- layout helpers -------------------------------------------------

  /** Room the map leaves around the floating UI, so framed markers are not
   * hidden behind the list they belong to or under the map's own controls.
   * Self-contained on purpose: swap it for the map's padding once the shell
   * tells MapLibre which part of the map is covered. */
  /** The part of the map the results may use, in pixels from its edges: what
   * the shell's sheet and search field cover (camera.ts), plus room for the
   * controls that ride the map's corners and for the markers' own size. */
  /** Where a flown-to forest should land, from the middle MapLibre aims at
   * (which already allows for the map's own padding). */
  function flightOffset({ map }: MapBundle, padding: Padding): [number, number] {
    const extra = beyond(padding, map.getPadding());
    return [(extra.left - extra.right) / 2, (extra.top - extra.bottom) / 2];
  }

  function cameraPadding({ map }: MapBundle): Padding {
    const covered = mapInsets(map);
    const padding: Padding = {
      top: covered.top + 56,
      right: covered.right + 64,
      // the locate button and the map key ride the sheet's top edge
      bottom: covered.bottom + (covered.bottom > 0 ? 84 : 48),
      left: covered.left + 40,
    };
    // the control stack in the top-right corner (zoom, compass, locate, help)
    const mapRect = map.getContainer().getBoundingClientRect();
    const controls = map.getContainer().querySelector(".maplibregl-ctrl-top-right");
    if (controls) {
      const rect = controls.getBoundingClientRect();
      if (rect.width > 0) padding.right = Math.max(padding.right, mapRect.right - rect.left + 26);
    }
    // the map key, where it is a card in the bottom-right corner (desktop):
    // keep the markers beside it when the map is wide enough to spare the room
    const key = map.getContainer().querySelector(".map-key");
    if (key) {
      const rect = key.getBoundingClientRect();
      const beside = mapRect.right - rect.left + 16;
      const isCornerCard = rect.width > 0 && rect.left > mapRect.left + mapRect.width / 2;
      if (isCornerCard && mapRect.width - padding.left - beside >= 420) {
        padding.right = Math.max(padding.right, beside);
      }
    }
    return padding;
  }

  // --- wiring ---------------------------------------------------------

  list.tabIndex = -1; // a place to hold focus while the list loads
  cta.addEventListener("click", () => {
    // The button steps aside once a list shows: remember that it had focus,
    // so focus moves on to the outcome instead of dropping to the page.
    carryFocus = document.activeElement === cta;
    search();
  });
  closeButton.addEventListener("click", close);
  radius.addEventListener("change", () => {
    radius.dataset.value = String(radiusKm());
    if (armed && deps.getPin()) search();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && root.dataset.state !== "idle") {
      event.stopPropagation();
      close();
    }
  });

  setState("idle");
  updateCta();

  // Opening the forest tab is when the pin's forest gets its score (and the
  // species filter may have changed while the other tab was showing).
  if (app) {
    new MutationObserver(() => {
      if (!tabShowing()) return;
      here.refresh();
      // The list was ranked for the species the other tab showed then. If
      // that has changed, rank it again (from where it was searched), so the
      // list and the card above it speak of the same species.
      const ranking = deps.getRanking();
      const now = ranking ? [...ranking.slugs].sort().join(",") : null;
      const then = rankedWith ? [...rankedWith].sort().join(",") : null;
      if (root.dataset.state === "results" && origin && now !== then) search(origin);
    }).observe(app, { attributes: true, attributeFilter: ["data-mobile-tab"] });
  }
  here.refresh();

  return {
    search(options): void {
      carryFocus = options?.focus ?? false;
      search();
    },
    outlinesChanged(): void {
      here.refresh();
      drawOutline(); // the same forest as before may only now have its outline
    },
    pinMoved(): void {
      listChoice = null;
      here.refresh(); // whatever else happens, the card follows the pin
      if (!armed) return;
      const pin = deps.getPin();
      if (!pin) {
        // The pin was removed: the list has no place to belong to any more.
        token++;
        items = [];
        origin = null;
        selected = null;
        list.removeAttribute("aria-busy");
        showNeedsPin();
        return;
      }
      // Geolocation re-fires on every fix: do not redo the search (and flash
      // the list) for a pin that has not really moved.
      if (
        pin &&
        origin &&
        root.dataset.state === "results" &&
        searchedRadius === radiusKm() &&
        !isStale()
      ) {
        return;
      }
      clearForestOrigin();
      search();
    },
  };
}
