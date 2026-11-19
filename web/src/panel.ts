import { openAbout } from "./about";
import { classifySite, describeSite } from "./biotope";
import { loadSpecies } from "./data";
import { buildDetail, conditionsCard, conditionsMessage, siteCard } from "./detail";
import { loadSpeciesModel, type ModelBundle } from "./model";
import { rankHere } from "./rank";
import { type Conditions, conditionsScore } from "./score";
import { SpeciesListView } from "./specieslist";
import type { Manifest, SpeciesDoc, SpeciesSummary } from "./types";

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

/**
 * The species picker + detail sheet. Renders into `container`; calls `onSelect`
 * with the loaded document whenever the user opens a species. The list view
 * itself lives in specieslist.ts; this class owns the pin, the ranking and the
 * switching between views.
 */
export class SpeciesPanel {
  private pin: [number, number] | null = null;
  private currentDoc: SpeciesDoc | null = null;
  private conditionsToken = 0;
  private rankToken = 0;
  private rankScores: Map<string, Conditions> | null = null; // for the current pin
  private lastOpenedSlug: string | null = null; // for returning focus to its row
  private readonly list: SpeciesListView;

  constructor(
    private readonly container: HTMLElement,
    private readonly manifest: Manifest,
    private readonly modelBundle: ModelBundle | null,
    private readonly onSelect: (doc: SpeciesDoc) => void,
    /** Whether the open species has a score at the pin right now (the map
     * then draws the ring and colours the forests), with its slug. */
    private readonly onConditions: (slug: string | null) => void = () => {},
    /** Every species matching the current search/chip filter, for showing all
     * of their finds at once -- empty array (not a per-species open) clears it. */
    onFilterObservations: (docs: SpeciesDoc[]) => void = () => {},
  ) {
    this.list = new SpeciesListView({
      manifest,
      hasModel: modelBundle !== null,
      onOpen: (species) => void this.open(species),
      onAbout: () => this.renderAbout(),
      onFilterObservations,
    });
    this.renderList();
  }

  /** Called from the map: a dropped pin (or `null` when it is cleared). */
  setPin(lngLat: [number, number] | null): void {
    this.pin = lngLat;
    this.rankScores = null;
    this.rankToken++; // any ranking still running is for the old spot
    this.list.setRank(lngLat !== null, null);
    if (this.container.dataset.view === "detail") void this.refreshConditions();
    if (this.container.dataset.view === "list") void this.computeRank();
  }

  /** Show the species list with a clean filter, whatever was open before.
   * `seasonOnly` turns "I sæson nu" on. */
  showList(filters: { seasonOnly?: boolean } = {}): void {
    this.list.setFilters({ seasonOnly: filters.seasonOnly ?? false });
    if (this.container.dataset.view !== "list") this.renderList();
  }

  /** Move focus to the list's summary line (after showList). */
  focusList(): void {
    this.list.focusSummary();
  }

  /** Open a species' page by slug. Resolves false if there is no such
   * species or its document could not be fetched. */
  async openSpecies(slug: string): Promise<boolean> {
    const species = this.manifest.species.find((s) => s.slug === slug);
    if (!species) return false;
    return this.open(species);
  }

  /** Core-tier species matching the current search/chip filter — so "forests
   * near me" can rank against the same subset the user is currently browsing
   * (e.g. only kantarel species, if that's what's searched). */
  getRankableSlugs(): Set<string> {
    return this.list.rankableSlugs();
  }

  /** Score every species at the pin so the list can rank them. */
  private async computeRank(): Promise<void> {
    if (!this.pin || !this.modelBundle) return;
    const token = ++this.rankToken;
    const [lon, lat] = this.pin;
    const scores = await rankHere(this.manifest, this.modelBundle, lon, lat, new Date());
    if (token !== this.rankToken) return; // pin moved while loading
    this.rankScores = scores;
    this.list.setRank(true, scores);
  }

  private renderList(): void {
    this.currentDoc = null;
    this.onConditions(null);
    this.container.replaceChildren();
    this.container.dataset.view = "list";

    const about = el("button", "panel-about", "Om Svampekortet");
    about.type = "button";
    about.addEventListener("click", () => this.renderAbout());

    this.list.mount(this.container, about);
    if (this.pin && this.modelBundle && !this.rankScores) void this.computeRank();
  }

  private async open(species: SpeciesSummary): Promise<boolean> {
    this.lastOpenedSlug = species.slug;
    let doc: SpeciesDoc;
    try {
      doc = await loadSpecies(species.file);
    } catch (err) {
      console.error(err);
      return false;
    }
    this.currentDoc = doc;
    this.onSelect(doc);
    this.renderDetail(doc);
    return true;
  }

  private renderDetail(doc: SpeciesDoc): void {
    this.container.replaceChildren();
    this.container.dataset.view = "detail";
    this.container.scrollTop = 0; // the list may have been scrolled; start at the photo

    const view = buildDetail(doc, () => {
      this.renderList();
      this.focusOpenedRow();
    });
    this.container.append(...view.nodes);
    // move keyboard/SR focus into the sheet we just opened
    view.back.focus({ preventScroll: true });
    void this.refreshConditions();
  }

  /** Fill the `#conditions` card from the current pin + species + model. */
  private async refreshConditions(): Promise<void> {
    const host = this.container.querySelector<HTMLElement>("#conditions");
    const doc = this.currentDoc;
    if (!host || !doc) return;

    if (!this.modelBundle) {
      host.replaceChildren(...conditionsMessage("no-data", doc));
      this.onConditions(null);
      return;
    }
    if (!this.pin) {
      host.replaceChildren(...conditionsMessage("no-pin", doc));
      this.onConditions(null);
      return;
    }
    const entry = this.modelBundle.bySlug.get(doc.slug);
    if (!entry) {
      host.replaceChildren(...conditionsMessage("no-model", doc));
      this.onConditions(null);
      return;
    }

    const token = ++this.conditionsToken;
    const [lon, lat] = this.pin;
    let model;
    try {
      model = await loadSpeciesModel(entry.file);
    } catch (err) {
      console.error(err);
      host.replaceChildren(...conditionsMessage("load-failed", doc));
      this.onConditions(null);
      return;
    }
    if (token !== this.conditionsToken || this.currentDoc !== doc) return; // superseded

    const inputs = {
      points: doc.observations.map(([plon, plat]) => [plon, plat] as [number, number]),
      model,
      weatherFeatures: this.modelBundle.manifest.weather_features,
      current: this.modelBundle.current,
      effortGrid: this.modelBundle.effortGrid,
      hostTreeGrid: this.modelBundle.hostTreeGrid,
      lon,
      lat,
      date: new Date(),
    };
    const site = this.modelBundle.biotopeGrid
      ? classifySite(this.modelBundle.biotopeGrid, lon, lat)
      : null;
    host.replaceChildren(
      ...conditionsCard(conditionsScore(inputs), entry.bandwidth_km, doc.score_validated, doc),
      ...siteCard(describeSite(site, model.biotope)),
    );
    this.onConditions(doc.slug);
  }

  /** The About screen is a dialog of its own (about.ts); the panel stays as it
   * is underneath, and the browser returns focus to the opener on close. */
  private renderAbout(): void {
    openAbout(this.manifest);
  }

  /** Return focus to the row of the species we last opened (or the About button). */
  private focusOpenedRow(): void {
    const row = this.lastOpenedSlug
      ? this.container.querySelector<HTMLElement>(
          `.species-row[data-slug="${this.lastOpenedSlug}"]`,
        )
      : null;
    (row ?? this.container.querySelector<HTMLElement>(".panel-about"))?.focus();
  }
}
