// Address autocomplete (Adressevælgeren) as an ARIA combobox: a text field
// and the listbox its suggestions go into. Used by the address search of the
// main interface (#q) and by the start screen's "where?" step, which also
// feeds it named forests and shows what became of each search.

import { searchAddresses, searchTowns } from "./addresses";

export interface AddressCombobox {
  /** Close the suggestions and drop any search still on its way. */
  close(): void;
}

/** A suggestion that does not come from the address service (a named forest,
 * a town). */
export interface LocalSuggestion {
  text: string;
  target: [number, number];
  /** The name it goes by once chosen, when not `text`. */
  label?: string;
  /** How close to fly, when the kind does not say. */
  zoom?: number;
}

/** What became of the last search, for a caller that tells the user:
 *  idle     nothing searched (field empty or too short)
 *  results  suggestions are showing
 *  empty    the search went through and nothing matched
 *  failed   the address service could not be reached (`shown` says how many
 *           local suggestions are showing all the same) */
export type SearchOutcome =
  | { state: "idle" | "results" | "empty"; query: string }
  | { state: "failed"; query: string; shown: number };

export type SuggestionKind = "address" | "local" | "place";

interface Item {
  text: string;
  label?: string;
  zoom?: number;
  target: [number, number];
  kind: SuggestionKind;
}

/** From this many characters a search with no match is worth mentioning. */
const MIN_QUERY = 2;

export function attachAddressCombobox(opts: {
  input: HTMLInputElement;
  /** Must carry an id; the input should name it in aria-controls. */
  listbox: HTMLUListElement;
  /** A suggestion was chosen: its position as [lon, lat], its name, what
   * kind it was (an address, one of the caller's own, a town) and, for a
   * town, how close to fly. */
  onSelect: (target: [number, number], text: string, kind: SuggestionKind, zoom?: number) => void;
  /** Enter with nothing highlighted takes the first suggestion. */
  enterPicksFirst?: boolean;
  /** Suggestions of the caller's own, listed above the addresses. */
  local?: (query: string) => LocalSuggestion[];
  /** Markup put in front of a local suggestion's text (a static icon). */
  localIcon?: string;
  /** Markup put in front of a town or postal district (a static icon). */
  placeIcon?: string;
  /** Told after every search, and when a suggestion is chosen. */
  onOutcome?: (outcome: SearchOutcome) => void;
}): AddressCombobox {
  const { input, listbox, onSelect } = opts;
  let debounce: number | undefined;
  let inFlight: AbortController | null = null;
  let items: Item[] = [];
  let activeIndex = -1;

  function closeResults(): void {
    listbox.replaceChildren();
    items = [];
    activeIndex = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function select(item: Item | undefined): void {
    if (!item) return;
    const name = item.label ?? item.text;
    input.value = name;
    closeResults();
    opts.onOutcome?.({ state: "idle", query: "" });
    onSelect(item.target, name, item.kind, item.zoom);
  }

  function highlight(next: number): void {
    const options = [...listbox.children] as HTMLLIElement[];
    if (options.length === 0) return;
    activeIndex = (next + options.length) % options.length;
    options.forEach((li, i) => {
      const on = i === activeIndex;
      li.classList.toggle("is-active", on);
      li.setAttribute("aria-selected", String(on));
      if (on) {
        input.setAttribute("aria-activedescendant", li.id);
        li.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function render(next: Item[]): void {
    items = next;
    activeIndex = -1;
    input.removeAttribute("aria-activedescendant");
    listbox.replaceChildren();
    items.forEach((item, i) => {
      const li = document.createElement("li");
      li.id = `${listbox.id}-opt-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      if (item.kind === "local") {
        li.dataset.kind = "local";
        if (opts.localIcon) li.insertAdjacentHTML("afterbegin", opts.localIcon); // static markup
      } else if (item.kind === "place") {
        li.dataset.kind = "place";
        if (opts.placeIcon) li.insertAdjacentHTML("afterbegin", opts.placeIcon); // static markup
      }
      li.append(document.createTextNode(item.text));
      li.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus on the input
      li.addEventListener("click", () => select(item));
      listbox.appendChild(li);
    });
    input.setAttribute("aria-expanded", String(items.length > 0));
  }

  async function runSearch(): Promise<void> {
    inFlight?.abort();
    const request = new AbortController();
    inFlight = request;
    const query = input.value.trim();

    const forests: Item[] = (opts.local?.(query) ?? []).map((s) => ({ ...s, kind: "local" }));
    // The caller's own suggestions need no network: show them straight away.
    if (forests.length > 0) render(forests);
    // Towns and postal districts come from the app's own list (fetched once).
    const places: Item[] = (await searchTowns(query)).map((s) => ({ ...s, kind: "place" }));
    if (request.signal.aborted) return;
    const local = [...forests, ...places];
    if (places.length > 0) render(local);

    let addresses: Item[] = [];
    let failed = false;
    try {
      const found = await searchAddresses(query, request.signal);
      addresses = found
        .filter((s) => typeof s.adgangsadresse?.x === "number")
        .map((s) => ({
          text: s.tekst,
          target: [s.adgangsadresse.x, s.adgangsadresse.y],
          kind: "address",
        }));
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      console.warn("address search failed", err);
      failed = true;
    }
    if (request.signal.aborted) return; // a newer search has taken over

    const all = [...local, ...addresses];
    // Do not rebuild a list the user may already be stepping through.
    if (addresses.length > 0 || local.length === 0) render(all);
    if (failed) opts.onOutcome?.({ state: "failed", query, shown: all.length });
    else if (all.length > 0) opts.onOutcome?.({ state: "results", query });
    else opts.onOutcome?.({ state: query.length >= MIN_QUERY ? "empty" : "idle", query });
  }

  input.addEventListener("input", () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void runSearch(), 250);
  });

  input.addEventListener("keydown", (e) => {
    if (listbox.children.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlight(activeIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlight(activeIndex - 1);
    } else if (e.key === "Enter" && (activeIndex >= 0 || opts.enterPicksFirst)) {
      e.preventDefault();
      select(items[Math.max(0, activeIndex)]);
    } else if (e.key === "Escape") {
      // Escape closes the suggestions first; only the next one reaches
      // whatever the field sits in.
      e.stopPropagation();
      closeResults();
    }
  });

  input.addEventListener("blur", () => window.setTimeout(closeResults, 150));

  return {
    close(): void {
      window.clearTimeout(debounce);
      inFlight?.abort();
      closeResults();
    },
  };
}
