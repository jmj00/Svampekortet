// The species list view inside #panel: search, filter chips, sort, the score
// explanation and the rows themselves. SpeciesPanel (panel.ts) owns the pin,
// the ranking and the other views; it mounts this and feeds it scores.
//
// The frame and the rows are built once and kept. A keystroke, a chip or new
// scores only reorder and patch what is there, so the search field keeps its
// focus and caret by itself and thumbnails never reload or flicker.
//
// Rows are drawn from the manifest alone (name, season, thumbnail). The
// per-species documents are fetched only for what needs the finds themselves:
// ranking at a pin, an open species, or the map dots of an active filter.

import { loadSpecies } from "./data";
import { isActiveQuery, resolveQuery } from "./keywords";
import { MAX_COLOURED_SPECIES, speciesColor } from "./palette";
import { type Conditions, scoreBand } from "./score";
import { type SeasonInfo, seasonInfo, seasonLabel, seasonRank } from "./season";
import { thumbSources } from "./thumb";
import type { Manifest, SpeciesDoc, SpeciesSummary } from "./types";

export type SortKey = "score" | "season" | "name" | "finds";

export interface SpeciesListOptions {
  manifest: Manifest;
  /** False when the dataset has no conditions model: no scores, no pin hint. */
  hasModel: boolean;
  onOpen: (species: SpeciesSummary) => void;
  onAbout: () => void;
  /** The species with finds among those matching the active filter, for
   * showing their finds on the map together. Empty clears it. */
  onFilterObservations: (docs: SpeciesDoc[]) => void;
}

const GROUP_LABELS: Record<string, string> = {
  kantarel: "Kantareller",
  rorhat: "Rørhatte",
  traesvamp: "Træsvampe",
  pigsvamp: "Pigsvampe",
  blaeksvamp: "Blækhatte",
  stoevbold: "Støvbolde",
  morkel: "Morkler",
  maelkehat: "Mælkehatte",
};
/** Groups with fewer species than this share one "Andre" chip. */
const MIN_SPECIES_FOR_OWN_CHIP = 4;
const OTHER_GROUPS = "__andre";

const SORT_LABELS: Record<SortKey, string> = {
  score: "Bedste forhold",
  season: "Sæson",
  name: "Navn A–Å",
  finds: "Flest fund",
};

const CONFIDENCE_TEXT: Record<Conditions["confidence"], string> = {
  low: "lav",
  medium: "mellem",
  high: "høj",
};

/** One word for a 0-100 score. The 30 and 60 steps are the colour bands
 * (scoreBand in score.ts), so the word and the ring colour never disagree. */
export function scoreWord(value: number): string {
  if (value >= 80) return "Meget gode";
  if (value >= 60) return "Gode";
  if (value >= 30) return "Middel";
  if (value >= 15) return "Lave";
  return "Meget lave";
}

const NUMBER = new Intl.NumberFormat("da-DK");

const ICON_SEARCH =
  '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m13 13 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_PIN =
  '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><path d="M10 18.2s5.6-5.4 5.6-9.7a5.6 5.6 0 0 0-11.2 0c0 4.3 5.6 9.7 5.6 9.7Z" fill="currentColor"/><circle cx="10" cy="8.4" r="2.1" fill="var(--surface)"/></svg>';
const ICON_MUSHROOM =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M3.5 11.5C3.5 7 7.3 3.5 12 3.5s8.500 3.500 8.500 8c0 .8-.6 1.300-1.400 1.300H4.900c-.8 0-1.400-.5-1.400-1.300Z" fill="currentColor"/><path d="M9.8 14.300h4.400l.7 4.300a2 2 0 0 1-2 2.300h-1.800a2 2 0 0 1-2-2.300l.7-4.300Z" fill="currentColor" opacity=".55"/></svg>';
const ICON_CHEVRON =
  '<svg viewBox="0 0 8 14" width="8" height="14" aria-hidden="true" focusable="false"><path d="m1 1 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_INFO =
  '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 9v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="6.2" r="1.1" fill="currentColor"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(className: string, svg: string): HTMLSpanElement {
  const span = el("span", className);
  span.innerHTML = svg; // static markup from the constants above
  span.setAttribute("aria-hidden", "true");
  return span;
}

const SPARK_BAR = 4; // px wide, 1 px apart: 12 months in 59 px
const SPARK_H = 13; // bar area; a tick for "now" hangs 4 px below it

/** Twelve bars, January to December. This month gets a full-height tinted
 * column and a tick under the baseline, so it reads even when its bar is flat. */
function seasonSpark(info: SeasonInfo, month: number): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 59 ${SPARK_H + 4}`);
  svg.setAttribute("width", "59");
  svg.setAttribute("height", String(SPARK_H + 4));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("sp-spark");
  const rect = (x: number, y: number, height: number, className?: string) => {
    const node = document.createElementNS(NS, "rect");
    node.setAttribute("x", String(x));
    node.setAttribute("y", String(y));
    node.setAttribute("width", String(SPARK_BAR));
    node.setAttribute("height", String(height));
    node.setAttribute("rx", "0.8");
    if (className) node.classList.add(className);
    svg.append(node);
  };
  const nowX = month * (SPARK_BAR + 1);
  rect(nowX, 0, SPARK_H, "sp-spark__col");
  info.shares.forEach((share, i) => {
    const height = Math.max(1.5, share * SPARK_H);
    rect(i * (SPARK_BAR + 1), SPARK_H - height, height, i === month ? "is-now" : undefined);
  });
  rect(nowX, SPARK_H + 2, 2, "sp-spark__tick");
  return svg;
}

interface RowInfo {
  thumb: string | null;
  season: SeasonInfo;
}

interface RowRefs {
  li: HTMLLIElement;
  button: HTMLButtonElement;
  thumb: HTMLElement;
  meta: HTMLElement;
  rating: HTMLElement | null;
  hasImage: boolean;
}

export class SpeciesListView {
  private query = "";
  private group: string | null = null;
  private seasonOnly = false;
  private sort: SortKey | null = null; // null: follow the pin (score) or the season
  private pinned = false;
  private scores: Map<string, Conditions> | null = null;
  private explainOpen = false;
  private statusKey = "";
  private filterObsToken = 0;
  private docsRequested = false;
  private docsSettled: boolean;
  private readonly month = new Date().getMonth();

  private readonly info = new Map<string, RowInfo>();
  private readonly rows = new Map<string, RowRefs>();

  private readonly root = el("div", "sp-list");
  private readonly search = el("input", "panel-search");
  private readonly chips = el("div", "sp-chips");
  private readonly count = el("p", "sp-count");
  private readonly reset = el("button", "sp-reset", "Nulstil");
  private readonly sortSelect = el("select", "sp-sort__select");
  private readonly explainToggle = el("button", "sp-explain-toggle");
  private readonly progress = el("span", "sp-progress");
  private readonly status = el("div", "sp-status");
  private readonly legend = el("ul", "panel-legend");
  private readonly results = el("div", "sp-results");

  constructor(private readonly opts: SpeciesListOptions) {
    // Season and thumbnail come with the manifest. A payload published before
    // those fields existed falls back to the species documents (requestDocs).
    for (const species of opts.manifest.species) {
      if (Array.isArray(species.season_by_month)) {
        this.info.set(species.slug, {
          thumb: species.thumbnail ?? null,
          season: seasonInfo(species.season_by_month, this.month),
        });
      }
    }
    this.docsSettled = this.info.size === opts.manifest.species.length;
    this.buildFrame();
  }

  /** Put the list into `container` (already emptied by the caller), followed
   * by `footer`. Safe to call again after another view replaced it. */
  mount(container: HTMLElement, footer: HTMLElement): void {
    container.append(this.root, footer);
    this.refresh();
    this.updateFilterObservations();
    this.requestDocs();
  }

  /** New pin state from the panel: `scores` is null while they are computed. */
  setRank(pinned: boolean, scores: Map<string, Conditions> | null): void {
    this.pinned = pinned;
    this.scores = scores;
    if (this.root.isConnected) this.refresh();
  }

  /** Core-tier species in the current filter, for ranking forests against the
   * same subset the user is browsing. */
  rankableSlugs(): Set<string> {
    return new Set(
      this.matched()
        .filter((s) => s.tier === "core")
        .map((s) => s.slug),
    );
  }

  /** Start over with a clean filter (the start screen's ways in): no search
   * text, no group, and "I sæson nu" on or off. */
  setFilters(filters: { seasonOnly: boolean }): void {
    this.query = "";
    this.search.value = "";
    this.group = null;
    this.seasonOnly = filters.seasonOnly;
    if (this.root.isConnected) this.onFilterChanged();
  }

  /** Put focus on the line that says what the list shows ("12 af 50 arter"),
   * so a screen reader starts there and Tab continues into the rows. */
  focusSummary(): void {
    this.count.focus({ preventScroll: true });
  }

  // --- state -------------------------------------------------------------

  private get showScores(): boolean {
    return this.pinned && this.opts.hasModel;
  }

  private get filterActive(): boolean {
    return isActiveQuery(this.query) || this.group !== null || this.seasonOnly;
  }

  private effectiveSort(): SortKey {
    if (this.sort === "score" && !this.showScores) return "season";
    return this.sort ?? (this.showScores ? "score" : "season");
  }

  private inGroup(species: SpeciesSummary): boolean {
    if (this.group === null) return true;
    if (this.group === OTHER_GROUPS) return !this.ownChipGroups().has(species.group);
    return species.group === this.group;
  }

  private groupCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const s of this.opts.manifest.species) {
      counts.set(s.group, (counts.get(s.group) ?? 0) + 1);
    }
    return counts;
  }

  private ownChipGroups(): Set<string> {
    return new Set(
      [...this.groupCounts()].filter(([, n]) => n >= MIN_SPECIES_FOR_OWN_CHIP).map(([g]) => g),
    );
  }

  private isInSeason(slug: string): boolean {
    const state = this.info.get(slug)?.season.state;
    return state === "in" || state === "peak";
  }

  private matched(): SpeciesSummary[] {
    return resolveQuery(this.query, this.opts.manifest).filter(
      (s) => this.inGroup(s) && (!this.seasonOnly || this.isInSeason(s.slug)),
    );
  }

  private sorted(species: SpeciesSummary[], sort: SortKey): SpeciesSummary[] {
    // Array.sort is stable: ties keep the order they came in.
    const by = (list: SpeciesSummary[], key: (s: SpeciesSummary) => number) =>
      [...list].sort((a, b) => key(b) - key(a));
    const bySeason = () => by(species, (s) => seasonRank(this.info.get(s.slug)?.season));
    switch (sort) {
      case "score":
        // Equal or missing scores fall back to the season order; so does the
        // whole list while the scores are still being computed.
        if (!this.scores) return bySeason();
        return by(bySeason(), (s) => this.scores?.get(s.slug)?.value ?? -1);
      case "season":
        return bySeason();
      case "finds":
        return by(species, (s) => s.observation_count);
      case "name":
        return [...species].sort((a, b) => a.danish_name.localeCompare(b.danish_name, "da"));
    }
  }

  // --- data --------------------------------------------------------------

  /** Only for a payload whose manifest lacks season/thumbnail: read them off
   * the species documents instead, once, and patch each row as it lands. */
  private requestDocs(): void {
    if (this.docsRequested || this.docsSettled) return;
    this.docsRequested = true;
    const missing = this.opts.manifest.species.filter((s) => !this.info.has(s.slug));
    const pending = missing.map((species) =>
      loadSpecies(species.file)
        .then((doc) => {
          this.info.set(species.slug, {
            thumb: doc.images[0]?.url ?? null,
            season: seasonInfo(doc.season_by_month, this.month),
          });
        })
        .catch(() => {
          // Offline or a failed fetch: the row simply stays without photo/season.
          this.info.set(species.slug, { thumb: null, season: seasonInfo([], this.month) });
        })
        .then(() => {
          const refs = this.rows.get(species.slug);
          if (refs) this.patchRow(refs, species);
        }),
    );
    void Promise.all(pending).then(() => {
      this.docsSettled = true;
      if (!this.root.isConnected) return;
      // One reorder at most, and only if the order depends on the season.
      const sort = this.effectiveSort();
      if (sort === "season" || sort === "score" || this.seasonOnly) this.refresh();
      if (this.seasonOnly) this.updateFilterObservations();
    });
  }

  /** Load the filtered species' finds and hand them to the map, or clear it
   * when no filter is active (every species at once would be noise). Species
   * without finds are left out before colours are given, so the colour key and
   * the map dots read off one list in one order: every swatch has dots, and no
   * colour is spent on a species that has none. */
  private updateFilterObservations(): void {
    const token = ++this.filterObsToken;
    if (!this.filterActive) {
      this.opts.onFilterObservations([]);
      this.legend.replaceChildren();
      return;
    }
    const matched = this.matched().filter((s) => s.observation_count > 0);
    void Promise.all(matched.map((s) => loadSpecies(s.file).catch(() => null))).then((docs) => {
      if (token !== this.filterObsToken) return; // filter changed again while loading
      const found = docs.filter((d): d is SpeciesDoc => d !== null && d.observations.length > 0);
      this.opts.onFilterObservations(found);
      this.legend.replaceChildren();
      if (found.length === 0) return;
      if (found.length > MAX_COLOURED_SPECIES) {
        this.legend.append(
          el("li", "panel-legend__note", `Fund for ${found.length} arter vises på kortet.`),
        );
        return;
      }
      found.forEach((doc, i) => {
        const item = el("li");
        const swatch = el("span", "legend-swatch");
        swatch.style.backgroundColor = speciesColor(i);
        item.append(swatch, document.createTextNode(doc.danish_name));
        this.legend.append(item);
      });
    });
  }

  // --- frame -------------------------------------------------------------

  private buildFrame(): void {
    const searchWrap = el("div", "sp-search");
    this.search.type = "search";
    // The long example is cut off on a narrow phone; give it a shorter one.
    const narrow = window.matchMedia("(max-width: 379.98px)");
    const setPlaceholder = () => {
      this.search.placeholder = narrow.matches
        ? "Søg art, fx kantarel"
        : "Søg art, fx kantarel eller Karl Johan";
    };
    setPlaceholder();
    narrow.addEventListener("change", setPlaceholder);
    this.search.setAttribute("aria-label", "Søg i svampelisten");
    this.search.autocomplete = "off";
    this.search.spellcheck = false;
    this.search.enterKeyHint = "search";
    this.search.addEventListener("input", () => {
      this.query = this.search.value;
      this.onFilterChanged();
    });
    searchWrap.append(icon("sp-search__icon", ICON_SEARCH), this.search);

    this.chips.setAttribute("role", "group");
    this.chips.setAttribute("aria-label", "Filtrér listen");
    this.chips.append(this.chip("I sæson nu", "season", null, "sp-chip sp-chip--season"));
    const own = this.ownChipGroups();
    let others = 0;
    for (const [group, n] of this.groupCounts()) {
      if (own.has(group)) this.chips.append(this.chip(GROUP_LABELS[group] ?? group, group, n));
      else others += n;
    }
    if (others > 0) this.chips.append(this.chip("Andre", OTHER_GROUPS, others));
    // A mouse wheel scrolls these one-line rows sideways; touch and trackpads already do.
    for (const strip of [this.chips, this.legend] as HTMLElement[]) {
      strip.addEventListener(
        "wheel",
        (e) => {
          if (e.deltaX !== 0 || strip.scrollWidth <= strip.clientWidth) return;
          strip.scrollLeft += e.deltaY;
          e.preventDefault();
        },
        { passive: false },
      );
    }

    const toolbar = el("div", "sp-toolbar");
    this.count.setAttribute("aria-live", "polite");
    this.count.tabIndex = -1; // focus lands here after "Nulstil" on touch screens
    this.reset.type = "button";
    this.reset.addEventListener("click", () => this.resetFilters());
    const countWrap = el("div", "sp-toolbar__count");
    countWrap.append(this.count, this.reset);

    const sort = el("label", "sp-sort");
    sort.append(el("span", "sr-only", "Sortér efter"));
    for (const key of Object.keys(SORT_LABELS) as SortKey[]) {
      const option = el("option", undefined, SORT_LABELS[key]);
      option.value = key;
      this.sortSelect.append(option);
    }
    this.sortSelect.addEventListener("change", () => {
      this.sort = this.sortSelect.value as SortKey;
      this.refresh();
    });
    sort.append(this.sortSelect);

    this.explainToggle.type = "button";
    this.explainToggle.innerHTML = ICON_INFO; // static markup
    this.explainToggle.setAttribute("aria-label", "Hvad betyder tallet?");
    this.explainToggle.title = "Hvad betyder tallet?";
    this.explainToggle.addEventListener("click", () => {
      this.explainOpen = !this.explainOpen;
      this.renderStatus();
    });
    const tools = el("div", "sp-toolbar__tools");
    tools.append(sort, this.explainToggle);
    toolbar.append(countWrap, tools, this.progress);

    this.legend.setAttribute("aria-label", "Farver for fund på kortet");
    const more = el("div", "sp-more");
    more.setAttribute("aria-hidden", "true");
    this.root.append(
      el("h2", "sr-only", "Svampe"),
      searchWrap,
      this.chips,
      toolbar,
      this.legend,
      this.status,
      this.results,
      more,
    );
  }

  private chip(
    label: string,
    value: string,
    n: number | null,
    className = "sp-chip",
  ): HTMLButtonElement {
    const button = el("button", className);
    button.type = "button";
    button.dataset.filter = value;
    button.setAttribute("aria-pressed", "false");
    if (value === "season") button.append(el("span", "sp-chip__dot"));
    button.append(el("span", undefined, label));
    if (n !== null) button.append(el("span", "sp-chip__n", String(n)));
    button.addEventListener("click", () => {
      if (value === "season") this.seasonOnly = !this.seasonOnly;
      else this.group = this.group === value ? null : value;
      this.onFilterChanged();
      button.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return button;
  }

  private onFilterChanged(): void {
    this.refresh();
    this.updateFilterObservations();
  }

  private resetFilters(): void {
    this.query = "";
    this.search.value = "";
    this.group = null;
    this.seasonOnly = false;
    this.onFilterChanged();
    // The pressed button is gone now, so focus needs a new home. With a mouse
    // or keyboard that is the search field; on a touch screen that would pop
    // the keyboard over the list just asked for, so use the count line.
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    (fine ? this.search : this.count).focus({ preventScroll: !fine });
  }

  // --- rendering ---------------------------------------------------------

  private refresh(): void {
    const sort = this.effectiveSort();
    const matched = this.sorted(this.matched(), sort);
    // `extra`-tier species are shown apart, without a score (ADR-0012).
    const core = matched.filter((s) => s.tier !== "extra");
    const extra = matched.filter((s) => s.tier === "extra");

    for (const chip of this.chips.querySelectorAll<HTMLButtonElement>("button")) {
      const value = chip.dataset.filter;
      const pressed = value === "season" ? this.seasonOnly : value === this.group;
      chip.setAttribute("aria-pressed", String(pressed));
    }

    const total = this.opts.manifest.species.length;
    const noun = (n: number) => (n === 1 ? "art" : "arter");
    const ranking = this.showScores && !this.scores;
    this.count.textContent = ranking
      ? "Beregner forholdene…"
      : this.filterActive
        ? `${matched.length} af ${total} ${noun(total)}`
        : `${total} ${noun(total)}`;
    this.reset.hidden = !this.filterActive;
    this.progress.hidden = !ranking;

    const scoreOption = this.sortSelect.querySelector<HTMLOptionElement>('option[value="score"]');
    if (scoreOption) scoreOption.disabled = !this.showScores;
    this.sortSelect.value = sort;

    this.renderStatus();

    const parts: HTMLElement[] = [];
    if (core.length > 0) parts.push(this.listOf(core, sort, true));
    if (extra.length > 0) {
      const head = el("div", "panel-group");
      const title = el("h3", "panel-group__title", "Flere arter");
      title.append(el("span", "panel-group__n", String(extra.length)));
      head.append(
        title,
        el(
          "p",
          "panel-group__note",
          "Uden forholdstal – modellen er endnu ikke valideret for disse arter.",
        ),
      );
      parts.push(head, this.listOf(extra, sort, false));
    }
    if (matched.length === 0) parts.push(this.emptyState());
    this.results.replaceChildren(...parts);
  }

  private listOf(species: SpeciesSummary[], sort: SortKey, scored: boolean): HTMLUListElement {
    const list = el("ul", "panel-list");
    // Ranked by score: the species that could not be scored here come last,
    // under a divider, so the scored ones read as one block.
    const split = scored && sort === "score" && this.scores !== null;
    let divided = false;
    for (const s of species) {
      const unscored = split && !this.scores?.has(s.slug);
      if (unscored && !divided) {
        divided = true;
        list.append(el("li", "panel-list__divider", "Ingen vurdering ved denne nål"));
      }
      const refs = this.row(s);
      this.patchRow(refs, s, sort);
      list.append(refs.li);
    }
    return list;
  }

  private emptyState(): HTMLElement {
    const box = el("div", "panel-empty");
    box.append(icon("panel-empty__icon", ICON_MUSHROOM));
    if (this.seasonOnly && !this.docsSettled) {
      box.append(el("p", "panel-empty__title", "Henter sæsondata…"));
      return box;
    }
    const query = isActiveQuery(this.query) ? this.query.trim() : "";
    box.append(
      el(
        "p",
        "panel-empty__title",
        query ? `Ingen arter matcher „${query}“` : "Ingen arter matcher filtrene",
      ),
      el(
        "p",
        "panel-empty__hint",
        this.seasonOnly
          ? "Få arter er i sæson lige nu. Slå „I sæson nu“ fra for at se resten."
          : "Prøv fx kantarel, rørhat eller Karl Johan.",
      ),
    );
    const button = el("button", "panel-empty__reset", "Vis alle arter");
    button.type = "button";
    button.addEventListener("click", () => this.resetFilters());
    box.append(button);
    return box;
  }

  /** Below the toolbar: how to get scores (no pin yet), or what they mean
   * (opened from the info button once there are scores). */
  private renderStatus(): void {
    const ranked = this.showScores && this.scores !== null;
    const state =
      this.opts.hasModel && !this.pinned ? "hint" : ranked && this.explainOpen ? "explain" : "none";

    this.explainToggle.hidden = !ranked;
    this.explainToggle.setAttribute("aria-expanded", String(ranked && this.explainOpen));

    if (state === this.statusKey) return;
    this.statusKey = state;
    this.status.dataset.state = state;
    this.status.replaceChildren();
    this.status.hidden = state === "none";

    if (state === "hint") {
      const text = el("p", "sp-status__text");
      text.append(
        el("strong", undefined, "Sæt en nål på kortet"),
        document.createTextNode(" – så ser du, hvor gode forholdene er for hver art dér i dag."),
      );
      this.status.append(icon("sp-status__icon", ICON_PIN), text);
      return;
    }
    if (state === "explain") {
      const scale = el("div", "sp-scale");
      scale.append(
        el("span", "sp-scale__end", "0 · lave"),
        el("span", "sp-scale__bar"),
        el("span", "sp-scale__end", "gode · 100"),
      );
      const more = el("button", "sp-explain__more", "Læs mere om forholdstallet");
      more.type = "button";
      more.addEventListener("click", () => this.opts.onAbout());
      this.status.append(
        el("p", "sp-explain__title", "Forhold ved nålen i dag"),
        scale,
        el(
          "p",
          undefined,
          "Tallet går fra 0 til 100 og viser, hvor godt stedet, årstiden og de seneste " +
            "ugers vejr passer til arten – målt mod tidligere fund. Højere er bedre.",
        ),
        el(
          "p",
          undefined,
          "Det er ikke en sandsynlighed for at finde svampe, og det siger intet om, " +
            "hvorvidt en svamp kan spises.",
        ),
        more,
      );
    }
  }

  private row(species: SpeciesSummary): RowRefs {
    const existing = this.rows.get(species.slug);
    if (existing) return existing;

    const li = el("li");
    const button = el("button", "species-row species-row--rich");
    button.type = "button";
    button.dataset.slug = species.slug; // return-focus target after "back"

    const thumb = icon("species-row__thumb", ICON_MUSHROOM);
    const text = el("span", "species-row__text");
    const meta = el("span", "species-row__meta");
    text.append(
      el("span", "species-row__name", species.danish_name),
      el("span", "species-row__sci", species.scientific_name),
      meta,
    );
    button.append(thumb, text);

    let rating: HTMLElement | null = null;
    if (species.tier !== "extra" && this.opts.hasModel) {
      rating = el("span", "species-row__rating");
      button.append(rating);
    }
    button.append(icon("species-row__chevron", ICON_CHEVRON));
    button.addEventListener("click", () => this.opts.onOpen(species));
    li.append(button);

    const refs: RowRefs = { li, button, thumb, meta, rating, hasImage: false };
    this.rows.set(species.slug, refs);
    return refs;
  }

  /** Bring a row's photo, season line and score up to date. */
  private patchRow(refs: RowRefs, species: SpeciesSummary, sort = this.effectiveSort()): void {
    const info = this.info.get(species.slug);

    if (info?.thumb && !refs.hasImage) {
      refs.hasImage = true;
      const img = el("img");
      const { src, srcset } = thumbSources(info.thumb);
      img.alt = ""; // decorative: the name is right beside it
      img.loading = "lazy";
      img.decoding = "async";
      img.width = 48;
      img.height = 48;
      if (srcset) {
        img.srcset = srcset;
        img.sizes = "48px";
      }
      img.addEventListener("load", () => img.classList.add("is-loaded"));
      img.addEventListener("error", () => img.remove()); // offline: keep the placeholder
      img.src = src;
      refs.thumb.append(img);
    }

    refs.meta.replaceChildren();
    refs.meta.removeAttribute("data-season");
    if (sort === "finds") {
      refs.meta.textContent =
        species.observation_count > 0
          ? `${NUMBER.format(species.observation_count)} fund på kortet`
          : "Ingen fund på kortet endnu";
    } else if (!info) {
      refs.meta.append(el("span", "sp-skeleton"));
    } else if (info.season.state === "unknown") {
      refs.meta.textContent =
        species.observation_count > 0
          ? "For få fund til at vise sæson"
          : "Ingen fund på kortet endnu";
    } else {
      refs.meta.dataset.season = info.season.state;
      refs.meta.append(
        seasonSpark(info.season, this.month),
        el("span", "species-row__season", seasonLabel(info.season)),
      );
    }

    const rating = refs.rating;
    if (!rating) return;
    rating.hidden = !this.showScores;
    rating.removeAttribute("title");
    rating.removeAttribute("data-empty");
    if (!this.showScores) return;
    rating.replaceChildren();
    if (!this.scores) {
      const ring = el("span", "species-row__score");
      ring.dataset.state = "loading";
      rating.append(ring);
      return;
    }
    const score = this.scores.get(species.slug) ?? null;
    if (!score) {
      // No empty ring for a species that could not be scored here. Ranked by
      // score, these rows sit under a divider that says so once; in any other
      // order each row says it for itself.
      rating.dataset.empty = "true";
      if (sort === "score") rating.hidden = true;
      else rating.append(el("span", "species-row__label", "Ikke vurderet"));
      return;
    }
    const word = scoreWord(score.value);
    const ring = el("span", "species-row__score", String(score.value));
    ring.dataset.band = scoreBand(score.value);
    ring.style.setProperty("--pct", String(score.value));
    rating.title = `${word} forhold · sikkerhed: ${CONFIDENCE_TEXT[score.confidence]}`;
    rating.append(ring, el("span", "sr-only", " af 100, "), el("span", "species-row__label", word));
  }
}
