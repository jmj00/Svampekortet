// "Ved din nål": the card at the top of the forest tab that says which named
// forest the pin stands in or right beside, what today's conditions are at the
// pin, and offers the way to the species ranking for that spot. The number is
// the one that tops that ranking: both score the pin's own position. It reads as "this
// is where you are", apart from the ranked search results below it.
//
// Which forest that is, is decided by forestAtPin (forests.ts) -- the same
// rule the location chip uses, so the two never disagree. The name shows at
// once; the score is worked out afterwards, and only while the tab is showing,
// so switching tabs and moving the pin stay instant.

import { h, icon } from "./dom";
import {
  closestForest,
  compassDa,
  pinForest,
  scoreForest,
  type ForestScore,
  type NearbyForest,
} from "./forests";
import type { ForestOutlines } from "./forestoutlines";
import type { ModelBundle } from "./model";
import { scoreBand } from "./score";
import { describeScore } from "./scoreinfo";
import type { ForestPoint, Manifest } from "./types";

/** What stands at the pin, as far as named forests go. */
export type HereStatus =
  /** No pin, or the forest data is not there (yet): the card is not shown. */
  | { kind: "unknown" }
  /** The outlines for the pin's part of the country are on their way: the
   * card says it is looking, and names nothing it may have to take back. */
  | { kind: "pending" }
  /** The pin is in or right beside this forest. */
  | { kind: "forest"; forest: NearbyForest }
  /** A pin with no named forest by it; `nearest` is the closest one worth
   * offering as a shortcut, if any. */
  | { kind: "nowhere"; nearest: NearbyForest | null };

/** How far to look for a forest to offer when the pin is not by one (km). */
export const SHORTCUT_KM = 30;

/** Pure: what the pin stands at, given the forest points. */
export function resolveHere(
  points: readonly ForestPoint[] | null,
  pin: [number, number] | null,
  outlines: ForestOutlines | null = null,
): HereStatus {
  if (!pin || !points) return { kind: "unknown" };
  const [lon, lat] = pin;
  const forest = pinForest(points, lon, lat, outlines);
  if (forest === "pending") return { kind: "pending" };
  if (forest) return { kind: "forest", forest };
  return { kind: "nowhere", nearest: closestForest(points, lon, lat, SHORTCUT_KM, outlines) };
}

/** What the card knows about the score for its forest. */
export type HereScore =
  | { state: "loading" }
  | { state: "ready"; score: ForestScore }
  /** No conditions model in this data set, or it never arrived. */
  | { state: "unavailable" }
  /** The model could not be loaded this time. */
  | { state: "offline" }
  | { state: "failed" };

/** Pure: the line under the forest's name. `filteredSpecies` is how many
 * scored species the list is narrowed to (0 when the search matches none of
 * them), or null when the list shows them all. */
export function hereMetaText(score: HereScore, filteredSpecies: number | null): string {
  if (score.state === "loading") return "Beregner dagens forhold …";
  if (score.state === "unavailable") return "Dagens forhold kan ikke beregnes for dette sted.";
  if (score.state === "offline") return "Dagens forhold kan ikke beregnes lige nu.";
  if (score.state === "failed") return "Dagens forhold kunne ikke beregnes.";
  const { score: value, scoreSpecies } = score.score;
  if (value === null || !scoreSpecies) {
    return filteredSpecies !== null
      ? "Ingen af arterne i din søgning har et forholdstal her."
      : "Intet forholdstal for dette sted i dag.";
  }
  // A top score of 0 has no "best" species worth naming: none of them has
  // conditions here today.
  if (value === 0) {
    return filteredSpecies !== null
      ? "Ingen af arterne i din søgning har gunstige forhold her i dag."
      : "Ingen af arterne har gunstige forhold her i dag.";
  }
  if (filteredSpecies === 1) return `Dagens forhold for ${scoreSpecies}`;
  if (filteredSpecies !== null && filteredSpecies > 1) {
    return `Bedst for ${scoreSpecies} blandt de ${filteredSpecies} arter i din søgning`;
  }
  return `Dagens forhold · bedst for ${scoreSpecies}`;
}

/** Pure: a short form of hereMetaText, for the folded card on a phone,
 * where the line under the name has one line and little width. */
export function hereMetaShort(score: HereScore, filteredSpecies: number | null): string {
  if (score.state === "loading") return "Beregner …";
  if (score.state !== "ready") return "Kan ikke beregnes";
  const { score: value, scoreSpecies } = score.score;
  if (value === null || !scoreSpecies) return "Intet forholdstal";
  if (value === 0) return "Ingen gunstige forhold i dag";
  return filteredSpecies === 1 ? scoreSpecies : `Bedst for ${scoreSpecies}`;
}

/** The tooltip of a score pill that says 0, on the card and in the rows. */
export const ZERO_SCORE_TITLE = "Ingen af arterne har gunstige forhold her i dag";

/** Pure: identifies one score: a position (to about a metre), a set of
 * species and a day. */
export function scoreKey(
  point: { lon: number; lat: number },
  slugs: ReadonlySet<string>,
  date: Date,
): string {
  const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  const at = `${point.lon.toFixed(5)}|${point.lat.toFixed(5)}`;
  return `${at}|${day}|${[...slugs].sort().join(",")}`;
}

export interface ForestHereDeps {
  getPin(): [number, number] | null;
  loadPoints(): Promise<readonly ForestPoint[]>;
  /** The forest outlines fetched so far, or null when none are published. */
  getOutlines(): ForestOutlines | null;
  /** What to score with, or null when there is no conditions model (yet). */
  getRanking(): {
    manifest: Manifest;
    modelBundle: ModelBundle;
    slugs: Set<string>;
    filtered: boolean;
  } | null;
  /** True once it is known that no model is coming (it failed to load, or
   * the data set has none): the card then gives up at once. */
  rankingFailed?(): "offline" | "none" | null;
  /** Whether the forest tab is on screen: scores are only worked out then. */
  isShowing(): boolean;
  /** Move the pin to a forest (the "nearest forest" shortcut). */
  moveTo(forest: NearbyForest): void;
  /** Show the species ranking for the pin. */
  showSpecies(): void;
  /** The card now describes something else (also fired when unchanged in
   * kind but for another forest). */
  onChange(status: HereStatus): void;
  /** The score on the card changed (null while it is not known). */
  onScore(score: ForestScore | null): void;
}

export interface ForestHere {
  element: HTMLElement;
  /** Look at the pin again: call when the pin moves or the tab is shown. */
  refresh(): void;
  status(): HereStatus;
  /** The score on the card for the pin, once known. */
  score(): ForestScore | null;
  /** Put keyboard focus on the card's "Se svampene her" action. */
  focusAction(): void;
  /** A score worked out elsewhere for a position (a row of the ranking scores
   * its forest's point), to reuse when the pin stands exactly there. */
  remember(
    point: { lon: number; lat: number },
    slugs: ReadonlySet<string>,
    score: ForestScore,
  ): void;
}

const km = new Intl.NumberFormat("da-DK", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** How long to wait for the conditions model to arrive before giving up. */
const MODEL_RETRY_MS = 700;
const MODEL_RETRIES = 12;

function sameStatus(a: HereStatus, b: HereStatus): boolean {
  if (a.kind !== b.kind) return false;
  const fa = a.kind === "forest" ? a.forest : a.kind === "nowhere" ? a.nearest : null;
  const fb = b.kind === "forest" ? b.forest : b.kind === "nowhere" ? b.nearest : null;
  if (!fa || !fb) return fa === fb;
  return (
    fa.name === fb.name &&
    fa.lon === fb.lon &&
    fa.lat === fb.lat &&
    fa.inside === fb.inside &&
    fa.partOf?.name === fb.partOf?.name &&
    Math.abs(fa.distanceKm - fb.distanceKm) < 0.05
  );
}

export function createForestHere(deps: ForestHereDeps): ForestHere {
  const element = h("section", "ff-here");
  element.setAttribute("aria-label", "Skoven ved din nål");
  element.hidden = true;

  let points: readonly ForestPoint[] | null = null;
  let loadingPoints = false;
  let status: HereStatus = { kind: "unknown" };
  let token = 0;
  let retryTimer: number | undefined;
  const cache = new Map<string, ForestScore>();

  // the parts of the forest card that change after it is drawn
  let pill: HTMLElement | null = null;
  let meta: HTMLElement | null = null;

  /** Where the card is one line (a short phone, see style.css) the name and
   * the action share it. A long name comes first: when it would be cut, the
   * card is marked `is-tight` and the action shows its arrow alone (it keeps
   * its accessible name). Looked at again whenever the name's room changes. */
  let roomWatch: ResizeObserver | null = null;
  function watchRoom(nameText: HTMLElement, action: HTMLElement): void {
    roomWatch?.disconnect();
    element.classList.remove("is-tight");
    if (!("ResizeObserver" in window)) return;
    let labelWidth = 0;
    const look = (): void => {
      const label = action.querySelector<HTMLElement>(".ff-here__go-label");
      const tight = element.classList.contains("is-tight");
      if (!tight) {
        labelWidth = label?.offsetWidth || labelWidth;
        if (nameText.scrollWidth > nameText.clientWidth + 1) element.classList.add("is-tight");
      } else if (nameText.scrollWidth + labelWidth + 8 <= nameText.clientWidth) {
        element.classList.remove("is-tight"); // room for the words again
      }
    };
    roomWatch = new ResizeObserver(look);
    roomWatch.observe(nameText);
    roomWatch.observe(element);
  }

  function eyebrow(): HTMLElement {
    const line = h("p", "ff-here__eyebrow");
    line.append(icon("pin"), h("span", undefined, "Ved din nål"));
    return line;
  }

  let shown: ForestScore | null = null;

  function showScore(score: HereScore): void {
    const next = score.state === "ready" ? score.score : null;
    if (next !== shown) {
      shown = next;
      deps.onScore(shown);
    }
    if (!pill || !meta) return;
    const ranking = deps.getRanking();
    const filtered = ranking?.filtered ? ranking.slugs.size : null;
    // the full line, and a short one the folded card on a phone shows instead
    const short = h("span", "ff-here__meta-short", hereMetaShort(score, filtered));
    short.setAttribute("aria-hidden", "true");
    meta.replaceChildren(h("span", "ff-here__meta-long", hereMetaText(score, filtered)), short);
    const value = score.state === "ready" ? score.score.score : null;
    pill.classList.toggle("is-loading", score.state === "loading");
    pill.hidden = score.state !== "loading" && value === null;
    if (value !== null) {
      pill.textContent = String(value);
      pill.dataset.band = scoreBand(value);
      pill.title = value === 0 ? ZERO_SCORE_TITLE : `Forholdstal ${describeScore(value)}`;
      pill.setAttribute("aria-label", `forholdstal ${describeScore(value)}`);
      pill.removeAttribute("aria-hidden");
    } else {
      pill.textContent = "";
      delete pill.dataset.band;
      pill.removeAttribute("title");
      pill.removeAttribute("aria-label");
      pill.setAttribute("aria-hidden", "true");
    }
  }

  function render(): void {
    pill = null;
    meta = null;
    element.dataset.kind = status.kind;
    if (status.kind === "unknown") {
      element.hidden = true;
      element.replaceChildren();
      return;
    }
    element.hidden = false;

    if (status.kind === "pending") {
      const looking = h("p", "ff-here__pending");
      looking.setAttribute("role", "status");
      looking.append(
        h("span", "ff-here__pending-bar"),
        h("span", undefined, "Finder skoven ved nålen …"),
      );
      element.replaceChildren(eyebrow(), looking);
      return;
    }

    if (status.kind === "forest") {
      const text = h("div", "ff-here__text");
      meta = h("p", "ff-here__meta");
      meta.setAttribute("aria-live", "polite");
      const name = h("h3", "ff-here__name");
      name.append(h("span", "ff-here__name-text", status.forest.name));
      // a named part of a larger forest: say which, so "Mølleskov" is placed
      if (status.forest.partOf) {
        name.append(h("span", "ff-here__part", `en del af ${status.forest.partOf.name}`));
      }
      text.append(name, meta);
      pill = h("span", "forest-row__score ff-here__score");
      const main = h("div", "ff-here__main");
      main.append(text, pill);
      const go = h("button", "ff-here__go");
      go.type = "button";
      go.setAttribute("aria-label", "Se svampene her");
      go.append(h("span", "ff-here__go-label", "Se svampene her"), icon("chevron"));
      go.addEventListener("click", () => deps.showSpecies());
      element.replaceChildren(eyebrow(), main, go);
      watchRoom(name.firstElementChild as HTMLElement, go);
      showScore({ state: "loading" });
      return;
    }

    const none = h("p", "ff-here__none", "Ingen navngiven skov lige ved nålen.");
    element.replaceChildren(eyebrow(), none);
    const nearest = status.nearest;
    const pin = deps.getPin();
    if (nearest && pin) {
      const shortcut = h("button", "ff-here__shortcut");
      shortcut.type = "button";
      const direction = compassDa(pin[0], pin[1], nearest.lon, nearest.lat);
      const label = h("span", "ff-here__shortcut-text");
      label.append(
        h("strong", undefined, `Flyt nålen til ${nearest.name}`),
        h(
          "span",
          undefined,
          // under 100 m the forest is right there: a distance of "0,0 km" says less
          nearest.distanceKm < 0.1
            ? `Nærmeste skov · lige mod ${direction}`
            : `Nærmeste skov · ${km.format(nearest.distanceKm)} km mod ${direction}`,
        ),
      );
      shortcut.append(label, icon("chevron"));
      shortcut.addEventListener("click", () => deps.moveTo(nearest));
      element.append(shortcut);
    }
  }

  /** Work out (or look up) today's score at the pin, for the card. The pin's
   * own position, not the forest's point: it is the number that tops the
   * species list "Se svampene her" opens. */
  function fillScore(attempt = 0): void {
    window.clearTimeout(retryTimer);
    const pin = deps.getPin();
    if (status.kind !== "forest" || !pin) {
      showScore({ state: "loading" }); // nothing to show: clears a stale score
      return;
    }
    const forest = { lon: pin[0], lat: pin[1] };
    const mine = token;
    const ranking = deps.getRanking();
    if (!ranking) {
      const failed = deps.rankingFailed?.() ?? null;
      if (failed) {
        showScore({ state: failed === "offline" ? "offline" : "unavailable" });
        return;
      }
      // The model and the species list load after the page: give them a moment.
      if (attempt >= MODEL_RETRIES) {
        showScore({ state: "unavailable" });
        return;
      }
      showScore({ state: "loading" });
      retryTimer = window.setTimeout(() => {
        if (mine === token) fillScore(attempt + 1);
      }, MODEL_RETRY_MS);
      return;
    }
    const date = new Date();
    const key = scoreKey(forest, ranking.slugs, date);
    const known = cache.get(key);
    if (known) {
      showScore({ state: "ready", score: known });
      return;
    }
    showScore({ state: "loading" });
    if (!deps.isShowing()) return; // worked out when the tab is opened
    scoreForest(forest, ranking.manifest, ranking.modelBundle, ranking.slugs, date).then(
      (score) => {
        cache.set(key, score);
        if (mine === token) showScore({ state: "ready", score });
      },
      (err) => {
        console.error("could not score the pin's forest", err);
        if (mine === token) showScore({ state: "failed" });
      },
    );
  }

  function apply(): void {
    const next = resolveHere(points, deps.getPin(), deps.getOutlines());
    const changed = !sameStatus(status, next);
    token++;
    if (changed) {
      status = next;
      render();
      deps.onChange(status);
    }
    fillScore();
  }

  function refresh(): void {
    if (points) {
      apply();
      return;
    }
    if (!deps.getPin()) {
      apply(); // nothing to look up: hides the card
      return;
    }
    if (loadingPoints) return;
    loadingPoints = true;
    deps.loadPoints().then(
      (loaded) => {
        loadingPoints = false;
        points = loaded;
        apply();
      },
      () => {
        // The card simply stays away; a search reports the failed load.
        loadingPoints = false;
      },
    );
  }

  return {
    element,
    refresh,
    status: () => status,
    score: () => shown,
    focusAction() {
      element.querySelector<HTMLElement>(".ff-here__go")?.focus({ preventScroll: true });
    },
    remember(point, slugs, score) {
      cache.set(scoreKey(point, slugs, new Date()), score);
    },
  };
}
