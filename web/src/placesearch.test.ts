import { describe, expect, it } from "vitest";

import { byRank, missedText } from "./addresscombo";
import { distanceText, nameRank, searchMessage } from "./placesearch";

describe("searchMessage", () => {
  it("says nothing while there is nothing to say", () => {
    expect(searchMessage({ state: "idle", query: "" }, "tryk")).toBe("");
    expect(searchMessage({ state: "results", query: "rold" }, "tryk")).toBe("");
  });

  it("suggests a street with a town, and the map in the device's own verb", () => {
    const phone = searchMessage({ state: "empty", query: "qqzz" }, "tryk");
    expect(phone).toBe(
      "Ingen skove, byer eller adresser matcher „qqzz“. Prøv et vejnavn med by, fx „Vestergade 10, Silkeborg“, eller tryk på kortet.",
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
      "Adressesøgningen svarer ikke lige nu, så her er kun skove og byer.",
    );
  });
});

describe("distanceText", () => {
  it("says how far a forest is from the town, in whole kilometres", () => {
    expect(distanceText({ lon: 9.52, lat: 56.14 }, [9.551, 56.181], "Silkeborg")).toBe(
      "5 km fra Silkeborg",
    );
    expect(distanceText({ lon: 9.551, lat: 56.182 }, [9.551, 56.181], "Silkeborg")).toBe(
      "i Silkeborg",
    );
  });
});

describe("ranking forests and towns together", () => {
  it("rates a name by how it matches", () => {
    expect(nameRank("Rold Skov", "Rold Skov")).toBe(0);
    expect(nameRank("Rold Skov", "rold")).toBe(1);
    expect(nameRank("Nørre Vesterskov", "vester")).toBe(1);
    expect(nameRank("Troldbjerg Skov", "rold")).toBe(2);
    expect(nameRank("Århus Skov", "aarhus skov")).toBe(0);
  });

  it("puts the town that is the name above forests that only contain it", () => {
    const items = [
      { text: "Rold Skov", kind: "local", rank: 1 },
      { text: "Rold Hule", kind: "local", rank: 1 },
      { text: "Troldbjerg Skov", kind: "local", rank: 2 },
      { text: "Rold · 9510 Arden", kind: "place", rank: 0 },
      { text: "Roldsløkker", kind: "place", rank: 1 },
    ];
    expect(byRank(items).map((i) => i.text)).toEqual([
      "Rold · 9510 Arden",
      "Rold Skov",
      "Rold Hule",
      "Roldsløkker",
      "Troldbjerg Skov",
    ]);
    // an exact forest stays first
    expect(
      byRank([
        { text: "Rold Skov", kind: "local", rank: 0 },
        { text: "Rold Skovhus", kind: "place", rank: 1 },
      ]).map((i) => i.text),
    ).toEqual(["Rold Skov", "Rold Skovhus"]);
  });

  it("says when the town typed has no such address", () => {
    expect(missedText("Hovedgaden 1", "Rold")).toBe(
      "Ingen Hovedgaden 1 i Rold – adresser andre steder:",
    );
  });
});
