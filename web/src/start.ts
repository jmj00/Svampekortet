// The start screen ("forside"). It asks the one thing the app needs before it
// can answer: where. Position, search and the map sit together at the top of
// the home view, so one tap (or a typed name) lands on today's ranking. Under
// that, what is in season now as photos (an answer before any question), and
// the two other ways in as rows. It is a layer of the same page, not a page of
// its own: the sidebar's content on wide screens (the map stays live beside
// it), a sheet over the map on phones.
//
// Three views, switched through data-start on #app (absent = closed):
//   home     where (position / search / map), the season strip, the forests
//            and species ways in, the way straight to the map, and the safety
//            line pinned underneath
//   place    for "here": a card at the top while the user taps the map (on a
//            phone the home view lies over it); for "forests": where to start
//            from, the same three ways as on the home view
//   species  photo tiles of every species in the manifest, the ones in season
//            first
//
// This module draws the views and reports what was chosen; main.ts owns the
// pin, the map and the panels, and does the landing (see `enter`). What to
// show and in which order is decided in startstate.ts, which has the tests.

import type { AddressCombobox } from "./addresscombo";
import { h, icon } from "./dom";
import { bindInstallButton } from "./install";
import { isActiveQuery, resolveQuery } from "./keywords";
import { attachPlaceSearch, type PlaceKind } from "./placesearch";
import { seasonLabel } from "./season";
import { PHONE_LAYOUT } from "./sheet";
import {
  initialOthers,
  MAX_FEATURED,
  monthName,
  pickerOrder,
  pinSubline,
  dateEyebrow,
  stripSpecies,
  type PickerOrder,
  type PickerSpecies,
} from "./startstate";
import { thumbSources } from "./thumb";
import type { Manifest } from "./types";

/** The two ways in that start by asking for a place. */
export type PlaceFlow = "here" | "forests";

export type Landing =
  | { kind: "map" }
  | { kind: "here" }
  | { kind: "forests" }
  /** `filter`: false when nothing is in season, so the filter would empty the list. */
  | { kind: "season"; filter: boolean }
  | { kind: "species"; slug: string };

export type LocateResult = "ok" | "denied" | "unavailable";

export type StartView = "home" | "place" | "species";

export interface StartDeps {
  app: HTMLElement;
  /** What lies behind the layer; made inert while it is covered. */
  behind: { search: HTMLElement; sheet: HTMLElement; map: HTMLElement };
  manifest: Promise<Manifest>;
  /** Fetch the manifest again after it failed (and whatever else hangs on it). */
  reloadManifest(): Promise<Manifest>;
  /** The current pin's name as the location chip shows it, or null without a pin. */
  getPinLabel(): string | null;
  /** One line on today's conditions at the pin ("3 arter med gode forhold i
   * dag"), or null while there is none to give. */
  getPinToday(): string | null;
  /** Ask the browser for the position. "ok" means a pin was set from it. */
  locate(): Promise<LocateResult>;
  /** Give up on a position that has not arrived yet. */
  cancelLocate(): void;
  /** Named forests matching what is typed in the place search (may be none
   * while the forests are still loading). */
  searchForests(
    query: string,
    near?: [number, number],
  ): { name: string; lon: number; lat: number }[];
  /** A forest or an address was chosen in a place search of the layer. */
  onPlace(target: [number, number], text: string, kind: PlaceKind, zoom?: number): void;
  /** Go into the main interface. For a species the result says whether its
   * page could be opened; the layer stays up until it has. */
  enter(landing: Landing): void | Promise<boolean>;
  /** The layer changed view or geometry by itself (not through open/close). */
  onViewChange(): void;
  /** The view shown changed, by any route (for the browser history, nav.ts). */
  onNavigate?(): void;
}

export interface StartScreen {
  isOpen(): boolean;
  /** The place step is waiting for a spot for this flow. */
  pendingFlow(): PlaceFlow | null;
  /** True while a click on the map should not set a pin: the species step
   * asks for a species, not a place. */
  ignoresMapClicks(): boolean;
  /** Show the home view. `fromMain`: it was opened from the main interface
   * (a home button), so it eases in, takes keyboard focus on its heading and
   * offers the way "back" to the map. */
  open(options?: { fromMain?: boolean }): void;
  close(): void;
  /** The view showing (null when closed), and the flow a place step is for. */
  current(): { view: StartView | null; flow: PlaceFlow | null };
  /** Show a view as Back or Forward brings it back: opens the layer (as from
   * the map) if it is closed. */
  show(view: StartView, flow?: PlaceFlow): void;
  /** The pin's name or today's line for it changed: redraw what shows them. */
  refreshPin(): void;
  /** A tap on the map from this far out should zoom in rather than set the
   * pin: the "here" map step, or the home view beside a live map. */
  wantsCloserTap(): boolean;
  /** The map zoomed in on a tap that was too far out: say to tap again. */
  zoomedIn(): void;
  /** Phone only: how much of the map the layer covers from the top and the
   * bottom, so the camera can aim at what is left. Null when it covers none
   * (closed, or beside the map on a wide screen). */
  mapCover(): { top: number; bottom: number } | null;
}

const FOREST_COPY = {
  title: "Hvor tager du af sted fra?",
  lead: "Så finder vi skovene i nærheden og rangerer dem efter dagens forhold.",
};

const LOCATE_MESSAGES: Record<Exclude<LocateResult, "ok"> | "slow", string> = {
  denied:
    "Du har ikke givet lov til at bruge din placering. Søg en skov, en by eller en adresse i stedet – eller vælg på kortet.",
  unavailable:
    "Vi kunne ikke finde din placering. Søg en skov, en by eller en adresse i stedet – eller vælg på kortet.",
  slow: "Det tager længere end ventet. Du kan også søge et sted eller vælge på kortet.",
};

const PLACE_PLACEHOLDER = "Søg skov, by eller adresse";

const TITLE_IDS: Record<StartView, string> = {
  home: "start-title",
  place: "start-place-title",
  species: "start-species-title",
};

/** After this long without a position, say so and point at the other ways. */
const LOCATE_SLOW_MS = 9000;
/** A little over the enter/leave animations in start.css. */
const TRANSITION_MS = 240;

const SKIP_LABEL = { fresh: "Gå direkte til kortet", back: "Tilbage til kortet" };

const ICON_MUSHROOM =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3.5 11.5C3.5 7 7.3 3.5 12 3.5s8.5 3.5 8.5 8c0 .8-.6 1.3-1.4 1.3H4.9c-.8 0-1.4-.5-1.4-1.3Z" fill="currentColor"/><path d="M9.8 14.3h4.4l.7 4.3a2 2 0 0 1-2 2.3h-1.8a2 2 0 0 1-2-2.3l.7-4.3Z" fill="currentColor" opacity=".55"/></svg>';
const ICON_BACK =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14.5 5.5 8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_SEARCH =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="6.25" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="m20 20-4.4-4.4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>';
const ICON_GRID =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/></g></svg>';
function svg(className: string, markup: string): HTMLSpanElement {
  const span = h("span", className);
  span.innerHTML = markup; // static markup from the constants above
  span.setAttribute("aria-hidden", "true");
  return span;
}

/** A species photo that loads lazily over a mushroom placeholder. `px` is the
 * size it is shown at, for picking the rendition. */
function photo(className: string, url: string | null | undefined, px: number): HTMLSpanElement {
  const box = svg(className, ICON_MUSHROOM);
  if (!url) return box;
  const img = h("img");
  const { src, srcset } = thumbSources(url);
  img.alt = ""; // decorative: the name is always beside it
  img.loading = "lazy";
  img.decoding = "async";
  if (srcset) {
    img.srcset = srcset;
    img.sizes = `${px}px`;
  }
  img.addEventListener("load", () => img.classList.add("is-loaded"));
  img.addEventListener("error", () => img.remove()); // offline: keep the placeholder
  img.src = src;
  box.append(img);
  return box;
}

/** The parts of a "where?" block: the position button, what it says when it
 * fails, and the place search. The home view has them in its markup; the
 * forests step builds them (buildPlaceParts). */
interface PlaceParts {
  locate: HTMLButtonElement;
  locateTitle: HTMLElement;
  message: HTMLElement;
  field: HTMLElement;
  input: HTMLInputElement;
  listbox: HTMLUListElement;
  status: HTMLElement;
}

interface PlaceBlock {
  /** Back to how it was first shown: no message, the button in front. */
  reset(): void;
  closeSearch(): void;
}

function buildPlaceParts(prefix: string): PlaceParts & { nodes: HTMLElement[] } {
  const locate = h("button", "locate");
  locate.type = "button";
  const text = h("span", "locate__text");
  const locateTitle = h("span", "locate__title", "Brug min placering");
  text.append(
    locateTitle,
    h("span", "locate__why", "Kun til dagens vurdering – gemmes kun hos dig"),
  );
  const spinner = h("span", "locate__spinner");
  spinner.setAttribute("aria-hidden", "true");
  locate.append(icon("locate", "ic locate__icon"), text, spinner);

  const message = h("p", "place__message");
  message.setAttribute("role", "status");
  message.hidden = true;

  const field = h("div", "start-field place__field");
  const input = h("input", "place__input");
  input.type = "search";
  input.id = `${prefix}-q`;
  input.autocomplete = "off";
  input.enterKeyHint = "search";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", `${prefix}-results`);
  input.setAttribute("aria-autocomplete", "list");
  const listbox = h("ul", "place__results");
  listbox.id = `${prefix}-results`;
  listbox.setAttribute("role", "listbox");
  const status = h("p", "search-status");
  status.id = `${prefix}-search-status`;
  field.append(svg("start-field__icon", ICON_SEARCH), input, status, listbox);

  const hint = h("p", "place__hint");
  hint.append(icon("map", "ic"), h("span", undefined, "Du kan også vælge stedet på kortet."));
  return {
    locate,
    locateTitle,
    message,
    field,
    input,
    listbox,
    status,
    nodes: [locate, message, field, hint],
  };
}

export function initStart(deps: StartDeps): StartScreen {
  const { app } = deps;
  const root = document.getElementById("start") as HTMLElement;
  const sheet = root.querySelector<HTMLElement>(".start__sheet") as HTMLElement;
  const scroller = root.querySelector<HTMLElement>(".start__scroll") as HTMLElement;
  const views: Record<StartView, HTMLElement> = {
    home: root.querySelector<HTMLElement>('[data-view="home"]') as HTMLElement,
    place: root.querySelector<HTMLElement>('[data-view="place"]') as HTMLElement,
    species: root.querySelector<HTMLElement>('[data-view="species"]') as HTMLElement,
  };
  const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
  const homeTitle = byId("start-title");
  const skipLabel = byId("start-skip-label");
  const phone = window.matchMedia(PHONE_LAYOUT);
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const month = new Date().getMonth();

  let view: StartView | null = null;
  let pending: PlaceFlow | null = null;
  let manifest: Manifest | null = null;
  let manifestState: "loading" | "ready" | "failed" = "loading";
  let order: PickerOrder | null = null;
  let locateToken = 0;
  let locating = false;
  let hasPin = false;
  let transitionTimer: number | undefined;
  /** The "where?" blocks alive now: the home view's, and the forests step's
   * while it shows. */
  const blocks = new Set<PlaceBlock>();

  // --- the layer itself -----------------------------------------------------

  function applyInert(): void {
    const open = view !== null;
    deps.behind.search.inert = open;
    deps.behind.sheet.inert = open;
    // On a phone the layer lies over the map, except in the place step, where
    // the map below the card is one of the ways to answer. On a wide screen
    // the map is beside the layer and always live.
    deps.behind.map.inert = open && phone.matches && view !== "place";
  }

  function setView(next: StartView | null): void {
    view = next;
    if (next) app.dataset.start = next;
    else delete app.dataset.start;
    if (next) {
      for (const [name, element] of Object.entries(views)) element.hidden = name !== next;
      // The layer's own geometry hangs on this, and stays while it fades out.
      root.dataset.view = next;
      scroller.scrollTop = 0;
      // The region is named after the heading of the view it shows.
      root.setAttribute("aria-labelledby", TITLE_IDS[next]);
    }
    if (next !== "home") endSearching();
    applyInert();
    deps.onNavigate?.();
  }

  /** Mark the layer as arriving or leaving for the length of the animation
   * (start.css). Nothing to mark when motion is reduced. */
  function transition(kind: "entering" | "leaving" | null): void {
    window.clearTimeout(transitionTimer);
    delete app.dataset.startEntering;
    delete app.dataset.startLeaving;
    if (kind === null || reducedMotion.matches) return;
    if (kind === "entering") app.dataset.startEntering = "";
    else app.dataset.startLeaving = "";
    transitionTimer = window.setTimeout(() => transition(null), TRANSITION_MS);
  }

  function stopLocating(): void {
    locateToken++;
    if (locating) deps.cancelLocate();
    locating = false;
  }

  /** Back to a fresh home view: no position on its way, no search open. */
  function resetHome(): void {
    stopLocating();
    homeZoom.hidden = true;
    for (const block of blocks) block.reset();
    pending = null;
    refreshHome();
  }

  function goHome(focusOn?: HTMLElement | null): void {
    resetHome();
    setView("home");
    deps.onViewChange();
    (focusOn ?? homeTitle).focus({ preventScroll: true });
  }

  const flowButton = (flow: string): HTMLElement | null =>
    views.home.querySelector<HTMLElement>(`[data-flow="${flow}"]`);

  /** The "Forside" button of a step. It comes after the heading in the
   * document (focus lands on the heading, and Tab goes on to this) and is
   * shown above it (start.css). */
  function backButton(returnTo: string): HTMLElement {
    const bar = h("div", "start__bar");
    const back = h("button", "start__back");
    back.type = "button";
    back.append(svg("start__back-icon", ICON_BACK), h("span", undefined, "Forside"));
    back.setAttribute("aria-label", "Tilbage til forsiden");
    back.addEventListener("click", () => goHome(flowButton(returnTo)));
    bar.append(back);
    return bar;
  }

  // --- "where?": position and search -----------------------------------------

  /** Wire a "where?" block: the position button with its busy and failed
   * states, and the place search. `onFail` runs after a failed position (the
   * card may have grown). */
  function wirePlace(parts: PlaceParts, onFail: () => void): PlaceBlock {
    const { locate, locateTitle, message, field, input, listbox, status } = parts;
    const say = (key: keyof typeof LOCATE_MESSAGES | null): void => {
      message.hidden = key === null;
      message.textContent = key === null ? "" : LOCATE_MESSAGES[key];
      message.dataset.kind = key ?? "";
    };
    // (placesearch.ts: the same search as the main interface's own field)
    const combobox: AddressCombobox = attachPlaceSearch({
      input,
      listbox,
      status,
      enterPicksFirst: true,
      searchForests: deps.searchForests,
      onPlace: deps.onPlace,
    });
    input.placeholder = PLACE_PLACEHOLDER;
    input.setAttribute("aria-label", PLACE_PLACEHOLDER);

    const idle = (): void => {
      delete locate.dataset.state;
      locate.removeAttribute("aria-disabled");
      locateTitle.textContent = "Brug min placering";
    };

    locate.addEventListener("click", () => {
      if (locating) return;
      locating = true;
      const token = ++locateToken;
      say(null);
      field.classList.remove("is-suggested");
      locate.dataset.state = "busy";
      locate.setAttribute("aria-disabled", "true");
      locateTitle.textContent = "Finder din placering …";
      const slow = window.setTimeout(() => {
        if (token === locateToken) say("slow");
      }, LOCATE_SLOW_MS);
      void deps.locate().then((result) => {
        window.clearTimeout(slow);
        if (token !== locateToken) return; // left the view, or asked again
        locating = false;
        idle();
        if (result === "ok") return; // main.ts has the pin and lands the flow
        say(result);
        // The search field is the way forward now: the button steps back
        // (it still works, for when the permission has been changed).
        locate.dataset.state = "failed";
        field.classList.add("is-suggested");
        onFail();
        // With a keyboard the next step is to type; on a touch screen focusing
        // the field would throw the keyboard over the message just shown.
        if (finePointer.matches) input.focus({ preventScroll: true });
      });
    });

    const block: PlaceBlock = {
      reset(): void {
        combobox.close();
        idle();
        say(null);
        field.classList.remove("is-suggested");
      },
      closeSearch: () => combobox.close(),
    };
    blocks.add(block);
    return block;
  }

  // The home view's block is in the markup, so it paints with the page.
  const homeParts: PlaceParts = {
    locate: byId("start-locate") as HTMLButtonElement,
    locateTitle: views.home.querySelector<HTMLElement>(".locate__title") as HTMLElement,
    message: byId("start-locate-message"),
    field: views.home.querySelector<HTMLElement>(".place__field") as HTMLElement,
    input: byId("start-q") as HTMLInputElement,
    listbox: byId("start-results") as HTMLUListElement,
    status: byId("start-search-status"),
  };
  wirePlace(homeParts, () => deps.onViewChange());

  // Phone: typing in the home view's search raises the layer to the top of
  // the screen, and what stood above the field steps aside (start.css), so
  // the suggestions have the room above the keyboard.
  const homeField = homeParts.field;
  function endSearching(): void {
    if (root.dataset.searching === undefined) return;
    delete root.dataset.searching;
  }
  homeParts.input.addEventListener("focus", () => {
    if (!phone.matches || view !== "home") return;
    root.dataset.searching = "";
    scroller.scrollTop = 0;
  });
  homeField.addEventListener("focusout", () => {
    // a tap on a suggestion moves focus inside the field's box, or lands the flow
    window.setTimeout(() => {
      if (!homeField.contains(document.activeElement)) endSearching();
    }, 200);
  });

  // --- home view: aware of the pin --------------------------------------------

  const resume = byId("start-resume") as HTMLButtonElement;
  const resumeTitle = byId("start-resume-title");
  const resumeSub = byId("start-resume-sub");
  const resumeOr = byId("start-resume-or");
  const lead = byId("start-lead");
  const forestsSub = byId("start-forests-sub");
  const forestsFallback = forestsSub.textContent ?? "";
  // Offered on a first visit too (the owner's choice), wherever the app can
  // be installed (install.ts).
  bindInstallButton(byId("start-install") as HTMLButtonElement);

  /** With a pin, the home view leads with it: "continue there", with today's
   * line, before the ways to choose another place. */
  function refreshHome(): void {
    const label = deps.getPinLabel();
    hasPin = label !== null;
    resume.hidden = !hasPin;
    resumeOr.hidden = !hasPin;
    lead.hidden = hasPin;
    if (label !== null) {
      resumeTitle.textContent = pinSubline(label);
      resumeSub.textContent = deps.getPinToday() ?? "Se dagens forhold for svampene dér";
      resume.setAttribute(
        "aria-label",
        `Fortsæt ved din nål: ${resumeTitle.textContent}. ${resumeSub.textContent}`,
      );
    }
    forestsSub.textContent = hasPin ? "De bedste skove omkring din nål i dag" : forestsFallback;
  }

  // --- place step -----------------------------------------------------------

  /** "Zoomed in, tap again": in the "here" map step, and on the home view
   * beside the map (sidebar layout). */
  const pickZoom = h("p", "place__zoom");
  pickZoom.setAttribute("role", "status");
  const homeZoom = byId("start-zoom");

  let stepBlock: PlaceBlock | null = null;

  function showPlace(flow: PlaceFlow): void {
    stopLocating();
    for (const block of blocks) block.closeSearch();
    if (stepBlock) blocks.delete(stepBlock);
    stepBlock = null;
    pending = flow;

    const title = h("h2", "start__title start__title--step");
    title.id = "start-place-title";
    title.tabIndex = -1;
    if (flow === "here") {
      // The home view had the position and the search: this step is the map.
      const verb = phone.matches ? "Tryk" : "Klik";
      title.textContent = `${verb} på kortet, hvor du vil lede`;
      const lead = h(
        "p",
        "start__lead",
        "Zoom ind, så du rammer den rigtige skov. Så vurderer vi dagens forhold dér.",
      );
      pickZoom.hidden = true;
      views.place.replaceChildren(title, backButton("pick"), lead, pickZoom);
      views.place.dataset.flow = "here";
    } else {
      title.textContent = FOREST_COPY.title;
      const lead = h("p", "start__lead", FOREST_COPY.lead);
      const options = h("div", "place");
      const pinLabel = deps.getPinLabel();
      if (pinLabel !== null) {
        // Came here to change the place: staying with the pin is still an answer.
        const usePin = h("button", "resume");
        usePin.type = "button";
        const text = h("span", "resume__text");
        text.append(
          h("span", "resume__title", "Behold nålen"),
          h("span", "resume__sub", pinSubline(pinLabel)),
        );
        usePin.append(icon("pin", "ic resume__icon"), text, icon("chevron", "ic resume__chevron"));
        usePin.addEventListener("click", () => void deps.enter({ kind: flow }));
        options.append(usePin);
      }
      const parts = buildPlaceParts("start-ff");
      stepBlock = wirePlace(parts, () => deps.onViewChange());
      options.append(...parts.nodes);
      views.place.replaceChildren(title, backButton(flow), lead, options);
      views.place.dataset.flow = "forests";
    }
    setView("place");
    deps.onViewChange();
    title.focus({ preventScroll: true });
  }

  // --- species: the strip on the home view, and the picker step ----------------

  const tiles = new Map<string, HTMLButtonElement>();
  const picker = h("div", "picker");
  const pickerStatus = h("p", "picker__status");
  const pickerSearch = h("input", "picker__input");
  const strip = byId("start-strip");
  const stripStatus = byId("start-strip-status");
  let pickerBuilt = false;
  let pickerExpanded = false;
  let choosing = false;

  function tileMeta(item: PickerSpecies): HTMLElement | null {
    const label = seasonLabel(item.season);
    if (label) {
      const meta = h("span", "tile__meta", label);
      meta.dataset.season = item.season.state;
      return meta;
    }
    // Its page will have no dots on the map: say so before the tap.
    if (item.species.observation_count === 0) return h("span", "tile__meta", "Ingen fund endnu");
    return null;
  }

  function tile(item: PickerSpecies, featured: boolean): HTMLButtonElement {
    const key = `${featured ? "f" : "t"}:${item.species.slug}`;
    const existing = tiles.get(key);
    if (existing) return existing;
    const button = h("button", featured ? "tile tile--featured" : "tile");
    button.type = "button";
    button.dataset.slug = item.species.slug;
    const text = h("span", "tile__text");
    text.append(h("span", "tile__name", item.species.danish_name));
    if (featured) text.append(h("span", "tile__sci", item.species.scientific_name));
    const meta = tileMeta(item);
    if (meta) text.append(meta);
    button.append(photo("tile__photo", item.species.thumbnail, featured ? 96 : 120), text);
    button.addEventListener("click", () => void choose(item, button, pickerStatus));
    tiles.set(key, button);
    return button;
  }

  /** Open a species' page; on failure say so in `status`. */
  async function choose(
    item: PickerSpecies,
    button: HTMLButtonElement,
    status: HTMLElement,
  ): Promise<void> {
    if (choosing) return;
    choosing = true;
    status.hidden = true;
    status.removeAttribute("role");
    button.dataset.state = "loading";
    button.setAttribute("aria-busy", "true");
    const ok = await deps.enter({ kind: "species", slug: item.species.slug });
    choosing = false;
    delete button.dataset.state;
    button.removeAttribute("aria-busy");
    if (ok === false && view !== null) {
      status.textContent = `Kunne ikke hente ${item.species.danish_name}. Tjek forbindelsen, og prøv igen.`;
      status.setAttribute("role", "alert");
      status.hidden = false;
    }
  }

  function grid(items: PickerSpecies[]): HTMLElement {
    const list = h("ul", "picker__grid");
    list.setAttribute("role", "list");
    for (const item of items) {
      const li = h("li");
      li.append(tile(item, false));
      list.append(li);
    }
    return list;
  }

  function section(title: string, count: number | null, ...content: HTMLElement[]): HTMLElement {
    const box = h("section", "picker__section");
    const heading = h("h3", "picker__heading", title);
    if (count !== null) heading.append(h("span", "picker__count", String(count)));
    box.append(heading, ...content);
    return box;
  }

  /** The species the picker is showing, in the order it shows them. */
  function matches(): PickerSpecies[] | null {
    if (!manifest || !order || !isActiveQuery(pickerSearch.value)) return null;
    const wanted = new Set(resolveQuery(pickerSearch.value, manifest).map((s) => s.slug));
    return [...order.inSeason, ...order.others].filter((p) => wanted.has(p.species.slug));
  }

  /** Returns the first tile that this call revealed beyond `revealFrom`. */
  function renderPicker(revealFrom?: number): HTMLElement | null {
    if (!manifest || !order) return null;
    const found = matches();
    if (found) {
      if (found.length === 0) {
        const empty = h("p", "picker__empty");
        empty.append(
          h("strong", undefined, `Ingen svampe matcher „${pickerSearch.value.trim()}“`),
          h("span", undefined, "Prøv fx kantarel, rørhat eller Karl Johan."),
        );
        picker.replaceChildren(empty);
      } else {
        picker.replaceChildren(grid(found));
      }
      return null;
    }

    const { inSeason, others } = order;
    const parts: HTMLElement[] = [];
    if (inSeason.length > 0) {
      if (inSeason.length <= MAX_FEATURED) {
        const list = h("ul", "picker__featured");
        list.setAttribute("role", "list");
        for (const item of inSeason) {
          const li = h("li");
          li.append(tile(item, true));
          list.append(li);
        }
        parts.push(section("I sæson nu", null, list));
      } else {
        parts.push(section("I sæson nu", inSeason.length, grid(inSeason)));
      }
    }
    const shown = pickerExpanded ? others.length : initialOthers(inSeason.length, others.length);
    const visible = others.slice(0, shown);
    if (visible.length > 0) {
      parts.push(
        inSeason.length > 0
          ? section("Flere svampe", null, grid(visible))
          : section("Alle svampe", others.length, grid(visible)),
      );
    }
    if (shown < others.length) {
      const total = manifest.species.length;
      const more = h("button", "picker__more", `Vis alle ${total} arter`);
      more.type = "button";
      more.addEventListener("click", () => {
        pickerExpanded = true;
        renderPicker(shown)?.focus({ preventScroll: true });
      });
      parts.push(more);
    }
    picker.replaceChildren(...parts);
    if (revealFrom === undefined) return null;
    const first = others[revealFrom];
    return first ? tile(first, false) : null;
  }

  /** The picker's content for where the manifest is: tiles, placeholders
   * while it loads, or the failure with a way to try again. */
  function renderPickerBody(): void {
    pickerSearch.disabled = manifestState !== "ready";
    if (manifestState === "ready") {
      renderPicker();
      return;
    }
    if (manifestState === "loading") {
      const list = h("ul", "picker__grid");
      list.setAttribute("aria-hidden", "true");
      for (let i = 0; i < 9; i++) {
        const li = h("li", "tile tile--skeleton");
        li.append(h("span", "tile__photo"), h("span", "tile__name"));
        list.append(li);
      }
      picker.replaceChildren(list);
      return;
    }
    const failed = h("div", "picker__failed");
    failed.setAttribute("role", "alert");
    const retry = h("button", "picker__more", "Prøv igen");
    retry.type = "button";
    retry.addEventListener("click", () => {
      manifestState = "loading";
      renderPickerBody();
      views.species
        .querySelector<HTMLElement>("#start-species-title")
        ?.focus({ preventScroll: true });
      watchManifest(deps.reloadManifest());
    });
    failed.append(
      h("strong", undefined, "Kunne ikke hente svampene"),
      h("span", undefined, "Tjek forbindelsen, og prøv igen."),
      retry,
    );
    picker.replaceChildren(failed);
  }

  function buildPicker(): void {
    pickerBuilt = true;
    const title = h("h2", "start__title start__title--step", "Hvilken svamp leder du efter?");
    title.id = "start-species-title";
    title.tabIndex = -1;
    const lead = h("p", "start__lead", "Vælg en art, og se på kortet, hvor den er fundet før.");

    const field = h("div", "start-field picker__field");
    pickerSearch.type = "search";
    pickerSearch.placeholder = "Søg svamp, fx kantarel";
    pickerSearch.autocomplete = "off";
    pickerSearch.spellcheck = false;
    pickerSearch.enterKeyHint = "search";
    pickerSearch.setAttribute("aria-label", "Søg svamp");
    pickerSearch.addEventListener("input", () => renderPicker());
    // Enter opens the first match and puts the phone's keyboard away.
    pickerSearch.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const [first] = matches() ?? [];
      pickerSearch.blur();
      if (first) void choose(first, tile(first, false), pickerStatus);
    });
    field.append(svg("start-field__icon", ICON_SEARCH), pickerSearch);

    pickerStatus.hidden = true;
    views.species.replaceChildren(title, backButton("species"), lead, field, pickerStatus, picker);
  }

  function showSpecies(): void {
    if (!pickerBuilt) buildPicker();
    pickerSearch.value = "";
    pickerStatus.hidden = true;
    renderPickerBody();
    setView("species");
    deps.onViewChange();
    views.species
      .querySelector<HTMLElement>("#start-species-title")
      ?.focus({ preventScroll: true });
  }

  /** One photo of the strip: the photo, the name, and where it is in its season. */
  function stripTile(item: PickerSpecies): HTMLElement {
    const li = h("li", "strip__item");
    const button = h("button", "strip__tile");
    button.type = "button";
    button.dataset.slug = item.species.slug;
    const text = h("span", "strip__text");
    text.append(h("span", "strip__name", item.species.danish_name));
    const label = seasonLabel(item.season);
    if (label) {
      const meta = h("span", "strip__meta", label);
      meta.dataset.season = item.season.state;
      text.append(meta);
      // the name and the season as two words, not run together
      button.setAttribute("aria-label", `${item.species.danish_name}, ${label.toLowerCase()}`);
    }
    button.append(photo("strip__photo", item.species.thumbnail, 96), text);
    button.addEventListener("click", () => void choose(item, button, stripStatus));
    li.append(button);
    return li;
  }

  function fillStrip(): void {
    if (!manifest || !order) return;
    const { inSeason, items } = stripSpecies(order);
    byId("start-season-title").textContent = inSeason
      ? `I sæson i ${monthName(month)}`
      : "Ingen i sæson lige nu";
    // With nothing in season, the list is for looking ahead, unfiltered.
    byId("start-season-all").textContent = inSeason ? "Se dem i listen" : "Se hvornår";
    byId("start-season-all")
      .closest("button")
      ?.setAttribute(
        "aria-label",
        inSeason ? "Se arterne i sæson i listen" : "Se alle arter og deres sæson i listen",
      );
    const all = h("li", "strip__item");
    const allButton = h("button", "strip__tile strip__tile--all");
    allButton.type = "button";
    allButton.dataset.flow = "species";
    allButton.setAttribute("aria-label", `Alle ${manifest.species.length} arter: søg og vælg`);
    const allText = h("span", "strip__text");
    allText.append(
      h("span", "strip__name", `Alle ${manifest.species.length} arter`),
      h("span", "strip__meta", "Søg og vælg"),
    );
    allButton.append(svg("strip__photo strip__photo--all", ICON_GRID), allText);
    all.append(allButton);
    strip.replaceChildren(...items.map(stripTile), all);
    strip.removeAttribute("aria-busy");
  }

  // --- home view: what the manifest adds --------------------------------------

  function fillHome(): void {
    if (!manifest || !order) return;
    fillStrip();
  }

  // "i dag" in the headline is this day: say which (it needs no data).
  byId("start-eyebrow").textContent = dateEyebrow(new Date());

  function watchManifest(loading: Promise<Manifest>): void {
    loading.then(
      (loaded) => {
        manifest = loaded;
        manifestState = "ready";
        order = pickerOrder(loaded.species, month);
        fillHome();
        if (view === "species") renderPickerBody();
      },
      () => {
        manifestState = "failed";
        // The strip has nothing to show: the species step says why and retries.
        strip.replaceChildren();
        strip.removeAttribute("aria-busy");
        if (view === "species") renderPickerBody();
      },
    );
  }
  watchManifest(deps.manifest);

  // --- wiring ---------------------------------------------------------------

  views.home.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const flow = target.closest<HTMLElement>("[data-flow]")?.dataset.flow;
    switch (flow) {
      case "here":
        // the "continue at your pin" card
        if (hasPin && deps.getPinLabel() !== null) void deps.enter({ kind: "here" });
        break;
      case "pick":
        showPlace("here");
        break;
      case "forests":
        // With a pin the question "where?" is already answered.
        if (hasPin && deps.getPinLabel() !== null) void deps.enter({ kind: "forests" });
        else showPlace("forests");
        break;
      case "species":
        showSpecies();
        break;
      case "season":
        void deps.enter({ kind: "season", filter: (order?.inSeason.length ?? 1) > 0 });
        break;
      case "map":
        void deps.enter({ kind: "map" });
        break;
    }
  });

  /** One step back, to what led here. */
  function stepBack(): void {
    if (view === "place") goHome(flowButton(pending === "forests" ? "forests" : "pick"));
    else if (view === "species") goHome(flowButton("species"));
  }

  // Escape steps back: from a step to the home view, from there to the map.
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    if (event.target === pickerSearch && pickerSearch.value !== "") {
      pickerSearch.value = ""; // first Escape empties the search, as the field itself would
      renderPicker();
      return;
    }
    if (event.target === homeParts.input && homeParts.input.value !== "") {
      // the same for the place search on the home view (and its message goes)
      homeParts.input.value = "";
      homeParts.input.dispatchEvent(new Event("input"));
      return;
    }
    if (view === "home") void deps.enter({ kind: "map" });
    else stepBack();
  });
  // The same from the map beside a step (keyboard focus can be on its
  // controls). From the home view the map is simply the map: nothing to undo.
  deps.behind.map.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (view !== "place" && view !== "species") return;
    event.preventDefault();
    stepBack();
  });

  phone.addEventListener("change", () => {
    if (view === null) return;
    endSearching();
    applyInert();
    deps.onViewChange();
  });

  return {
    isOpen: () => view !== null,
    pendingFlow: () => (view === "place" ? pending : null),
    ignoresMapClicks: () => view === "species",
    open(options): void {
      const fromMain = options?.fromMain ?? false;
      resetHome();
      skipLabel.textContent = fromMain ? SKIP_LABEL.back : SKIP_LABEL.fresh;
      const wasOpen = view !== null;
      setView("home");
      if (fromMain) {
        if (!wasOpen) transition("entering");
        homeTitle.focus({ preventScroll: true });
      }
    },
    close(): void {
      const wasOpen = view !== null;
      locateToken++; // a position still on its way belongs to the main interface now
      locating = false;
      for (const block of blocks) block.reset();
      pending = null;
      setView(null);
      transition(wasOpen ? "leaving" : null);
    },
    current: () => ({ view, flow: view === "place" ? pending : null }),
    show(next, flow): void {
      if (view === null) {
        resetHome();
        skipLabel.textContent = SKIP_LABEL.back;
        setView("home");
        transition("entering");
      }
      if (next === "home") goHome();
      else if (next === "place") showPlace(flow ?? "here");
      else showSpecies();
    },
    refreshPin(): void {
      if (view !== null) refreshHome();
    },
    wantsCloserTap: () =>
      (view === "place" && pending === "here") || (view === "home" && !phone.matches),
    zoomedIn(): void {
      const verb = phone.matches ? "Tryk" : "Klik";
      const box = view === "place" ? pickZoom : homeZoom;
      box.textContent = `Vi har zoomet ind. ${verb} igen dér, hvor du vil lede.`;
      box.hidden = false;
    },
    mapCover(): { top: number; bottom: number } | null {
      if (view === null || !phone.matches) return null;
      const rect = sheet.getBoundingClientRect();
      const appRect = app.getBoundingClientRect();
      return view === "place"
        ? { top: Math.round(rect.bottom - appRect.top), bottom: 0 }
        : { top: 0, bottom: Math.round(appRect.bottom - rect.top) };
    },
  };
}
