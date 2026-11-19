// The place search: one text field that finds named forests (from the forest
// payload, matched in the browser) and addresses (Adressevælgeren), and says
// what became of a search that has nothing to list. The same code serves the
// main interface's search field (#q) and the start screen's "where?" step, so
// the two cannot drift apart.

import { attachAddressCombobox, type AddressCombobox, type SearchOutcome } from "./addresscombo";

/** What was chosen: decides how close the map goes. */
export type PlaceKind = "address" | "forest";

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
      ? "Adressesøgningen svarer ikke lige nu, så her er kun skove."
      : `Adressesøgningen svarer ikke lige nu. Tjek forbindelsen, og prøv igen – eller ${verb} på kortet.`;
  }
  if (outcome.state !== "empty") return "";
  // The address service wants three characters; forests are matched from two.
  return query.length < 3
    ? `Ingen skove matcher „${query}“. Skriv lidt mere for også at søge adresser.`
    : `Ingen skove eller adresser matcher „${query}“. Prøv et vejnavn, fx „Vestergade, Silkeborg“, eller ${verb} på kortet.`;
}

export function attachPlaceSearch(opts: {
  input: HTMLInputElement;
  /** Must carry an id. */
  listbox: HTMLUListElement;
  /** Where the message goes; must carry an id. Hidden while there is none. */
  status: HTMLElement;
  /** Named forests matching what is typed (may be none while they load). */
  searchForests: (query: string) => { name: string; lon: number; lat: number }[];
  onPlace: (target: [number, number], text: string, kind: PlaceKind) => void;
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
  listbox.setAttribute("aria-label", "Forslag til skove og adresser");
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
    local: (query) =>
      opts.searchForests(query).map((forest) => ({
        text: forest.name,
        target: [forest.lon, forest.lat],
      })),
    localIcon: ICON_TREE,
    onSelect: (target, text, kind) =>
      opts.onPlace(target, text, kind === "local" ? "forest" : "address"),
    onOutcome: (outcome) =>
      say(searchMessage(outcome, finePointer.matches ? "klik" : "tryk"), outcome.state),
  });

  // The message belongs to the search in progress: it goes when the field is
  // left (as the suggestions do), and an emptied field searches to "idle".
  input.addEventListener("blur", () => window.setTimeout(() => say("", "idle"), 150));

  return combobox;
}
