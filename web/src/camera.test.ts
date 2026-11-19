import { describe, expect, it } from "vitest";

import { beyond, insetsFrom } from "./camera";

const pad = (top: number, right: number, bottom: number, left: number) => ({
  top,
  right,
  bottom,
  left,
});

describe("insetsFrom", () => {
  it("follows the sheet's live edge when the shell publishes it in pixels", () => {
    // sheet folded to its peek: far less is covered than the half-height padding
    expect(insetsFrom(pad(68, 0, 447, 0), "112px")).toEqual(pad(68, 0, 112, 0));
    expect(insetsFrom(pad(68, 0, 447, 0), " 447.5px ")).toEqual(pad(68, 0, 447.5, 0));
  });

  it("falls back to the map padding for an unresolved stylesheet default", () => {
    expect(insetsFrom(pad(68, 0, 447, 0), "53dvh")).toEqual(pad(68, 0, 447, 0));
    expect(insetsFrom(pad(68, 0, 447, 0), "calc(1rem + 3px)")).toEqual(pad(68, 0, 447, 0));
    expect(insetsFrom(pad(0, 0, 0, 0), "")).toEqual(pad(0, 0, 0, 0));
  });

  it("is nothing on the desktop layout, where the map is its own column", () => {
    expect(insetsFrom(pad(0, 0, 0, 0), "0px")).toEqual(pad(0, 0, 0, 0));
  });
});

describe("beyond", () => {
  it("returns only what is not already in the map's padding", () => {
    expect(beyond(pad(132, 64, 500, 30), pad(68, 0, 447, 0))).toEqual(pad(64, 64, 53, 30));
  });

  it("never goes negative", () => {
    expect(beyond(pad(10, 0, 100, 0), pad(68, 0, 447, 0))).toEqual(pad(0, 0, 0, 0));
  });
});
