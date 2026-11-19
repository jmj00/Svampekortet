// The name line of the location chip. It has one line; a pin in a named part
// of a larger forest has a long name ("I Børsmose Plantage i Kærgård
// Klitplantage") and a short one ("I Børsmose Plantage"). Where the long one
// would be cut, the short one is shown in full instead, and the rest stays in
// the chip for screen readers and as a tooltip.

export interface ChipName {
  long: string;
  short: string;
}

export interface ChipText {
  /** What is shown. */
  visible: string;
  /** What follows it for screen readers only, or "" (the two together are
   * the long form). */
  hidden: string;
  /** The tooltip: the long form when it is not what is shown, else "". */
  tooltip: string;
  form: "long" | "short";
}

/** Pure: what the chip shows, given whether the long form fits its line. */
export function chipText(name: ChipName, longFits: boolean): ChipText {
  if (longFits || name.short === name.long) {
    return { visible: name.long, hidden: "", tooltip: "", form: "long" };
  }
  return {
    visible: name.short,
    // "I Mølleskov" + " i Rold Skov": read together they are the long form
    hidden: name.long.startsWith(name.short) ? name.long.slice(name.short.length) : "",
    tooltip: name.long,
    form: "short",
  };
}

/**
 * Write `name` into the chip's title element so that it is never cut: the
 * long form if it fits the element as laid out right now, else the short one.
 * Call it again whenever the name or the room changes; an element that is not
 * laid out (hidden) keeps the long form until it is.
 */
export function fitChipName(title: HTMLElement, name: ChipName): void {
  const write = (text: ChipText): void => {
    title.replaceChildren(document.createTextNode(text.visible));
    if (text.hidden) {
      const rest = document.createElement("span");
      rest.className = "sr-only";
      rest.textContent = text.hidden;
      title.append(rest);
    }
    if (text.tooltip) title.title = text.tooltip;
    else title.removeAttribute("title");
    title.dataset.form = text.form;
  };
  // Measure with the long form in place: it is the one that may not fit.
  write(chipText(name, true));
  if (name.short === name.long || title.clientWidth === 0) return;
  if (title.scrollWidth > title.clientWidth + 1) write(chipText(name, false));
}
