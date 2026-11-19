// The phone bottom sheet: #sheet dragged between three snap points.
//
//   peek  only the header shows (grab handle, location, Svampe/Skove switch)
//   half  just under half the screen; the map keeps the rest
//   full  up to just below the address search
//
// The sheet is laid out at its full height and moved with a transform, so a
// drag never reflows the content. Once it settles, the part hanging below the
// screen is taken off the scroll area (--sheet-hidden), so the content can
// always be scrolled to its end by wheel, keyboard or assistive tech, at any
// snap. By touch the usual map-app rule applies: a vertical drag on the content
// moves the sheet until it is fully open, and only then scrolls; pulling down
// from the top of the content collapses it again.
//
// From 720px the same element is a static sidebar (style.css) and everything
// here is switched off.

export type Snap = "peek" | "half" | "full";

export interface Sheet {
  /** True while the phone layout (and so the draggable sheet) is in effect. */
  isActive(): boolean;
  snap(): Snap;
  snapTo(snap: Snap): void;
  /** Raise to `snap` if the sheet is currently lower. No-op on desktop. */
  atLeast(snap: Snap): void;
  /** Lower to `snap` if the sheet is currently higher. No-op on desktop. */
  atMost(snap: Snap): void;
  /** Visible height of the sheet at the half snap, in px (0 on desktop). */
  halfHeight(): number;
}

interface SheetOptions {
  app: HTMLElement;
  sheet: HTMLElement;
  header: HTMLElement;
  handle: HTMLButtonElement;
  body: HTMLElement;
  /** Called when the geometry changes (first layout, resize, breakpoint). */
  onLayout?: () => void;
}

const ORDER: readonly Snap[] = ["peek", "half", "full"];
// The phone layout, as in style.css: narrower than 720px, except short
// landscape screens from 560px wide, which get the sidebar instead.
export const PHONE_LAYOUT =
  "(max-width: 559.98px), (max-width: 719.98px) and (min-height: 520.02px)";
const HALF_FRACTION = 0.53; // of the app height; style.css fallbacks assume the same
// Below this app height a half-open sheet would leave no usable map, so the
// sheet has only two stops: peek and full.
const MIN_HEIGHT_FOR_HALF = 520;
const STALE_MS = 90; // a release this long after the last movement is not a flick
const DRAG_SLOP = 6; // px of movement before a press becomes a drag
const SETTLE_MS = 340; // a little over --dur-sheet in style.css

/** What activating the handle does next, as its accessible name. */
const HANDLE_LABEL: Record<Snap, string> = {
  peek: "Åbn panelet halvt",
  half: "Åbn panelet helt",
  full: "Skjul panelet",
};

export function initSheet(opts: SheetOptions): Sheet {
  const { app, sheet, header, handle, body } = opts;
  const phone = window.matchMedia(PHONE_LAYOUT);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const coarsePointer = window.matchMedia("(pointer: coarse)");

  let active = false;
  let current: Snap = "half";
  /** The snap last asked for. On a two-stop screen "half" is shown as peek or
   * full; this remembers it, so half comes back when there is room again. */
  let wanted: Snap = "half";
  let heights: Record<Snap, number> = { peek: 0, half: 0, full: 0 };
  let visible = 0;
  let settleTimer: number | undefined;

  function measure(): void {
    const full = sheet.offsetHeight;
    // The home-indicator inset, read off a probe (#sheet::after in style.css).
    const safeBottom = parseFloat(getComputedStyle(sheet, "::after").height) || 0;
    const peek = Math.min(full, header.offsetHeight + safeBottom);
    const roomForHalf = app.clientHeight >= MIN_HEIGHT_FOR_HALF;
    const half = roomForHalf
      ? Math.round(Math.min(full, Math.max(app.clientHeight * HALF_FRACTION, peek + 140)))
      : peek;
    heights = { peek, half, full };
  }

  /** True on very short screens, where "half" is the same place as "peek". */
  const twoStops = (): boolean => heights.half <= heights.peek;
  const stops = (): readonly Snap[] => (twoStops() ? ["peek", "full"] : ORDER);

  function place(px: number): void {
    visible = px;
    sheet.style.setProperty("--sheet-y", `${heights.full - px}px`);
    // Map controls ride the sheet's top edge up to the half snap; above that
    // the sheet simply slides over them.
    app.style.setProperty("--map-inset-bottom", `${Math.min(px, heights.half)}px`);
  }

  function setHidden(px: number): void {
    sheet.style.setProperty("--sheet-hidden", `${Math.max(0, px)}px`);
  }

  function settle(): void {
    window.clearTimeout(settleTimer);
    settleTimer = undefined;
    setHidden(heights.full - heights[current]);
    // At peek the content is entirely below the screen: keep it out of the tab
    // order and away from assistive tech until the sheet is raised again.
    body.inert = current === "peek";
  }

  /** `halfMeans`: where a request for "half" goes when there are only two stops. */
  function snapTo(next: Snap, animate = true, halfMeans: "peek" | "full" = "full"): void {
    if (!active) return;
    wanted = next;
    if (next === "half" && twoStops()) next = halfMeans;
    const rising = heights[next] > visible;
    if (next === "peek" && body.contains(document.activeElement)) handle.focus();
    current = next;
    sheet.dataset.snap = next;
    // With two stops, the step up from peek is all the way.
    handle.setAttribute("aria-label", HANDLE_LABEL[next === "peek" && twoStops() ? "half" : next]);
    delete app.dataset.sheetDragging;
    window.clearTimeout(settleTimer);
    if (rising) {
      // Give the content its new, larger scroll area before it slides into view.
      body.inert = false;
      setHidden(heights.full - heights[next]);
    }
    if (!animate) {
      // Really instant: the CSS transitions are off while this attribute is set.
      app.dataset.sheetDragging = "";
      place(heights[next]);
      void sheet.offsetHeight; // commit the position before transitions return
      delete app.dataset.sheetDragging;
    } else {
      place(heights[next]);
    }
    if (!animate || reducedMotion.matches) settle();
    else settleTimer = window.setTimeout(settle, SETTLE_MS);
  }

  function layout(): void {
    const wasActive = active;
    active = phone.matches;
    if (!active) {
      window.clearTimeout(settleTimer);
      sheet.style.removeProperty("--sheet-y");
      sheet.style.removeProperty("--sheet-hidden");
      app.style.removeProperty("--map-inset-bottom");
      delete app.dataset.sheetDragging;
      delete app.dataset.sheetReady;
      body.inert = false;
      if (wasActive) opts.onLayout?.();
      return;
    }
    measure();
    snapTo(wanted, false, "peek"); // a short screen opens on the map, not the list
    opts.onLayout?.();
    // Transitions only switch on after the first placement, so the sheet does
    // not animate in from its CSS fallback position on load.
    if (app.dataset.sheetReady === undefined) {
      requestAnimationFrame(() => {
        if (active) app.dataset.sheetReady = "";
      });
    }
  }

  // ---- dragging -----------------------------------------------------------
  let dragStartY = 0;
  let dragStartVisible = 0;
  let samples: { y: number; t: number }[] = [];

  let dragging = false;
  let layoutPending = false;

  function dragStart(y: number): void {
    dragging = true;
    window.clearTimeout(settleTimer);
    app.dataset.sheetDragging = "";
    body.inert = false;
    setHidden(0); // full-height content while it moves; trimmed again on settle
    dragStartY = y;
    dragStartVisible = visible;
    samples = [{ y, t: performance.now() }];
  }

  function dragMove(y: number): void {
    const next = dragStartVisible + (dragStartY - y);
    place(Math.min(heights.full, Math.max(heights.peek, next)));
    samples.push({ y, t: performance.now() });
    if (samples.length > 5) samples.shift();
  }

  function dragEnd(): void {
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = last.t - first.t;
    // px/ms, upwards positive. A finger that stopped before lifting has no
    // velocity, however fast it moved earlier.
    const stale = performance.now() - last.t > STALE_MS;
    const velocity = dt > 0 && !stale ? (first.y - last.y) / dt : 0;
    dragging = false;
    let target: Snap;
    if (Math.abs(velocity) > 0.45) {
      // A flick: go to the next snap in that direction from where the finger is.
      const above = stops().find((s) => heights[s] > visible + 1) ?? "full";
      const below = [...stops()].reverse().find((s) => heights[s] < visible - 1) ?? "peek";
      target = velocity > 0 ? above : below;
    } else {
      target = stops().reduce((best, s) =>
        Math.abs(heights[s] - visible) < Math.abs(heights[best] - visible) ? s : best,
      );
    }
    snapTo(target);
    if (layoutPending) relayout(); // a resize that arrived mid-drag
  }

  // Header (handle, location, tabs): drag with touch, pen or mouse. A press
  // that never moves stays an ordinary click on whatever was under it.
  let headerPointer: number | null = null;
  let headerDown = 0;
  let headerDragging = false;

  header.addEventListener("pointerdown", (e) => {
    if (!active || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    headerPointer = e.pointerId;
    headerDown = e.clientY;
    headerDragging = false;
  });
  header.addEventListener("pointermove", (e) => {
    if (e.pointerId !== headerPointer) return;
    if (!headerDragging) {
      if (Math.abs(e.clientY - headerDown) < DRAG_SLOP) return;
      headerDragging = true;
      header.setPointerCapture(e.pointerId);
      dragStart(headerDown);
    }
    dragMove(e.clientY);
  });
  const headerRelease = (e: PointerEvent): void => {
    if (e.pointerId !== headerPointer) return;
    headerPointer = null;
    if (!headerDragging) return;
    headerDragging = false;
    dragEnd();
    // The release must not also count as a click on a tab or the handle.
    const swallow = (click: Event): void => {
      click.stopPropagation();
      click.preventDefault();
    };
    header.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => header.removeEventListener("click", swallow, { capture: true }), 0);
  };
  header.addEventListener("pointerup", headerRelease);
  header.addEventListener("pointercancel", headerRelease);

  // Content: touch only. Decide once per gesture whether it moves the sheet or
  // is left to the browser (scrolling the content, swiping the photo strip).
  let touchX = 0;
  let touchY = 0;
  let touchMode: "undecided" | "sheet" | "native" = "native";

  function scrolledToTop(from: EventTarget | null): boolean {
    for (let el = from as HTMLElement | null; el && el !== sheet; el = el.parentElement) {
      if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight) return false;
    }
    return true;
  }

  body.addEventListener(
    "touchstart",
    (e) => {
      if (!active || e.touches.length !== 1) {
        touchMode = "native";
        return;
      }
      touchX = e.touches[0].clientX;
      touchY = e.touches[0].clientY;
      touchMode = "undecided";
    },
    { passive: true },
  );
  body.addEventListener(
    "touchmove",
    (e) => {
      if (touchMode === "native" || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - touchX;
      const dy = e.touches[0].clientY - touchY;
      if (touchMode === "undecided") {
        if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
        const vertical = Math.abs(dy) > Math.abs(dx);
        const takesSheet = vertical && (current !== "full" || (dy > 0 && scrolledToTop(e.target)));
        if (!takesSheet) {
          touchMode = "native";
          return;
        }
        touchMode = "sheet";
        dragStart(touchY);
      }
      if (e.cancelable) e.preventDefault();
      dragMove(e.touches[0].clientY);
    },
    { passive: false },
  );
  const touchRelease = (): void => {
    if (touchMode === "sheet") dragEnd();
    touchMode = "native";
  };
  body.addEventListener("touchend", touchRelease);
  body.addEventListener("touchcancel", touchRelease);

  // ---- keyboard and focus -------------------------------------------------
  const step = (by: number): void => {
    const list = stops();
    const i = list.indexOf(current) + by;
    if (i >= 0 && i < list.length) snapTo(list[i]);
  };
  handle.addEventListener("click", () => {
    const list = stops();
    snapTo(list[(list.indexOf(current) + 1) % list.length]);
  });
  handle.addEventListener("keydown", (e) => {
    if (!active) return;
    if (e.key === "ArrowUp") step(1);
    else if (e.key === "ArrowDown") step(-1);
    else if (e.key === "Home") snapTo("full");
    else if (e.key === "End") snapTo("peek");
    else return;
    e.preventDefault();
  });

  // On a touch device the on-screen keyboard covers about the lower half of
  // the screen, which is exactly where a half-open sheet sits: open fully when
  // a text field in the sheet takes focus, so the field and its results show.
  body.addEventListener("focusin", (e) => {
    if (!active || current === "full" || !coarsePointer.matches) return;
    const t = e.target as HTMLElement;
    const typing =
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLInputElement &&
        !["checkbox", "radio", "range", "button", "submit"].includes(t.type));
    // Without animation: iOS decides where to scroll for the keyboard from
    // where the field is at this instant.
    if (typing) snapTo("full", false);
  });
  // iOS may still pan the page under the keyboard; the app is one fixed screen.
  window.visualViewport?.addEventListener("resize", () => {
    if (active && (window.scrollX !== 0 || window.scrollY !== 0)) window.scrollTo(0, 0);
  });

  // ---- geometry changes ---------------------------------------------------
  let frame = 0;
  const relayout = (): void => {
    if (dragging) {
      layoutPending = true; // never re-measure under a finger; dragEnd picks it up
      return;
    }
    layoutPending = false;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(layout);
  };
  window.addEventListener("resize", relayout);
  phone.addEventListener("change", relayout);
  if ("ResizeObserver" in window) new ResizeObserver(relayout).observe(header);
  layout();

  const rank = (s: Snap): number => ORDER.indexOf(s);
  return {
    isActive: () => active,
    snap: () => current,
    snapTo: (s) => snapTo(s),
    atLeast: (s) => {
      if (active && rank(current) < rank(s)) snapTo(s);
    },
    atMost: (s) => {
      if (active && rank(current) > rank(s)) snapTo(s, true, "peek");
    },
    halfHeight: () => (active ? heights.half : 0),
  };
}
