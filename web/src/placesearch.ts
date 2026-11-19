// The place search: one text field that finds named forests (from the forest
// payload, matched in the browser) and addresses (Adressevælgeren), and says
// what became of a search that has nothing to list. The same code serves the
// main interface's search field (#q) and the start screen's "where?" step, so
// the two cannot drift apart.

import { attachAddressCombobox, type AddressCombobox, type SearchOutcome } from "./addresscombo";
import { loadedPlaceIndex, loadPlaceIndex, splitTown } from "./placeindex";

/** What was chosen: decides how close the map goes. */
export type PlaceKind = "address" | "forest" | "town";

const ICON_TOWN =
  '<svg class="place-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3.5 20.5V11l5-3.5 5 3.5v9.5M13.5 20.5V8.5l4-3 3 2.2v12.8M2.5 20.5h19M7 14h3M7 17h3M16.5 11h1.5M16.5 14h1.5M16.5 17h1.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const ICON_TREE =
  '<svg class="place-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2.8l4.3 5.7h-2.1l4.3 5.5h-2.3l3.3 4H4.5l3.3-4H5.5l4.3-5.5H7.7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 18v3.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

export const PLACE_SEARCH_PLACEHOLDER = "Søg skov eller adresse…";
export const PLACE_SEARCH_LABEL = "Søg skov eller adresse";

/** What the search says when it has little or nothing to list. `verb` is how
 * this device picks a spot on the map: "tryk" by touch, "klik" with a mouse. */
export function searchMessage(outcome: SearchOutcome, verb: "tryk" | "klik"): string {
  const query = outcome.query;
  if (outcome.state === "failed") {
    return outcome.shown > 0
      ? "Adressesøgningen svarer ikke lige nu, så her er kun skove og byer."
      : `Adressesøgningen svarer ikke lige nu. Tjek forbindelsen, og prøv igen – eller ${verb} på kortet.`;
  }
  if (outcome.state !== "empty") return "";
  // The address service wants three characters; forests are matched from two.
  return query.length < 3
    ? `Ingen skove matcher „${query}“. Skriv lidt mere for også at søge adresser.`
    : `Ingen skove, byer eller adresser matcher „${query}“. Prøv et vejnavn med by, fx „Vestergade 10, Silkeborg“, eller ${verb} på kortet.`;
}

/** "3 km fra Silkeborg", "i Silkeborg" under a kilometre. */
export function distanceText(
  { lon, lat }: { lon: number; lat: number },
  [tlon, tlat]: [number, number],
  town: string,
): string {
  const km = Math.hypot(
    (lon - tlon) * 111.32 * Math.cos((tlat * Math.PI) / 180),
    (lat - tlat) * 110.57,
  );
  return km < 1 ? `i ${town}` : `${Math.round(km)} km fra ${town}`;
}

export function attachPlaceSearch(opts: {
  input: HTMLInputElement;
  /** Must carry an id. */
  listbox: HTMLUListElement;
  /** Where the message goes; must carry an id. Hidden while there is none. */
  status: HTMLElement;
  /** Named forests matching what is typed (may be none while they load);
   * with `near`, those of the name near that point, the nearest first. */
  searchForests: (
    query: string,
    near?: [number, number],
  ) => { name: string; lon: number; lat: number }[];
  /** `zoom`: how close to fly, for a town or postal district. */
  onPlace: (target: [number, number], text: string, kind: PlaceKind, zoom?: number) => void;
  /** Enter with nothing highlighted takes the first suggestion. */
  enterPicksFirst?: boolean;
  /** The message appeared, changed or went away (its box changed size). */
  onStatusChange?: () => void;
}): AddressCombobox {
  const { input, listbox, status } = opts;
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

  input.placeholder = PLACE_SEARCH_PLACEHOLDER;
  input.spellcheck = false;
  input.setAttribute("aria-label", PLACE_SEARCH_LABEL);
  input.setAttribute("aria-describedby", status.id);
  listbox.setAttribute("aria-label", "Forslag til skove, byer og adresser");
  status.setAttribute("role", "status");
  status.hidden = true;

  const say = (text: string, state: string): void => {
    const changed = status.textContent !== text;
    status.textContent = text;
    status.hidden = text === "";
    status.dataset.state = state;
    if (changed) opts.onStatusChange?.();
  };

  const combobox = attachAddressCombobox({
    input,
    listbox,
    enterPicksFirst: opts.enterPicksFirst,
    local: (query) => {
      let forests = opts.searchForests(query);
      // "Vesterskov Silkeborg": the forests of that name near the town
      const index = forests.length === 0 ? loadedPlaceIndex() : null;
      const split = index ? splitTown(index, query) : null;
      if (split && split.rest) {
        // several forests share a name: say which one by how far from the town
        return opts.searchForests(split.rest, split.at).map((forest) => ({
          text: `${forest.name} · ${distanceText(forest, split.at, split.town)}`,
          label: forest.name,
          target: [forest.lon, forest.lat] as [number, number],
        }));
      }
      return forests.map((forest) => ({
        text: forest.name,
        target: [forest.lon, forest.lat] as [number, number],
      }));
    },
    localIcon: ICON_TREE,
    placeIcon: ICON_TOWN,
    onSelect: (target, text, kind, zoom) =>
      opts.onPlace(
        target,
        text,
        kind === "local" ? "forest" : kind === "place" ? "town" : "address",
        zoom,
      ),
    onOutcome: (outcome) =>
      say(searchMessage(outcome, finePointer.matches ? "klik" : "tryk"), outcome.state),
  });

  // The town list is fetched when the field is first focused, so the first
  // search does not wait for it.
  input.addEventListener("focus", () => void loadPlaceIndex().catch(() => {}), { once: true });

  // The message belongs to the search in progress: it goes when the field is
  // left (as the suggestions do), and an emptied field searches to "idle".
  input.addEventListener("blur", () => window.setTimeout(() => say("", "idle"), 150));

  return combobox;
}
