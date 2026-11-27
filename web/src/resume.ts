// The return card: a visitor who comes back to a pin remembered from last
// time lands on the map with that pin and the species ranked there (main.ts).
// This card, above the list, says what that ranking means today in one
// sentence, and offers the two things a returning visitor most likely wants
// next: the position they are at now (planned at home, now out in the forest),
// and, from this second visit on, the app on the home screen. It goes as soon
// as the pin moves, a species is opened, or it is closed.

import { bindInstallButton } from "./install";
import { todayLong, type TodayAtPin } from "./startstate";

export interface ResumeCard {
  /** Show it for the pin just restored. */
  show(): void;
  hide(): void;
  isShown(): boolean;
  /** Today's ranking at the pin: null while it is on its way, or for good
   * when `unavailable` (no conditions model could be loaded). */
  setToday(today: TodayAtPin | null, unavailable?: boolean): void;
}

export function initResume(opts: {
  /** Ask for the position (the map's own control does the rest). */
  locate(): void;
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
    setToday(today, unavailable = false): void {
      summary.textContent = today
        ? todayLong(today)
        : unavailable
          ? "Dagens forhold kunne ikke beregnes lige nu."
          : "vurderer forholdene …";
    },
  };
}
