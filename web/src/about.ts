// The About screen: what the app is, the safety warning with Giftlinjen, how
// to use it, what the 0-100 score is and is not, coverage, privacy, and the
// data sources with their licences (several require attribution, so every
// entry stays). A modal sheet of its own (dialog.ts) rather than a view inside
// the species panel, so it has room to be read and opens from anywhere without
// disturbing the list or the species the user was looking at.

import type { IControl } from "maplibre-gl";
import { brandMark, openSheet } from "./dialog";
import { h, icon, type IconName } from "./dom";
import { scoreScale } from "./scoreinfo";
import type { Manifest } from "./types";

export type AboutSection = "sikkerhed" | "brug" | "tallet" | "daekning" | "privatliv" | "kilder";

const SECTION_LABELS: [AboutSection, string][] = [
  ["sikkerhed", "Sikkerhed"],
  ["brug", "Sådan gør du"],
  ["tallet", "Forholdstallet"],
  ["daekning", "Dækning"],
  ["privatliv", "Privatliv"],
  ["kilder", "Kilder"],
];

const GIFTLINJEN_TEL = "tel:+4582121212";
const GIFTLINJEN_NUMBER = "82 12 12 12";

const STEPS: { icon: IconName; title: string; text: string }[] = [
  {
    icon: "pin",
    title: "Vælg et sted",
    text: "Tryk på kortet, søg en adresse eller brug din placering.",
  },
  {
    icon: "gauge",
    title: "Se dagens forhold",
    text: "Hver art får et forholdstal fra 0 til 100 for netop det sted i dag.",
  },
  {
    icon: "mushroom",
    title: "Åbn en art",
    text: "Se tidligere fund, sæson, kendetegn og forvekslingsrisiko.",
  },
  {
    icon: "tree",
    title: "Find en skov",
    text: "Få skovene i nærheden rangeret efter dagens forhold og vist på kortet.",
  },
];

/** The four-step "how it works" list, with the score scale under step 2. */
function howItWorks(): HTMLOListElement {
  const list = h("ol", "steps");
  STEPS.forEach((step, index) => {
    const item = h("li", "steps__item");
    const badge = h("span", "steps__icon");
    badge.append(icon(step.icon));
    const text = h("div", "steps__text");
    const title = h("strong", "steps__title");
    title.append(h("span", "steps__number", `${index + 1}.`), ` ${step.title}`);
    text.append(title, h("span", "steps__desc", step.text));
    if (index === 1) text.append(scoreScale());
    item.append(badge, text);
    list.append(item);
  });
  return list;
}

/** A MapLibre control (its own group in the map's control stack): a "?" that
 * opens the About screen. */
export function aboutControl(onOpen: () => void): IControl {
  let container: HTMLElement | null = null;
  return {
    onAdd(): HTMLElement {
      container = h("div", "maplibregl-ctrl maplibregl-ctrl-group sk-help-ctrl");
      const button = h("button", "sk-help-ctrl__button");
      button.type = "button";
      button.title = "Hjælp og om Svampekortet";
      button.setAttribute("aria-label", "Hjælp og om Svampekortet");
      button.setAttribute("aria-haspopup", "dialog");
      button.append(icon("help"));
      button.addEventListener("click", onOpen);
      container.append(button);
      return container;
    },
    onRemove(): void {
      container?.remove();
      container = null;
    },
  };
}

const number = new Intl.NumberFormat("da-DK");

let isOpen = false;

function section(id: AboutSection, iconName: IconName, title: string): HTMLElement {
  const node = h("section", "about-section");
  node.id = `om-${id}`;
  const heading = h("h3", "about-section__title");
  heading.append(icon(iconName), h("span", undefined, title));
  node.append(heading);
  return node;
}

function stat(value: string, label: string): HTMLElement {
  const item = h("div", "about-stat");
  item.append(h("dt", "about-stat__label", label), h("dd", "about-stat__value", value));
  return item;
}

/** "11. sep. 2026" from the dataset's ISO timestamp, or null if it is not one. */
function datasetDate(version: string): string | null {
  const date = new Date(version);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("da-DK", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function openAbout(manifest: Manifest, scrollTo?: AboutSection): void {
  if (isOpen) return;
  isOpen = true;
  const sheet = openSheet({
    className: "about",
    title: "Om Svampekortet",
    mark: brandMark(),
    onClose: () => {
      isOpen = false;
    },
  });

  const speciesCount = manifest.species.length;
  const extraCount = manifest.species.filter((s) => s.tier === "extra").length;
  const findCount = manifest.species.reduce((sum, s) => sum + s.observation_count, 0);
  const updated = datasetDate(manifest.version);

  const jump = (id: AboutSection): void => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    sheet.body
      .querySelector(`#om-${id}`)
      ?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  };

  // --- section links ---
  const nav = h("nav", "about-nav");
  nav.setAttribute("aria-label", "Afsnit");
  for (const [id, label] of SECTION_LABELS) {
    const link = h("button", "about-nav__link", label);
    link.type = "button";
    link.addEventListener("click", () => jump(id));
    nav.append(link);
  }
  sheet.toolbar.append(nav);

  // --- intro + key figures ---
  const intro = h(
    "p",
    "about-intro",
    `Svampekortet viser, hvor ${speciesCount} spiselige svampearter er fundet før i Danmark, ` +
      "og hvor gunstige forholdene er lige nu for at lede efter dem.",
  );
  const stats = h("dl", "about-stats");
  stats.append(
    stat(String(speciesCount), "spiselige arter"),
    stat(number.format(findCount), "fund på kortet"),
    stat("Hele landet", "dækning"),
  );
  if (updated) stats.append(stat(updated, "data opdateret"));

  // --- safety ---
  const safety = section("sikkerhed", "warning", "Sikkerhed først");
  safety.classList.add("about-safety");
  const call = h("a", "about-call");
  call.href = GIFTLINJEN_TEL;
  const callText = h("span", "about-call__text");
  callText.append(
    h("span", "about-call__label", "Forgiftning: ring Giftlinjen"),
    h("strong", "about-call__number", GIFTLINJEN_NUMBER),
  );
  call.append(icon("phone"), callText);
  safety.append(
    h("p", "about-safety__lead", "Spis aldrig en vild svamp på baggrund af denne app."),
    h(
      "p",
      undefined,
      "Bekræft altid bestemmelsen med en pålidelig nøgle eller en erfaren svampekyndig – " +
        "flere af arterne her har giftige forvekslingsarter (se forvekslingsrisikoen ved hver art). " +
        "Appen dækker ikke fredninger, adgangsregler eller privat jord.",
    ),
    call,
  );

  // --- how to use it ---
  const usage = section("brug", "map", "Sådan bruger du kortet");
  usage.append(howItWorks());

  // --- the score ---
  const score = section("tallet", "gauge", "Forholdstallet 0–100");
  const terms = h("ul", "about-terms");
  for (const [iconName, lead, rest] of [
    ["pin", "Levested", "Hvor tæt på tidligere fund stedet ligger."],
    ["calendar", "Sæson", "Hvor tæt dagens dato er på artens typiske frugtningstid."],
    [
      "rain",
      "Vejr",
      "Hvor meget den seneste nedbør og temperatur ligner det, arten normalt frugter i.",
    ],
  ] as const) {
    const li = h("li", "about-term");
    li.append(icon(iconName), h("strong", undefined, lead), h("span", undefined, rest));
    terms.append(li);
  }
  const isIsNot = h("div", "about-isnot");
  const is = h("p", "about-isnot__item about-isnot__item--is");
  is.append(
    h("strong", undefined, "Et højt tal betyder"),
    h(
      "span",
      undefined,
      "at stedet og tidspunktet ligner de forhold, arten før er registreret under her.",
    ),
  );
  const isNot = h("p", "about-isnot__item about-isnot__item--not");
  isNot.append(
    h("strong", undefined, "Det betyder ikke"),
    h(
      "span",
      undefined,
      "at der rent faktisk står svampe lige nu. Tallet er ikke en sandsynlighed og ikke et " +
        "løfte – og det siger intet om, hvorvidt en svamp kan spises.",
    ),
  );
  isIsNot.append(is, isNot);
  score.append(
    h(
      "p",
      undefined,
      "Tallet er et relativt forholdstal – ikke en sandsynlighed for at finde svampe " +
        "og ikke et løfte. Farven følger tallet:",
    ),
    scoreScale(),
    h("p", undefined, "Det vejer tre ting sammen:"),
    terms,
    isIsNot,
  );

  // --- coverage ---
  const coverage = section("daekning", "map", "Dækning");
  coverage.append(
    h(
      "p",
      undefined,
      `Hele Danmark · ${speciesCount} spiselige arter · fund fra Danmarks Svampeatlas.`,
    ),
    h(
      "p",
      undefined,
      "Arterne er et udvalg af almindelige spisesvampe. Mangler en art på listen, " +
        "betyder det ikke, at den ikke vokser her.",
    ),
  );
  if (extraCount > 0) {
    coverage.append(
      h(
        "p",
        undefined,
        `For ${extraCount} af arterne (vist under "Flere arter") er forholdstallet endnu ikke ` +
          "valideret, og det bør bruges med forbehold.",
      ),
    );
  }

  // --- privacy ---
  const privacy = section("privatliv", "shield", "Privatliv");
  privacy.append(
    h(
      "p",
      undefined,
      "Ingen login og ingen sporing til markedsføring. Tekniske fejl sendes anonymt til " +
        "fejlovervågning hos Sentry (EU-region) for at forbedre appen; adressesøgninger " +
        "fjernes, inden fejlen sendes.",
    ),
    h(
      "p",
      undefined,
      "Din seneste nål og enkelte visningsvalg gemmes i browseren på din egen enhed, så kortet " +
        "åbner samme sted næste gang. De sendes ingen steder hen, og nålen glemmes igen, når du " +
        "fjerner den.",
    ),
  );

  // --- sources and licences ---
  const sources = section("kilder", "book", "Kilder og licenser");
  const list = h("dl", "about-sources");
  const entries: [string, string][] = [
    ["Fund", manifest.attribution.observations],
    ["Fotos", manifest.attribution.photos],
    ["Vejr", manifest.attribution.weather],
    ["Kort", manifest.attribution.basemap],
    ["Skove", manifest.attribution.forests],
    [
      "Søgning",
      "Adresser: Adressevælgeren. Byer og postnumre: Danske Stednavne og DAGI. Alle fra Klimadatastyrelsen via Datafordeler.",
    ],
    ["Rødliste", manifest.attribution.redlist],
  ];
  for (const [term, value] of entries) {
    const row = h("div", "about-sources__row");
    row.append(h("dt", undefined, term), h("dd", undefined, value));
    list.append(row);
  }
  sources.append(list);

  // The date is in the key figures above; the raw stamp only when it is not one.

  sheet.body.append(intro, stats, safety, usage, score, coverage, privacy, sources);
  if (!updated) sheet.body.append(h("p", "about-version", `Datasæt: ${manifest.version}`));
  sheet.body.focus({ preventScroll: true });
  if (scrollTo) sheet.body.querySelector(`#om-${scrollTo}`)?.scrollIntoView({ block: "start" });
}
