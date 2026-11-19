// The start screen ("forside"): four ways into the app, each of which lands in
// the main interface already set up for that task. It is a layer of the same
// page, not a page of its own: the sidebar's content on wide screens (the map
// stays live beside it), a sheet over the map on phones.
//
// Three views, switched through data-start on #app (absent = closed):
//   home     the four ways in, the way straight to the map, and the safety
//            line pinned underneath
//   place    "where?" for the two ways in that need a spot: use my position,
//            search a forest or an address, or tap the map (on a phone this
//            view is a card at the top, so the map below it is there to be
//            tapped)
//   species  photo tiles of every species in the manifest, the ones in season
//            first
//
// This module draws the views and reports what was chosen; main.ts owns the
// pin, the map and the panels, and does the landing (see `enter`). What to
// show and in which order is decided in startstate.ts, which has the tests.

import type { AddressCombobox } from "./addresscombo";
import { h, icon } from "./dom";
import { isActiveQuery, resolveQuery } from "./keywords";
import { attachPlaceSearch, type PlaceKind } from "./placesearch";
import { seasonLabel } from "./season";
import { PHONE_LAYOUT } from "./sheet";
import {
  initialOthers,
  MAX_FEATURED,
  pickerOrder,
  pinSubline,
  seasonEyebrow,
  seasonLine,
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
  /** A forest or an address was chosen in the place step. */
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
  /** Phone only: how much of the map the layer covers from the top and the
   * bottom, so the camera can aim at what is left. Null when it covers none
   * (closed, or beside the map on a wide screen). */
  mapCover(): { top: number; bottom: number } | null;
}

const PLACE_COPY: Record<PlaceFlow, { title: string; lead: string }> = {
  here: {
    title: "Hvor vil du lede?",
    lead: "Så rangerer vi svampene efter forholdene dér i dag.",
  },
  forests: {
    title: "Hvor tager du af sted fra?",
    lead: "Så finder vi skovene i nærheden og rangerer dem efter dagens forhold.",
  },
};

const LOCATE_MESSAGES: Record<Exclude<LocateResult, "ok"> | "slow", string> = {
  denied:
    "Vi fik ikke lov til at bruge din placering. Søg en skov eller en adresse i stedet, eller tryk på kortet.",
  unavailable:
    "Vi kunne ikke finde din placering. Søg en skov eller en adresse i stedet, eller tryk på kortet.",
  slow: "Det tager længere end ventet. Du kan også søge en skov eller en adresse, eller trykke på kortet.",
};

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
  const homeTitle = document.getElementById("start-title") as HTMLElement;
  const skipLabel = document.getElementById("start-skip-label") as HTMLElement;
  const phone = window.matchMedia(PHONE_LAYOUT);
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const month = new Date().getMonth();

  let view: StartView | null = null;
  let pending: PlaceFlow | null = null;
  let manifest: Manifest | null = null;
  let manifestState: "loading" | "ready" | "failed" = "loading";
  let order: PickerOrder | null = null;
  let combobox: AddressCombobox | null = null;
  let locateToken = 0;
  let locating = false;
  let hasPin = false;
  let transitionTimer: number | undefined;

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

  function goHome(focusOn?: HTMLElement | null): void {
    stopLocating();
    combobox?.close();
    pending = null;
    refreshHome();
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

  // --- home view: aware of the pin --------------------------------------------

  const pinAware = (["here", "forests"] as const).map((flow) => {
    const sub = document.getElementById(`start-${flow}-sub`) as HTMLElement;
    return {
      sub,
      fallback: sub.textContent ?? "",
      item: sub.closest<HTMLElement>(".start__flow") as HTMLElement,
      change: views.home.querySelector<HTMLElement>(`[data-change="${flow}"]`) as HTMLElement,
    };
  });

  /** With a pin, the two cards that need a place go straight in for it: they
   * name it, and offer "Skift sted" for another. */
  function refreshHome(): void {
    const label = deps.getPinLabel();
    hasPin = label !== null;
    for (const card of pinAware) {
      card.sub.textContent = label === null ? card.fallback : pinSubline(label);
      card.item.classList.toggle("has-pin", hasPin);
      card.change.hidden = !hasPin;
    }
  }

  // --- place step -----------------------------------------------------------

  function showPlace(flow: PlaceFlow): void {
    stopLocating();
    combobox?.close();
    pending = flow;
    const copy = PLACE_COPY[flow];

    const title = h("h2", "start__title start__title--step", copy.title);
    title.id = "start-place-title";
    title.tabIndex = -1;
    const lead = h("p", "start__lead", copy.lead);

    const options = h("div", "place");
    const pinLabel = deps.getPinLabel();
    if (pinLabel !== null) {
      // Came here to change the place: staying with the pin is still an answer.
      const usePin = h("button", "place__option");
      usePin.type = "button";
      const text = h("span", "place__option-text");
      text.append(
        h("span", "place__option-title", "Behold nålen"),
        h("span", "place__option-sub", pinLabel),
      );
      usePin.append(icon("pin"), text);
      usePin.addEventListener("click", () => void deps.enter({ kind: flow }));
      options.append(usePin);
    }

    const locate = h("button", "place__option place__option--primary");
    locate.type = "button";
    const locateLabel = h("span", "place__option-title", "Brug min placering");
    const spinner = h("span", "place__spinner");
    spinner.setAttribute("aria-hidden", "true");
    locate.append(icon("locate"), locateLabel, spinner);

    const message = h("p", "place__message");
    message.setAttribute("role", "status");
    message.hidden = true;
    const say = (key: keyof typeof LOCATE_MESSAGES | null): void => {
      message.hidden = key === null;
      message.textContent = key === null ? "" : LOCATE_MESSAGES[key];
      message.dataset.kind = key ?? "";
    };

    const field = h("div", "start-field place__field");
    const input = h("input", "place__input");
    input.type = "search";
    input.id = "start-q";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.enterKeyHint = "search";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", "start-results");
    input.setAttribute("aria-autocomplete", "list");
    const listbox = h("ul", "place__results");
    listbox.id = "start-results";
    listbox.setAttribute("role", "listbox");
    // What became of a search that has nothing to list: said, not left blank.
    const searchStatus = h("p", "search-status");
    searchStatus.id = "start-search-status";
    field.append(svg("start-field__icon", ICON_SEARCH), input, searchStatus, listbox);
    // (placesearch.ts: the same search as the main interface's own field)
    combobox = attachPlaceSearch({
      input,
      listbox,
      status: searchStatus,
      enterPicksFirst: true,
      searchForests: deps.searchForests,
      onPlace: deps.onPlace,
    });

    const or = h("p", "place__or", "eller");
    or.setAttribute("aria-hidden", "true");
    const hint = h("p", "place__hint");
    hint.append(
      icon("map"),
      h("span", undefined, "Du kan også trykke på kortet og vælge stedet dér."),
    );

    locate.addEventListener("click", () => {
      if (locating) return;
      locating = true;
      const token = ++locateToken;
      say(null);
      or.hidden = false;
      locate.dataset.state = "busy";
      locate.setAttribute("aria-disabled", "true");
      locateLabel.textContent = "Finder din placering …";
      const slow = window.setTimeout(() => {
        if (token === locateToken) say("slow");
      }, LOCATE_SLOW_MS);
      void deps.locate().then((result) => {
        window.clearTimeout(slow);
        if (token !== locateToken) return; // left the step, or asked again
        locating = false;
        delete locate.dataset.state;
        locate.removeAttribute("aria-disabled");
        locateLabel.textContent = "Brug min placering";
        if (result === "ok") return; // main.ts has the pin and lands the flow
        say(result);
        // The search field is the way forward now: the button steps back
        // (it still works, for when the permission has been changed).
        locate.dataset.state = "failed";
        or.hidden = true;
        field.classList.add("is-suggested");
        deps.onViewChange(); // the card grew: keep the map's middle below it
        // With a keyboard the next step is to type; on a touch screen focusing
        // the field would throw the keyboard over the message just shown.
        if (finePointer.matches) input.focus({ preventScroll: true });
      });
    });

    options.append(locate, message, or, field, hint);
    views.place.replaceChildren(title, backButton(flow), lead, options);
    setView("place");
    deps.onViewChange();
    title.focus({ preventScroll: true });
  }

  // --- species step ---------------------------------------------------------

  const tiles = new Map<string, HTMLButtonElement>();
  const picker = h("div", "picker");
  const pickerStatus = h("p", "picker__status");
  const pickerSearch = h("input", "picker__input");
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
    button.addEventListener("click", () => void choose(item, button));
    tiles.set(key, button);
    return button;
  }

  async function choose(item: PickerSpecies, button: HTMLButtonElement): Promise<void> {
    if (choosing) return;
    choosing = true;
    pickerStatus.hidden = true;
    pickerStatus.removeAttribute("role");
    button.dataset.state = "loading";
    button.setAttribute("aria-busy", "true");
    const ok = await deps.enter({ kind: "species", slug: item.species.slug });
    choosing = false;
    delete button.dataset.state;
    button.removeAttribute("aria-busy");
    if (ok === false && view === "species") {
      pickerStatus.textContent = `Kunne ikke hente ${item.species.danish_name}. Tjek forbindelsen, og prøv igen.`;
      pickerStatus.setAttribute("role", "alert");
      pickerStatus.hidden = false;
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
      if (first) void choose(first, tile(first, false));
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

  // --- home view: what the manifest adds --------------------------------------

  function fillHome(): void {
    if (!manifest || !order) return;
    const { inSeason, others } = order;
    (document.getElementById("start-eyebrow") as HTMLElement).textContent = seasonEyebrow(
      month,
      inSeason.length,
    );
    (document.getElementById("start-season-line") as HTMLElement).textContent = seasonLine(
      inSeason.map((p) => p.species.danish_name),
      month,
    );

    // "Hvor finder jeg ...?": the first species of the picker, and how many more.
    const withPhoto = [...inSeason, ...others].filter((p) => p.species.thumbnail);
    const thumbs = document.getElementById("start-thumbs") as HTMLElement;
    const shown = withPhoto.slice(0, 3);
    thumbs.replaceChildren(...shown.map((p) => photo("flow__thumb", p.species.thumbnail, 48)));
    const rest = manifest.species.length - shown.length;
    if (shown.length > 0 && rest > 0)
      thumbs.append(h("span", "flow__thumb flow__thumb--more", `+${rest}`));

    // "Hvad er i sæson?": the species themselves, when there are any.
    const seasonal = inSeason.filter((p) => p.species.thumbnail).slice(0, 2);
    if (seasonal.length > 0) {
      const art = document.getElementById("start-season-art") as HTMLElement;
      art.classList.add("flow__icon--photos");
      art.replaceChildren(...seasonal.map((p) => photo("flow__thumb", p.species.thumbnail, 40)));
    }
  }

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
        if (view === "species") renderPickerBody();
      },
    );
  }
  watchManifest(deps.manifest);

  // --- wiring ---------------------------------------------------------------

  views.home.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const change = target.closest<HTMLElement>("[data-change]")?.dataset.change;
    if (change === "here" || change === "forests") {
      showPlace(change);
      return;
    }
    const flow = target.closest<HTMLElement>("[data-flow]")?.dataset.flow;
    switch (flow) {
      case "here":
      case "forests":
        // With a pin the question "where?" is already answered.
        if (hasPin && deps.getPinLabel() !== null) void deps.enter({ kind: flow });
        else showPlace(flow);
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

  /** One step back, to the card that led here. */
  function stepBack(): void {
    if (view === "place") goHome(flowButton(pending ?? "here"));
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
    applyInert();
    deps.onViewChange();
  });

  return {
    isOpen: () => view !== null,
    pendingFlow: () => (view === "place" ? pending : null),
    ignoresMapClicks: () => view === "species",
    open(options): void {
      const fromMain = options?.fromMain ?? false;
      stopLocating();
      combobox?.close();
      pending = null;
      refreshHome();
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
      combobox?.close();
      pending = null;
      setView(null);
      transition(wasOpen ? "leaving" : null);
    },
    current: () => ({ view, flow: view === "place" ? pending : null }),
    show(next, flow): void {
      if (view === null) {
        stopLocating();
        combobox?.close();
        pending = null;
        refreshHome();
        skipLabel.textContent = SKIP_LABEL.back;
        setView("home");
        transition("entering");
      }
      if (next === "home") goHome();
      else if (next === "place") showPlace(flow ?? "here");
      else showSpecies();
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
