// The species detail view: what the panel shows once a species is opened.
// panel.ts owns the view switching, the pin and the model loading; this file
// only builds DOM. Wording and derivations live in detailModel.ts.

import "./detail.css";

import type { SiteDescription, SiteFeature, Typicality } from "./biotope";
import {
  describeSections,
  type Factor,
  factorLevelText,
  limitingAdvice,
  limitingVerb,
  limitingFactor,
  MONTH_NAMES,
  MONTH_SHORT,
  qualitativeLabel,
  redlistFact,
  scoreFactors,
  SEASON_STATUS_TEXT,
  seasonRangeText,
  seasonSummary,
} from "./detailModel";
import { type Conditions, scoreBand } from "./score";
import type { SpeciesDoc, SpeciesImage } from "./types";

const GIFTLINJEN_DISPLAY = "82 12 12 12";
const GIFTLINJEN_HREF = "tel:+4582121212";

const CONFIDENCE_TEXT: Record<Conditions["confidence"], string> = {
  low: "lav",
  medium: "mellem",
  high: "høj",
};
const CONFIDENCE_PIPS: Record<Conditions["confidence"], number> = { low: 1, medium: 2, high: 3 };

const NUMBER = new Intl.NumberFormat("da-DK");

// --- small DOM helpers ---

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

const SVG_NS = "http://www.w3.org/2000/svg";

// 24x24 line icons, drawn with the current text colour.
const ICONS = {
  back: ["M15 5l-7 7 7 7"],
  prev: ["M15 5l-7 7 7 7"],
  next: ["M9 5l7 7-7 7"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  expand: ["M14 4h6v6", "M20 4l-7 7", "M10 20H4v-6", "M4 20l7-7"],
  photo: [
    "M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z",
    "M12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  ],
  pin: [
    "M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z",
    "M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  ],
  habitat: [
    "M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z",
    "M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  ],
  season: [
    "M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z",
    "M4 10h16",
    "M8 3v4",
    "M16 3v4",
  ],
  weather: [
    "M7 16a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17.2 9.1 3.5 3.5 0 0 1 17 16H7z",
    "M9 19l-.7 1.6",
    "M13 19l-.7 1.6",
    "M17 19l-.7 1.6",
  ],
  tree: ["M12 3l5 7h-3l4 6H6l4-6H7l5-7z", "M12 16v5"],
  soil: ["M3 9l9-5 9 5-9 5-9-5z", "M3 14l9 5 9-5"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v5.5", "M12 7.6v.2"],
  shield: [
    "M12 3l7.5 3v5.5c0 4.6-3.1 8-7.5 9.5-4.4-1.5-7.5-4.9-7.5-9.5V6L12 3z",
    "M12 8.5v4",
    "M12 15.4v.2",
  ],
  alert: ["M12 4l9.5 16h-19L12 4z", "M12 10v4.5", "M12 17.4v.2"],
  phone: [
    "M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2C10.8 19.5 4.5 13.2 4.5 5.5a2 2 0 0 1 2-2z",
  ],
  down: ["M12 5v13", "M6 13l6 6 6-6"],
} as const;

function icon(name: keyof typeof ICONS, className = "ico"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Split on `*italic*` markers into text + <em> nodes. */
function emphasise(text: string): (string | HTMLElement)[] {
  return text
    .split(/\*([^*]+)\*/)
    .map((chunk, i) => (i % 2 === 1 ? el("em", undefined, chunk) : chunk))
    .filter((part) => part !== "");
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// --- photos ---

function creditLine(img: SpeciesImage): (string | HTMLElement)[] {
  const parts: (string | HTMLElement)[] = [`Foto: ${img.credit} · ${img.license} · `];
  if (img.link) {
    const a = el("a", undefined, img.source);
    a.href = img.link;
    a.target = "_blank";
    a.rel = "noopener";
    a.title = "Åbn fundet hos kilden (nyt vindue)";
    parts.push(a);
  } else {
    parts.push(img.source);
  }
  return parts;
}

/** Full-screen photo viewer. A native modal <dialog>, so focus is trapped
 * while it is open and returns to the opening photo when it closes. */
function openViewer(doc: SpeciesDoc, start: number, onClose: (index: number) => void): void {
  const images = doc.images;
  let index = start;

  const dialog = el("dialog", "photo-viewer");
  dialog.setAttribute("aria-label", `Fotos af ${doc.danish_name}`);

  const close = el("button", "photo-viewer__btn photo-viewer__close");
  close.type = "button";
  close.setAttribute("aria-label", "Luk fotovisning");
  close.append(icon("close"));

  const counter = el("p", "photo-viewer__count");
  counter.setAttribute("aria-live", "polite");
  const image = el("img", "photo-viewer__img");
  const caption = el("p", "photo-viewer__caption");
  const stage = el("div", "photo-viewer__stage");
  stage.append(image);

  const show = (next: number) => {
    index = (next + images.length) % images.length;
    const img = images[index];
    image.src = img.url;
    image.alt = `${doc.danish_name} – foto: ${img.credit}`;
    counter.textContent = `${index + 1} / ${images.length}`;
    caption.replaceChildren(...creditLine(img));
  };

  const top = el("div", "photo-viewer__top");
  top.append(counter, close);
  dialog.append(top, stage);

  if (images.length > 1) {
    const prev = el("button", "photo-viewer__btn photo-viewer__prev");
    prev.type = "button";
    prev.setAttribute("aria-label", "Forrige foto");
    prev.append(icon("prev"));
    prev.addEventListener("click", () => show(index - 1));
    const next = el("button", "photo-viewer__btn photo-viewer__next");
    next.type = "button";
    next.setAttribute("aria-label", "Næste foto");
    next.append(icon("next"));
    next.addEventListener("click", () => show(index + 1));
    stage.append(prev, next);

    dialog.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") show(index - 1);
      if (event.key === "ArrowRight") show(index + 1);
    });
    let touchX: number | null = null;
    stage.addEventListener("touchstart", (event) => (touchX = event.touches[0].clientX), {
      passive: true,
    });
    stage.addEventListener("touchend", (event) => {
      if (touchX === null) return;
      const dx = event.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) > 40) show(index + (dx < 0 ? 1 : -1));
    });
  }
  dialog.append(caption);

  close.addEventListener("click", () => dialog.close());
  // a click on the dimmed area around the photo closes too
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog || event.target === stage) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose(index);
  });

  show(start);
  document.body.append(dialog);
  dialog.showModal();
}

/** The hero: a swipeable photo strip with the species name over it. Falls back
 * to a plain heading when the species has no photos or none of them load
 * (offline in the forest, typically). */
function hero(doc: SpeciesDoc): { hero: HTMLElement; credit: HTMLElement | null } {
  const root = el("header", "detail-hero");
  const title = el("div", "detail-hero__title");
  title.append(
    el("h2", "detail-name detail-hero__name", doc.danish_name),
    el("p", "detail-sci", doc.scientific_name),
  );

  // long names get a smaller size so they stay inside the photo
  if (doc.danish_name.length > 24) root.dataset.long = "true";

  const images = doc.images;
  if (images.length === 0) {
    root.dataset.photos = "none";
    root.append(title);
    return { hero: root, credit: null };
  }

  const track = el("div", "detail-hero__track");
  const credit = el("p", "detail-credit");
  const count = el("span", "detail-hero__count");
  const countText = el("span");
  count.append(icon("expand"), countText);
  const dots = el("div", "detail-hero__dots");
  dots.setAttribute("aria-hidden", "true");
  let current = 0;
  const slides: HTMLElement[] = [];

  const goTo = (i: number, smooth = true) => {
    const slide = slides[i];
    if (!slide) return;
    track.scrollTo({
      left: slide.offsetLeft,
      behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto",
    });
  };
  const setCurrent = (i: number) => {
    current = i;
    countText.textContent = `${i + 1}/${images.length}`;
    if (root.dataset.photos !== "failed") credit.replaceChildren(...creditLine(images[i]));
    // one tab stop for the whole strip: only the photo in view is tabbable
    slides.forEach((slide, n) =>
      slide.querySelector("button")?.setAttribute("tabindex", n === i ? "0" : "-1"),
    );
    [...dots.children].forEach((dot, n) => dot.classList.toggle("is-on", n === i));
    prev?.toggleAttribute("disabled", i === 0);
    next?.toggleAttribute("disabled", i === images.length - 1);
  };

  let prev: HTMLButtonElement | null = null;
  let next: HTMLButtonElement | null = null;
  if (images.length > 1) {
    prev = el("button", "detail-hero__arrow detail-hero__arrow--prev");
    prev.type = "button";
    prev.setAttribute("aria-label", "Forrige foto");
    prev.append(icon("prev"));
    prev.addEventListener("click", () => goTo(current - 1));
    next = el("button", "detail-hero__arrow detail-hero__arrow--next");
    next.type = "button";
    next.setAttribute("aria-label", "Næste foto");
    next.append(icon("next"));
    next.addEventListener("click", () => goTo(current + 1));
  }

  images.forEach((img, i) => {
    const image = el("img");
    image.src = img.url;
    image.alt = `${doc.danish_name} – foto: ${img.credit}`;
    image.loading = i === 0 ? "eager" : "lazy";
    image.decoding = "async";
    image.draggable = false;

    const open = el("button", "detail-hero__open");
    open.type = "button";
    open.setAttribute("aria-label", `Vis foto ${i + 1} af ${images.length} i stor størrelse`);
    open.append(image);
    open.addEventListener("click", () =>
      openViewer(doc, i, (shown) => {
        goTo(shown, false);
        (slides[shown]?.querySelector("button") ?? open).focus();
      }),
    );

    const figure = el("figure", "detail-hero__slide");
    figure.append(open, el("figcaption", "sr-only", `Foto: ${img.credit}, ${img.license}`));
    // A photo that cannot be fetched leaves a blank slide; the hero's own
    // backdrop keeps the name readable, and a note says why it is empty.
    image.addEventListener("error", () => {
      figure.dataset.failed = "true";
      open.disabled = true;
      if (slides.every((s) => s.dataset.failed === "true")) {
        root.dataset.photos = "failed";
        // no photo on screen, so no credit to show; say why the band is empty
        credit.textContent = "Fotos kan ikke hentes lige nu.";
      }
    });
    slides.push(figure);
    track.append(figure);
    dots.append(el("span", "detail-hero__dot"));
  });

  let frame = 0;
  track.addEventListener(
    "scroll",
    () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        const clamped = Math.min(images.length - 1, Math.max(0, i));
        if (clamped !== current) setCurrent(clamped);
      });
    },
    { passive: true },
  );

  if (images.length > 1) {
    track.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      const target = slides[current + step]?.querySelector("button");
      if (!step || !target) return;
      event.preventDefault();
      goTo(current + step, false);
      target.setAttribute("tabindex", "0");
      target.focus({ preventScroll: true });
    });
  }

  root.append(track, el("div", "detail-hero__scrim"), title, count);
  if (prev && next) root.append(prev, next, dots);
  setCurrent(0);
  return { hero: root, credit };
}

// --- facts ---

const RISK: Record<SpeciesDoc["lookalike_risk"], { title: string; text: string }> = {
  low: {
    title: "Lav forvekslingsrisiko blandt danske arter",
    text: "Det gør ikke bestemmelsen overflødig. Bekræft den altid, før du spiser en svamp.",
  },
  medium: {
    title: "Har forvekslingsarter",
    text: "Vær grundig med bestemmelsen, og sammenlign med forvekslingsarterne.",
  },
  high: {
    title: "Høj forvekslingsrisiko",
    text: "Kun for erfarne. Kan forveksles med giftige arter.",
  },
};

function fact(label: string, value: string, note: string | null): HTMLElement {
  const item = el("div", "detail-fact");
  item.append(el("dt", "detail-fact__label", label), el("dd", "detail-fact__value", value));
  if (note) item.append(el("dd", "detail-fact__note", note));
  return item;
}

/** `lookalikes` is the heading of the lookalike text in the description, if
 * any; the medium- and high-risk banners link straight to it. */
function facts(doc: SpeciesDoc, lookalikes: HTMLElement | null): HTMLElement {
  const wrap = el("section", "detail-facts");
  wrap.setAttribute("aria-label", "Kort om arten");

  const serious = doc.lookalike_risk !== "low";
  const risk = el("div", "detail-risk");
  risk.dataset.risk = doc.lookalike_risk;
  const riskText = el("div", "detail-risk__text");
  riskText.append(
    el("span", "detail-risk__kicker", "Forveksling"),
    el("strong", "detail-risk__title", RISK[doc.lookalike_risk].title),
    el("span", "detail-risk__note", RISK[doc.lookalike_risk].text),
  );
  if (serious && lookalikes) {
    const jump = el("a", "detail-risk__jump");
    jump.href = `#${lookalikes.id}`;
    jump.append(el("span", undefined, "Se forvekslingsarter"), icon("down"));
    jump.addEventListener("click", (event) => {
      event.preventDefault(); // no hash in the URL; move focus and scroll ourselves
      lookalikes.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "start",
      });
      lookalikes.focus({ preventScroll: true });
    });
    riskText.append(jump);
  }
  risk.append(icon(serious ? "alert" : "info"), riskText);

  const grid = el("dl", "detail-fact-grid");
  const redlist = redlistFact(doc.redlist_category);
  grid.append(
    doc.edible
      ? fact("Spiselighed", "Spiselig", "ved sikker bestemmelse")
      : fact("Spiselighed", "Ikke spiselig", null),
    fact("Rødliste", redlist.value, redlist.code),
    doc.observation_count > 0
      ? fact("Fund", NUMBER.format(doc.observation_count), "vist på kortet")
      : fact("Fund", "Ingen", "i datasættet endnu"),
  );
  wrap.append(risk, grid);
  return wrap;
}

// --- safety ---

function safety(): HTMLElement {
  const box = el("section", "detail-safety");
  box.setAttribute("aria-label", "Sikkerhed");
  const head = el("div", "detail-safety__head");
  const text = el("div");
  text.append(
    el("strong", "detail-safety__title", "Ikke et bestemmelsesværktøj"),
    el(
      "p",
      "detail-safety__text",
      "Kortet viser kun, hvor arten før er fundet. Er du i tvivl, så lad svampen stå.",
    ),
  );
  head.append(icon("shield"), text);

  const call = el("a", "detail-safety__call");
  call.href = GIFTLINJEN_HREF;
  call.setAttribute("aria-label", `Ring til Giftlinjen på ${GIFTLINJEN_DISPLAY}`);
  const label = el("span", "detail-safety__call-label");
  label.append(
    el("span", "detail-safety__call-kicker", "Forgiftning? Ring Giftlinjen"),
    el("span", "detail-safety__call-number", GIFTLINJEN_DISPLAY),
  );
  call.append(icon("phone"), label);
  box.append(head, call);
  return box;
}

// --- season ---

function season(doc: SpeciesDoc, today: Date): HTMLElement | null {
  const month = today.getMonth();
  const summary = seasonSummary(doc.season_by_month, month);
  if (!summary) return null;

  const section = el("section", "season");
  const head = el("div", "season__head");
  const status = el("p", "season__status", SEASON_STATUS_TEXT[summary.status]);
  status.dataset.status = summary.status;
  const title = el("h3", "detail-section-title", "Sæson");
  head.append(title, status);

  const lead = el("p", "season__lead");
  lead.append(
    "Flest fund i ",
    el("strong", undefined, MONTH_NAMES[summary.peakMonth]),
    summary.from === summary.to ? "." : ` · typisk ${seasonRangeText(summary)}.`,
  );

  const chart = el("div", "season__chart");
  chart.setAttribute("role", "img");
  chart.setAttribute(
    "aria-label",
    "Fund pr. måned: " +
      doc.season_by_month.map((count, i) => `${MONTH_NAMES[i]} ${count}`).join(", ") +
      ".",
  );
  const max = Math.max(1, ...doc.season_by_month);
  doc.season_by_month.forEach((count, i) => {
    const cell = el("div", "season__cell");
    if (i === month) cell.dataset.now = "true";
    if (summary.inSeason[i]) cell.dataset.inSeason = "true";
    if (i === summary.peakMonth) cell.dataset.peak = "true";
    cell.title = `${MONTH_NAMES[i]}: ${NUMBER.format(count)} fund`;

    const showValue = i === summary.peakMonth || i === month;
    const value = el(
      "span",
      "season__value",
      showValue ? `${Math.round(summary.share[i] * 100)} %` : "",
    );
    const bar = el("span", "season__bar");
    const column = el("span", "season__column");
    column.style.setProperty("--h", `${Math.round((count / max) * 100)}%`);
    column.append(value, bar);
    cell.append(column, el("span", "season__label", MONTH_SHORT[i]));
    chart.append(cell);
  });

  const foot = el(
    "p",
    "season__foot",
    `Andel af ${NUMBER.format(summary.total)} fund pr. måned. Markeret: ${MONTH_NAMES[month]} (nu).`,
  );
  section.append(head, lead, chart, foot);
  return section;
}

// --- description ---

function description(
  doc: SpeciesDoc,
): { section: HTMLElement; lookalikes: HTMLElement | null } | null {
  if (!doc.description) return null;
  const section = el("section", "detail-description");
  section.append(el("h3", "detail-section-title", "Om arten"));
  let lookalikes: HTMLElement | null = null;
  for (const part of describeSections(doc.description, doc.danish_name)) {
    if (part.heading) {
      const heading = el("h4", "detail-description__heading", part.heading);
      if (part.safety) {
        heading.dataset.safety = "true";
        if (!lookalikes) {
          heading.id = "detail-forveksling";
          heading.tabIndex = -1; // focus target for the link in the risk banner
          lookalikes = heading;
        }
      }
      section.append(heading);
    }
    const p = el("p");
    p.append(...emphasise(part.text));
    section.append(p);
  }
  return { section, lookalikes };
}

/** A compact copy of the number on the photo, so the name and the score are
 * both in view the moment the page opens, however short the sheet is. It
 * mirrors whatever card is in `#conditions`. */
function heroScore(conditions: HTMLElement): HTMLButtonElement {
  const pill = el("button", "detail-hero__score");
  pill.type = "button";
  pill.hidden = true;
  const value = el("span", "detail-hero__score-value");
  const label = el("span", "detail-hero__score-label");
  pill.append(value, label);
  pill.addEventListener("click", () => {
    conditions.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
    conditions.focus({ preventScroll: true });
  });

  const sync = () => {
    const card = conditions.querySelector<HTMLElement>(".cond-card[data-band]");
    const number = card?.querySelector(".cond-value")?.textContent;
    const words = card?.querySelector(".cond-label")?.textContent ?? "";
    pill.hidden = !card || !number;
    if (!card || !number) return;
    pill.dataset.band = card.dataset.band;
    value.textContent = number;
    label.textContent = words;
    pill.setAttribute(
      "aria-label",
      `Forhold ved nålen i dag: ${number} af 100, ${words}. Gå til forklaringen`,
    );
  };
  new MutationObserver(sync).observe(conditions, { childList: true });
  return pill;
}

// --- the view ---

export interface DetailView {
  /** Top-level nodes for the panel, in order. */
  nodes: HTMLElement[];
  /** The back button, for moving focus into the view. */
  back: HTMLButtonElement;
}

/** Build the detail view. The conditions host (`#conditions`) starts empty;
 * the panel fills it with `conditionsCard` / `conditionsMessage`. */
export function buildDetail(doc: SpeciesDoc, onBack: () => void, today = new Date()): DetailView {
  const back = el("button", "panel-back detail-back");
  back.type = "button";
  back.append(icon("back"), el("span", undefined, "Alle svampe"));

  // Sticky: floats over the photo at first, becomes a slim title bar once the
  // photo has scrolled away, so "back" never leaves the screen.
  const nav = el("div", "detail-nav");
  const bar = el("div", "detail-nav__bar");
  const navTitle = el("p", "detail-nav__title", doc.danish_name);
  navTitle.setAttribute("aria-hidden", "true");
  bar.append(back, navTitle);
  nav.append(bar);

  const { hero: heroNode, credit } = hero(doc);
  if (heroNode.dataset.photos === "none") nav.dataset.overlay = "false";

  // Scroll events do not bubble, so listen in the capture phase: this works
  // whichever ancestor ends up being the scroller (panel today, sheet later).
  let frame = 0;
  const onScroll = () => {
    if (!nav.isConnected) {
      document.removeEventListener("scroll", onScroll, true);
      return;
    }
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const gap = heroNode.getBoundingClientRect().bottom - nav.getBoundingClientRect().top;
      nav.dataset.stuck = String(gap < bar.offsetHeight + 4);
    });
  };
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  back.addEventListener("click", onBack);

  const conditions = el("section", "conditions");
  conditions.id = "conditions";
  conditions.tabIndex = -1; // focus target for the score on the photo
  conditions.setAttribute("aria-label", "Forhold ved nålen i dag");
  heroNode.append(heroScore(conditions));

  const about = description(doc);
  const body = el("div", "detail-body");
  body.append(heroNode);
  if (credit) body.append(credit);
  body.append(conditions, facts(doc, about?.lookalikes ?? null), safety());
  const seasonNode = season(doc, today);
  if (seasonNode) body.append(seasonNode);
  if (about) body.append(about.section);

  return { nodes: [nav, body], back };
}

// --- conditions ---

export type ConditionsMessage = "no-data" | "no-pin" | "no-model" | "load-failed";

function messageCard(
  iconName: keyof typeof ICONS,
  title: string,
  body: string,
  tone: "invite" | "quiet",
): HTMLElement {
  const card = el("div", "cond-card cond-empty");
  card.dataset.tone = tone;
  const text = el("div", "cond-empty__text");
  text.append(el("strong", "cond-empty__title", title), el("p", "cond-empty__body", body));
  const badge = el("span", "cond-empty__icon");
  badge.append(icon(iconName));
  card.append(badge, text);
  return card;
}

/** What `#conditions` shows when there is no number to show. */
export function conditionsMessage(kind: ConditionsMessage, doc: SpeciesDoc): HTMLElement[] {
  // what the page still has to offer, so the card never reads as a dead end
  const rest = [
    doc.images.length > 0 ? "fotos" : null,
    doc.description ? "artsbeskrivelsen" : null,
    doc.observation_count > 0 ? "tidligere fund på kortet" : null,
  ].filter((part): part is string => part !== null);
  const list =
    rest.length > 1 ? `${rest.slice(0, -1).join(", ")} og ${rest[rest.length - 1]}` : rest[0];
  const offers = rest.length === 0 ? "" : ` Siden viser stadig ${list}.`;

  switch (kind) {
    case "no-pin":
      return [
        messageCard(
          "pin",
          "Sæt en nål på kortet",
          `Så ser du, hvor gode forholdene er for ${doc.danish_name} lige dér i dag – ud fra levested, sæson og vejr.`,
          "invite",
        ),
      ];
    case "no-model":
      return [
        messageCard(
          "info",
          "Intet forholdstal for denne art endnu",
          `Vi kan endnu ikke vurdere, hvor gode forholdene er for ${doc.danish_name}.${offers}`,
          "quiet",
        ),
      ];
    case "no-data":
      return [
        messageCard(
          "info",
          "Ingen forholdsvurdering i dette datasæt",
          `Lige nu kan forholdene ved nålen ikke vurderes for nogen arter.${offers}`,
          "quiet",
        ),
      ];
    case "load-failed":
      return [
        messageCard(
          "info",
          "Forholdstallet kunne ikke hentes",
          `Måske er forbindelsen væk. Sæt nålen igen, når du har dækning.${offers}`,
          "quiet",
        ),
      ];
  }
}

const FACTOR_ICON: Record<Factor["key"], keyof typeof ICONS> = {
  habitat: "habitat",
  season: "season",
  weather: "weather",
  hostTree: "tree",
};

function factorRow(factor: Factor, limiting: boolean): HTMLElement {
  const row = el("li", "cond-factor");
  const badge = el("span", "cond-factor__icon");
  badge.append(icon(FACTOR_ICON[factor.key]));

  const name = el("span", "cond-factor__name", factor.label);
  const measures = el("span", "cond-factor__measures", factor.measures);
  const track = el("span", "cond-factor__track");
  track.setAttribute("aria-hidden", "true");
  const reading = el("span", "cond-factor__reading");

  if (factor.fraction === null) {
    row.dataset.band = "none";
    reading.append(el("span", "cond-factor__level", "Ingen data her"));
    measures.textContent = "Uden for vejrdata – indgår ikke i tallet";
  } else {
    const pct = Math.round(factor.fraction * 100);
    row.dataset.band = scoreBand(pct);
    if (limiting) row.dataset.limiting = "true";
    const fill = el("span", "cond-factor__fill");
    fill.style.setProperty("--w", `${pct}%`);
    track.append(fill);
    reading.append(
      el("span", "cond-factor__level", factorLevelText(factor.fraction)),
      el("span", "cond-factor__pct", `${pct} %`),
    );
  }
  row.append(badge, name, reading, measures, track);
  return row;
}

/** The conditions card: the number, what it is made of, what holds it down,
 * and how far to trust it. */
export function conditionsCard(
  score: Conditions,
  bandwidthKm: number,
  validated: boolean,
  doc: SpeciesDoc,
  today = new Date(),
): HTMLElement[] {
  const card = el("div", "cond-card");
  const band = scoreBand(score.value);
  card.dataset.band = band;

  card.append(el("h3", "cond-kicker", "Forhold ved nålen i dag"));
  if (!validated) {
    card.append(
      el(
        "p",
        "cond-caveat",
        "Forholdstallet er ikke valideret for denne art endnu – brug det med forbehold.",
      ),
    );
  }

  // the number
  const head = el("div", "cond-head");
  const gauge = el("div", "cond-gauge");
  gauge.setAttribute("role", "img");
  gauge.setAttribute("aria-label", `${score.value} af 100`);
  const ring = document.createElementNS(SVG_NS, "svg");
  ring.setAttribute("viewBox", "0 0 72 72");
  ring.setAttribute("aria-hidden", "true");
  for (const cls of ["cond-gauge__track", "cond-gauge__arc"]) {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", "36");
    circle.setAttribute("cy", "36");
    circle.setAttribute("r", "31");
    circle.setAttribute("pathLength", "100");
    circle.setAttribute("class", cls);
    ring.append(circle);
  }
  gauge.style.setProperty("--pct", String(score.value));
  gauge.append(ring, el("span", "cond-value", String(score.value)));
  const meta = el("div", "cond-meta");
  meta.append(
    el("strong", "cond-label", qualitativeLabel(score.value)),
    el("span", "cond-sub", `${score.value} af 100 · relativt forholdstal, ikke en sandsynlighed`),
  );
  head.append(gauge, meta);
  card.append(head);

  // what it is made of
  const factors = scoreFactors(score);
  const limiting = limitingFactor(factors);
  card.append(el("h4", "cond-subhead", "Det bygger tallet på"));
  const list = el("ul", "cond-factors");
  for (const factor of factors) list.append(factorRow(factor, factor === limiting));
  card.append(list);

  const insight = el("div", "cond-insight");
  if (limiting) {
    const season = seasonSummary(doc.season_by_month, today.getMonth());
    insight.append(
      icon("down"),
      (() => {
        const p = el("p");
        p.append(
          el("strong", undefined, `${limiting.label} ${limitingVerb(limiting)}. `),
          limitingAdvice(limiting.key, season),
        );
        return p;
      })(),
    );
  } else {
    insight.dataset.tone = "good";
    insight.append(
      icon("check"),
      el("p", undefined, "Alle faktorer ligger højt i dag – ingen af dem holder tallet nede."),
    );
  }
  card.append(insight);

  // how far to trust it
  const trust = el("div", "cond-trust");
  const pips = el("span", "cond-trust__pips");
  pips.setAttribute("aria-hidden", "true");
  pips.dataset.level = score.confidence;
  for (let i = 0; i < 3; i++) {
    const pip = el("span");
    if (i < CONFIDENCE_PIPS[score.confidence]) pip.className = "is-on";
    pips.append(pip);
  }
  const trustText = el("p", "cond-basis");
  trustText.append(
    el("strong", undefined, `Sikkerhed: ${CONFIDENCE_TEXT[score.confidence]}`),
    ` · bygger på ${NUMBER.format(score.nNearby)} fund inden for ${Math.round(bandwidthKm)} km` +
      (score.weatherAvailable ? "." : ". Vejr indgår ikke (uden for vejrdata)."),
  );
  trust.append(pips, trustText);
  card.append(
    trust,
    el(
      "p",
      "cond-note",
      "Tallet vejer faktorerne sammen, så én lav faktor trækker meget ned. " +
        "Det vurderer forholdene for frugtlegemer – ikke om svampen kan spises.",
    ),
  );
  return [card];
}

const TYPICALITY_TEXT: Record<Typicality, string> = {
  typical: "Typisk for arten",
  seen: "Arten ses også her",
  unusual: "Usædvanligt for arten",
  unknown: "",
};

function siteRow(kind: string, iconName: keyof typeof ICONS, feature: SiteFeature): HTMLElement {
  const row = el("li", "site-row");
  row.dataset.typicality = feature.typicality;
  const badge = el("span", "site-row__icon");
  badge.append(icon(iconName));
  const text = el("span", "site-row__text");
  text.append(el("span", "site-row__kind", kind), el("span", "site-row__label", feature.label));
  row.append(badge, text);
  const note = TYPICALITY_TEXT[feature.typicality];
  if (note) row.append(el("span", "site-row__note", note));
  return row;
}

/** Advisory forest-/soil-type context for the pin (ADR-0016) -- read-only,
 * does not feed the conditions score. Empty when nothing is classified here. */
export function siteCard(description: SiteDescription | null): HTMLElement[] {
  if (!description || (!description.forest && !description.soil)) return [];
  const card = el("div", "site-card");
  card.append(el("h3", "cond-kicker", "Naturtype ved nålen"));
  const rows = el("ul", "site-rows");
  if (description.forest) rows.append(siteRow("Skov", "tree", description.forest));
  if (description.soil) rows.append(siteRow("Jordbund", "soil", description.soil));
  card.append(
    rows,
    el(
      "p",
      "cond-note",
      "Skovtype (CORINE) og jordbundstype (GEUS) – vejledende, indgår ikke i forholdstallet.",
    ),
  );
  return [card];
}
