// The return card: a visitor who comes back to a pin remembered from last
// time lands on the map with that pin and the species ranked there (main.ts).
// This card, above the list, says what that ranking means today in one
// sentence (the best species' name opens it), and offers the two things a
// returning visitor most likely wants next: the position they are at now
// (planned at home, now out in the forest), and, from this second visit on,
// the app on the home screen. It is kept to two lines and a row of links, so
// the list's first row still shows under it on a phone. It goes as soon as the
// pin moves, a species is opened, or it is closed.

import { h } from "./dom";
import { bindInstallButton } from "./install";
import { TODAY_LOADING, TODAY_UNAVAILABLE, todayParts, type TodayAtPin } from "./startstate";

export interface ResumeCard {
  /** Show it for the pin just restored. */
  show(): void;
  hide(): void;
  isShown(): boolean;
  /** Today's ranking at the pin: null while it is on its way, "unavailable"
   * when there will be none (no model, or nothing could be scored). */
  setToday(today: TodayAtPin | "unavailable" | null): void;
}

export function initResume(opts: {
  /** Ask for the position (the map's own control does the rest). */
  locate(): void;
  /** Open a species' page (the best one, named in the sentence). */
  openSpecies(slug: string): void;
  /** Where focus goes when the card closes under it. */
  focusAfterClose(): void;
}): ResumeCard {
  const root = document.getElementById("resume") as HTMLElement;
  const summary = document.getElementById("resume-summary") as HTMLElement;
  const close = root.querySelector<HTMLButtonElement>(".rc__close") as HTMLButtonElement;
  const locate = document.getElementById("resume-locate") as HTMLButtonElement;
  bindInstallButton(document.getElementById("resume-install") as HTMLButtonElement);

  const hide = (): void => {
    root.hidden = true;
  };
  close.addEventListener("click", () => {
    hide();
    opts.focusAfterClose();
  });
  locate.addEventListener("click", () => {
    hide();
    opts.locate();
    opts.focusAfterClose();
  });

  return {
    show(): void {
      root.hidden = false;
    },
    hide,
    isShown: () => !root.hidden,
    setToday(today): void {
      if (today === null || today === "unavailable") {
        summary.textContent = today === null ? TODAY_LOADING : TODAY_UNAVAILABLE;
        return;
      }
      const { before, best, after } = todayParts(today);
      if (!best?.slug) {
        summary.textContent = `${before}${best?.name ?? ""}${after}`;
        return;
      }
      const slug = best.slug;
      const open = h("button", "rc__species", best.name);
      open.type = "button";
      open.addEventListener("click", () => opts.openSpecies(slug));
      summary.replaceChildren(before, open, after);
    },
  };
}
