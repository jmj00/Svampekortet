import { describe, expect, it } from "vitest";

import { initNavigation, plan, readNavState, type HistoryLike, type Snapshot } from "./nav";

const s = (start: Snapshot["start"], detail: string | null = null): Snapshot => ({ start, detail });
const MAP = s(null);
const HOME = s("home");

describe("plan", () => {
  it("adds an entry for each layer: a step, the start screen over the map, a species page", () => {
    expect(plan([HOME], s("place-here"))).toEqual({
      kind: "ops",
      ops: [{ op: "push", snap: s("place-here") }],
    });
    expect(plan([HOME], s("species"))).toEqual({
      kind: "ops",
      ops: [{ op: "push", snap: s("species") }],
    });
    expect(plan([MAP], HOME)).toEqual({ kind: "ops", ops: [{ op: "push", snap: HOME }] });
    expect(plan([MAP], s(null, "kantarel"))).toEqual({
      kind: "ops",
      ops: [{ op: "push", snap: s(null, "kantarel") }],
    });
  });

  it("takes a layer away by going back through the entry that added it", () => {
    expect(plan([HOME, s("place-here")], HOME)).toEqual({ kind: "back", to: 0 });
    expect(plan([MAP, s(null, "kantarel")], MAP)).toEqual({ kind: "back", to: 0 });
  });

  it("changes the entry in place when nothing of ours lies behind it", () => {
    expect(plan([s("species")], HOME)).toEqual({
      kind: "ops",
      ops: [{ op: "replace", snap: HOME }],
    });
    expect(plan([s(null, "kantarel")], MAP)).toEqual({
      kind: "ops",
      ops: [{ op: "replace", snap: MAP }],
    });
    expect(plan([MAP, s(null, "a")], s(null, "b"))).toEqual({
      kind: "ops",
      ops: [{ op: "replace", snap: s(null, "b") }],
    });
  });

  it("does nothing when nothing changed (the map moving is not a change)", () => {
    expect(plan([MAP], MAP)).toEqual({ kind: "none" });
    expect(plan([HOME, s("species")], s("species"))).toEqual({ kind: "none" });
  });

  it("keeps the start screen the page opened on behind the map", () => {
    expect(plan([HOME], MAP)).toEqual({ kind: "ops", ops: [{ op: "push", snap: MAP }] });
    // from a step: back to the home view first, then the map on top of it
    expect(plan([HOME, s("place-forests")], MAP)).toEqual({ kind: "back", to: 0 });
    // a species chosen in the picker: the list, then its page, so Back goes list -> home
    expect(plan([HOME], s(null, "kantarel"))).toEqual({
      kind: "ops",
      ops: [
        { op: "push", snap: MAP },
        { op: "push", snap: s(null, "kantarel") },
      ],
    });
  });

  it("returns to the map under a start screen opened from it, instead of adding another", () => {
    expect(plan([MAP, HOME], MAP)).toEqual({ kind: "back", to: 0 });
    expect(plan([MAP, HOME, s("species")], s(null, "x"))).toEqual({ kind: "back", to: 0 });
    // and from there on as usual
    expect(plan([MAP], s(null, "x"))).toEqual({
      kind: "ops",
      ops: [{ op: "push", snap: s(null, "x") }],
    });
  });
});

describe("plan with a dialog", () => {
  const D = (snap: Snapshot): Snapshot => ({ ...snap, dialog: true });

  it("gives an open dialog its own entry, and closing it goes back through it", () => {
    expect(plan([MAP], D(MAP))).toEqual({ kind: "ops", ops: [{ op: "push", snap: D(MAP) }] });
    expect(plan([MAP, D(MAP)], MAP)).toEqual({ kind: "back", to: 0 });
    const page = s(null, "x");
    expect(plan([MAP, page], D(page))).toEqual({
      kind: "ops",
      ops: [{ op: "push", snap: D(page) }],
    });
    expect(plan([MAP, page, D(page)], page)).toEqual({ kind: "back", to: 1 });
  });

  it("a Forward or reload into a dialog that is not open goes back off it", () => {
    expect(plan([MAP, D(MAP)], MAP)).toEqual({ kind: "back", to: 0 });
  });
});

describe("readNavState", () => {
  it("reads our own entries and nothing else", () => {
    expect(readNavState({ svk: 1, stack: [HOME, s(null, "a")] })).toEqual({
      svk: 1,
      stack: [HOME, s(null, "a")],
    });
    expect(readNavState(null)).toBeNull();
    expect(readNavState({ svk: 2, stack: [HOME] })).toBeNull();
    expect(readNavState({ svk: 1, stack: [] })).toBeNull();
    expect(readNavState({ svk: 1, stack: [{ start: "elsewhere", detail: null }] })).toBeNull();
    expect(readNavState({ svk: 1, stack: [{ start: null, detail: 3 }] })).toBeNull();
  });
});

/** A browser history in miniature: entries, an index, and popstate on go(). */
function fakeBrowser(initial: unknown[] = [null]) {
  const entries: unknown[] = [...initial];
  let index = entries.length - 1;
  const listeners: ((e: { state: unknown }) => void)[] = [];
  const pending: (() => void)[] = [];
  const history: HistoryLike = {
    get state() {
      return entries[index];
    },
    pushState(state: unknown) {
      entries.splice(index + 1);
      entries.push(state);
      index++;
    },
    replaceState(state: unknown) {
      entries[index] = state;
    },
    go(delta = 0) {
      // like the browser: the popstate comes later, not inside go()
      pending.push(() => {
        index = Math.max(0, Math.min(entries.length - 1, index + delta));
        for (const l of listeners) l({ state: entries[index] });
      });
    },
  } as HistoryLike;
  return {
    history,
    events: {
      addEventListener: (_: string, l: (e: { state: unknown }) => void) => listeners.push(l),
    },
    back: () => history.go(-1),
    forward: () => history.go(1),
    /** Let queued popstates happen (and anything they start). */
    async settle() {
      for (let i = 0; i < 20 && pending.length; i++) {
        pending.shift()?.();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    top: () => (entries[index] as { stack: Snapshot[] }).stack.slice(-1)[0],
    length: () => entries.length,
    index: () => index,
  };
}

/** The app in miniature: a snapshot that changes, recorded as the real one is. */
function fakeApp(browser: ReturnType<typeof fakeBrowser>, start: Snapshot) {
  let shown = start;
  const nav = initNavigation({
    history: browser.history,
    events: browser.events as unknown as Pick<Window, "addEventListener">,
    current: () => shown,
    apply: (snap) => {
      shown = snap;
    },
  });
  return {
    get shown() {
      return shown;
    },
    go(next: Snapshot) {
      shown = next;
      nav.record();
    },
  };
}

describe("initNavigation", () => {
  it("fresh visit: step, Back to home; map, species, Back to list, Back to home", async () => {
    const b = fakeBrowser();
    const app = fakeApp(b, HOME);
    app.go(s("place-here"));
    expect(b.length()).toBe(2);
    b.back();
    await b.settle();
    expect(app.shown).toEqual(HOME);
    // the start screen's own "Forside" button goes back the same way
    app.go(s("species"));
    app.go(HOME);
    await b.settle();
    expect(b.index()).toBe(0);
    // a species chosen in the picker
    app.go(s("species"));
    app.go(MAP); // the start screen closes...
    app.go(s(null, "kantarel")); // ...and the page opens
    await b.settle();
    expect(b.top()).toEqual(s(null, "kantarel"));
    expect(b.index()).toBe(2);
    b.back();
    await b.settle();
    expect(app.shown).toEqual(MAP);
    b.back();
    await b.settle();
    expect(app.shown).toEqual(HOME);
    expect(b.index()).toBe(0); // the next Back leaves the site
    // and Forward comes back the same way
    b.forward();
    await b.settle();
    expect(app.shown).toEqual(MAP);
  });

  it("opened on the map: the home button and Back, a species page and the in-app back button", async () => {
    const b = fakeBrowser();
    const app = fakeApp(b, MAP);
    app.go(HOME);
    b.back();
    await b.settle();
    expect(app.shown).toEqual(MAP);
    expect(b.length()).toBe(2); // forward to the start screen is still there
    app.go(HOME);
    app.go(MAP); // "Tilbage til kortet"
    await b.settle();
    expect(b.index()).toBe(0);
    app.go(s(null, "x"));
    app.go(MAP); // "Alle svampe"
    await b.settle();
    expect(b.index()).toBe(0);
    expect(b.top()).toEqual(MAP);
  });

  it("Back with a dialog open closes the dialog only; its own button leaves no entry", async () => {
    const b = fakeBrowser();
    const app = fakeApp(b, MAP);
    app.go(s(null, "x"));
    app.go({ ...s(null, "x"), dialog: true });
    expect(b.length()).toBe(3);
    b.back();
    await b.settle();
    expect(app.shown).toEqual(s(null, "x")); // the page is still there
    b.back();
    await b.settle();
    expect(app.shown).toEqual(MAP);
    // opened again and closed with its own button: back through its entry
    app.go({ ...MAP, dialog: true });
    app.go(MAP);
    await b.settle();
    expect(b.index()).toBe(0);
  });

  it("a reload shows the entry it reloaded, with the entries behind it", async () => {
    // the session history survives a reload: the entries behind it are the old page's
    const b = fakeBrowser([
      { svk: 1, stack: [HOME] },
      { svk: 1, stack: [HOME, MAP] },
      { svk: 1, stack: [HOME, MAP, s(null, "x")] },
    ]);
    const app = fakeApp(b, HOME); // the page itself starts on the start screen
    await b.settle();
    expect(app.shown).toEqual(s(null, "x"));
    app.go(MAP);
    await b.settle();
    // back went through an entry the old page made: the list
    expect(b.top()).toEqual(MAP);
  });
});
