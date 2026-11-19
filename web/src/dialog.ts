// A modal sheet built on the native <dialog>: the browser supplies the focus
// trap, Escape to close, the backdrop, and returning focus to whatever opened
// it. Used by the About screen (about.ts). The
// element is appended to #app while open and removed again when it closes.

import { h, icon } from "./dom";

export interface Sheet {
  dialog: HTMLDialogElement;
  /** The scrolling content area. */
  body: HTMLElement;
  /** Fixed strip under the header (e.g. section links); empty by default. */
  toolbar: HTMLElement;
  /** Fixed strip at the bottom (e.g. actions); empty by default. */
  footer: HTMLElement;
  close(): void;
}

let sheetCount = 0;

export function openSheet(options: {
  className: string;
  title: string;
  /** Element placed before the title text (e.g. a logo mark). */
  mark?: Element;
  onClose?: () => void;
}): Sheet {
  const dialog = h("dialog", `sk-dialog ${options.className}`);
  const titleId = `sk-dialog-title-${++sheetCount}`;
  dialog.setAttribute("aria-labelledby", titleId);

  const header = h("header", "sk-dialog__header");
  const title = h("h2", "sk-dialog__title");
  title.id = titleId;
  if (options.mark) title.append(options.mark);
  title.append(h("span", undefined, options.title));
  const closeButton = h("button", "sk-dialog__close");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Luk");
  closeButton.append(icon("close"));
  header.append(title, closeButton);

  const toolbar = h("div", "sk-dialog__toolbar");
  const body = h("div", "sk-dialog__body");
  body.tabIndex = -1; // scrollable region: reachable for keyboard scrolling
  const footer = h("div", "sk-dialog__footer");
  dialog.append(header, toolbar, body, footer);

  const close = (): void => {
    if (dialog.open) dialog.close();
  };
  closeButton.addEventListener("click", close);
  // A click on the backdrop lands on the <dialog> itself, never on a child.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    options.onClose?.();
  });

  (document.getElementById("app") ?? document.body).append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", ""); // very old browsers: shown, just not modal
  return { dialog, body, toolbar, footer, close };
}

/** The app's mushroom mark, for dialog titles. */
export function brandMark(): SVGSVGElement {
  const svg = icon("mushroom", "sk-icon sk-brand");
  return svg;
}
