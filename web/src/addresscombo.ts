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
  /** 0: its name is what was typed; 1: begins with it; 2: has it inside a
   * word. Forests and towns are listed in this order, forests first within
   * one rank. */
  rank?: number;
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
  rank?: number;
  target: [number, number];
  kind: SuggestionKind;
}

/** Pure: forests and towns in one list: by how well the name matches, a
 * forest before a town of the same rank, otherwise in the order given. */
export function byRank<T extends { rank?: number; kind: string }>(items: T[]): T[] {
  const order = (item: T): number => (item.rank ?? 1) * 2 + (item.kind === "local" ? 0 : 1);
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => order(a.item) - order(b.item) || a.i - b.i)
    .map((x) => x.item);
}

/** The line above addresses found elsewhere than in the town typed. */
export function missedText(street: string, town: string): string {
  return `Ingen ${street} i ${town} – adresser andre steder:`;
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
    const options = [...listbox.querySelectorAll<HTMLLIElement>('[role="option"]')];
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

  /** `note`: a line shown above the addresses (and read with each of them). */
  function render(next: Item[], note?: string): void {
    items = next;
    activeIndex = -1;
    input.removeAttribute("aria-activedescendant");
    listbox.replaceChildren();
    const noteId = `${listbox.id}-note`;
    let noted = false;
    items.forEach((item, i) => {
      if (note && item.kind === "address" && !noted) {
        noted = true;
        // not an option: hidden from the listbox's own reading, and given to
        // each address as its description instead
        const line = document.createElement("li");
        line.id = noteId;
        line.className = "results-note";
        line.setAttribute("aria-hidden", "true");
        line.textContent = note;
        listbox.appendChild(line);
      }
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
      if (note && item.kind === "address") li.setAttribute("aria-describedby", noteId);
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
    const taken = new Set(forests.map((f) => f.text));
    let places: Item[] = (await searchTowns(query, taken)).map((s) => ({ ...s, kind: "place" }));
    if (request.signal.aborted) return;
    let local = byRank([...forests, ...places]);
    if (places.length > 0) render(local);

    let addresses: Item[] = [];
    let failed = false;
    let note: string | undefined;
    try {
      const result = await searchAddresses(query, request.signal);
      if (result.missed) {
        note = missedText(result.missed.street, result.missed.town);
        // the town itself first: it may be where the user meant to go
        const town = result.missed.place;
        if (town && !local.some((item) => item.text === town.text)) {
          places = [{ ...town, kind: "place" }, ...places];
          local = [...places, ...forests];
        }
      }
      addresses = result.addresses
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
    if (addresses.length > 0 || local.length === 0)
      render(all, addresses.length ? note : undefined);
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
