// "Føj til hjemmeskærm": a button that puts the app on the phone's home
// screen. Chromium browsers (Chrome, Edge, Samsung Internet on Android, and
// desktop Chrome) fire `beforeinstallprompt`, and the button then opens the
// browser's own install dialog. Safari on iPhone and iPad has no such API, so
// there the button opens a short guide to the Share menu instead, and other
// browsers get a guide to their menu. The button hides itself when the app
// already runs from the home screen, or once it has been installed.

import { openSheet, brandMark } from "./dialog";
import { h, icon, type IconName } from "./dom";

/** Chromium's install-prompt event (not in the DOM typings). */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((fn) => fn());

// Listen from module load: the event can fire before any button exists.
// (Guarded so the module also loads in the Node test runner.)
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); // no mini-infobar; our button offers it instead
    deferred = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    notify();
  });
}

export type InstallPlatform = "ios" | "android" | "other";

/** iPadOS reports itself as a Mac, so a touch screen gives it away. */
export function detectPlatform(
  ua: string = navigator.userAgent,
  touchPoints: number = navigator.maxTouchPoints ?? 0,
): InstallPlatform {
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Macintosh/.test(ua) && touchPoints > 1) return "ios";
  if (/Android/.test(ua)) return "android";
  return "other";
}

/** Running from the home screen (or as an installed desktop app). */
export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    (window.matchMedia?.("(display-mode: standalone)").matches ?? false) ||
    (window.matchMedia?.("(display-mode: fullscreen)").matches ?? false)
  );
}

/** Whether to offer the button: never once installed; on phones and tablets
 * always (with a guide as fallback); on desktop only when the browser can
 * actually install it. */
export function canOffer(): boolean {
  if (installed || isStandalone()) return false;
  if (deferred) return true;
  return detectPlatform() !== "other";
}

/** Keep `button.hidden` in step with canOffer(), and run the install on click. */
export function bindInstallButton(button: HTMLButtonElement): void {
  const sync = (): void => {
    button.hidden = !canOffer();
  };
  listeners.add(sync);
  window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", sync);
  sync();
  button.addEventListener("click", () => void install());
}

export async function install(): Promise<void> {
  if (deferred) {
    const prompt = deferred;
    deferred = null; // a prompt can only be shown once
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "accepted") installed = true;
    } catch {
      openGuide();
    }
    notify();
    return;
  }
  openGuide();
}

interface Step {
  icon: IconName;
  text: (string | HTMLElement)[];
}

function strong(text: string): HTMLElement {
  return h("strong", undefined, text);
}

function guideSteps(platform: InstallPlatform): { lead: string; steps: Step[]; note?: string } {
  if (platform === "ios") {
    return {
      lead: "Sådan lægger du Svampekortet på hjemmeskærmen i Safari:",
      steps: [
        {
          icon: "share",
          text: [
            "Tryk på ",
            strong("Del"),
            "-knappen (firkanten med en pil op). I nyere iOS ligger den under ",
            strong("•••"),
            " ved adresselinjen.",
          ],
        },
        {
          icon: "addSquare",
          text: ["Rul ned, og vælg ", strong("Føj til hjemmeskærm"), "."],
        },
        { icon: "check", text: ["Tryk på ", strong("Tilføj"), " øverst til højre."] },
      ],
      note:
        "Ser du ikke punktet, så åbn svampekortet.pages.dev i Safari først – " +
        "det virker ikke inde i fx Facebook eller Instagram.",
    };
  }
  if (platform === "android") {
    return {
      lead: "Sådan lægger du Svampekortet på startskærmen:",
      steps: [
        { icon: "menu", text: ["Åbn browserens menu ", strong("⋮"), " øverst til højre."] },
        {
          icon: "addSquare",
          text: ["Vælg ", strong("Installer app"), " eller ", strong("Føj til startskærm"), "."],
        },
        {
          icon: "check",
          text: ["Bekræft med ", strong("Installer"), " eller ", strong("Tilføj"), "."],
        },
      ],
    };
  }
  return {
    lead: "Sådan installerer du Svampekortet:",
    steps: [
      {
        icon: "menu",
        text: [
          "Åbn browserens menu, og vælg ",
          strong("Installer"),
          " eller ",
          strong("Føj til startskærm/Dock"),
          ".",
        ],
      },
    ],
  };
}

let guideOpen = false;

export function openGuide(platform: InstallPlatform = detectPlatform()): void {
  if (guideOpen) return;
  guideOpen = true;
  const sheet = openSheet({
    className: "install-guide",
    title: "Føj til hjemmeskærm",
    mark: brandMark(),
    onClose: () => {
      guideOpen = false;
    },
  });
  const { lead, steps, note } = guideSteps(platform);
  const list = h("ol", "steps install-steps");
  steps.forEach((step, index) => {
    const item = h("li", "steps__item");
    const badge = h("span", "steps__icon");
    badge.append(icon(step.icon));
    const text = h("p", "steps__text");
    text.append(h("span", "steps__number", `${index + 1}.`), " ", ...step.text);
    item.append(badge, text);
    list.append(item);
  });
  sheet.body.append(
    h("p", "install-lead", lead),
    list,
    h(
      "p",
      "install-why",
      "Så åbner Svampekortet som en app i fuld skærm, uden adresselinje, med ét tryk på ikonet.",
    ),
  );
  if (note) sheet.body.append(h("p", "install-note", note));
  sheet.body.focus({ preventScroll: true });
}
