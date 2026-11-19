import { describe, expect, it } from "vitest";

import { searchMessage } from "./placesearch";

describe("searchMessage", () => {
  it("says nothing while there is nothing to say", () => {
    expect(searchMessage({ state: "idle", query: "" }, "tryk")).toBe("");
    expect(searchMessage({ state: "results", query: "rold" }, "tryk")).toBe("");
  });

  it("suggests a street with a town, and the map in the device's own verb", () => {
    const phone = searchMessage({ state: "empty", query: "qqzz" }, "tryk");
    expect(phone).toBe(
      "Ingen skove eller adresser matcher „qqzz“. Prøv et vejnavn, fx „Vestergade, Silkeborg“, eller tryk på kortet.",
    );
    expect(searchMessage({ state: "empty", query: "qqzz" }, "klik")).toContain("klik på kortet");
    expect(phone).not.toContain("eller en by");
  });

  it("asks for more at two characters: addresses are searched from three", () => {
    expect(searchMessage({ state: "empty", query: "qz" }, "klik")).toBe(
      "Ingen skove matcher „qz“. Skriv lidt mere for også at søge adresser.",
    );
  });

  it("tells a dead address service apart, with and without forests showing", () => {
    expect(searchMessage({ state: "failed", query: "Jernbanegade", shown: 0 }, "klik")).toBe(
      "Adressesøgningen svarer ikke lige nu. Tjek forbindelsen, og prøv igen – eller klik på kortet.",
    );
    expect(searchMessage({ state: "failed", query: "grib", shown: 1 }, "tryk")).toBe(
      "Adressesøgningen svarer ikke lige nu, så her er kun skove.",
    );
  });
});
