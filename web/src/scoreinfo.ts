// A short, reusable explanation of the 0-100 conditions score: the three
// colour bands as a scale, and a one-paragraph "what it is and is not". Used
// wherever the forest finder and the About dialog show a score.

import { h } from "./dom";
import { scoreBand } from "./score";

type Band = ReturnType<typeof scoreBand>;

/** The band limits, in step with scoreBand() in score.ts. */
const BANDS: { band: Band; from: number; to: number; label: string }[] = [
  { band: "low", from: 0, to: 29, label: "Lave" },
  { band: "ok", from: 30, to: 59, label: "Middel" },
  { band: "good", from: 60, to: 100, label: "Gode" },
];

const BAND_TEXT: Record<Band, string> = {
  low: "lave forhold",
  ok: "middel forhold",
  good: "gode forhold",
};

/** "48 af 100, middel forhold" -- the spoken form of a score pill. */
export function describeScore(value: number): string {
  return `${value} af 100, ${BAND_TEXT[scoreBand(value)]}`;
}

/** The three bands drawn to scale with their ranges underneath. */
export function scoreScale(): HTMLElement {
  const scale = h("div", "score-scale");
  scale.setAttribute("role", "img");
  scale.setAttribute(
    "aria-label",
    "Skala for forholdstallet: 0 til 29 er lave forhold, 30 til 59 middel, 60 til 100 gode.",
  );
  for (const { band, from, to, label } of BANDS) {
    const part = h("div", "score-scale__part");
    part.dataset.band = band;
    part.style.flexGrow = String(to - from + 1);
    part.append(
      h("span", "score-scale__bar"),
      h("span", "score-scale__label", label),
      h("span", "score-scale__range", `${from}–${to}`),
    );
    scale.append(part);
  }
  return scale;
}

/** Scale + two sentences. `onMore`, when given, adds a "read more" link. */
export function scoreExplainer(onMore?: () => void): HTMLElement {
  const box = h("div", "score-explainer");
  const text = h(
    "p",
    "score-explainer__text",
    "Forholdstallet (0–100) vejer levested, sæson og de seneste ugers vejr sammen. " +
      "Det er et relativt tal – ikke en sandsynlighed for at finde svampe.",
  );
  box.append(scoreScale(), text);
  if (onMore) {
    const more = h("button", "text-link", "Læs mere om forholdstallet");
    more.type = "button";
    more.addEventListener("click", onMore);
    box.append(more);
  }
  return box;
}
