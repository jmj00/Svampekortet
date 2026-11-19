import { describe, expect, it } from "vitest";

import { seasonInfo, seasonLabel, seasonRank } from "./season";
import { thumbSources } from "./thumb";

// Real shapes from the published payload.
const TRAGT_KANTAREL = [40, 4, 0, 0, 0, 0, 16, 167, 431, 559, 210, 83];
const KARL_JOHAN = [0, 0, 0, 1, 1, 19, 192, 800, 1086, 824, 88, 2];

describe("seasonInfo", () => {
  it("marks the best months as peak and the shoulders as in season", () => {
    expect(seasonInfo(TRAGT_KANTAREL, 9).state).toBe("peak"); // October
    expect(seasonInfo(TRAGT_KANTAREL, 10).state).toBe("in"); // November
    expect(seasonInfo(TRAGT_KANTAREL, 3).state).toBe("out"); // April
  });

  it("finds the run of in-season months around the best month", () => {
    const info = seasonInfo(KARL_JOHAN, 0);
    expect([info.from, info.to]).toEqual([7, 9]);
    expect(seasonLabel(info)).toBe("Sæson aug–okt");
  });

  it("lets a season wrap past New Year", () => {
    const winter = [90, 60, 5, 0, 0, 0, 0, 0, 0, 10, 50, 100];
    const info = seasonInfo(winter, 5);
    expect([info.from, info.to]).toEqual([10, 1]);
    expect(seasonLabel(info)).toBe("Sæson nov–feb");
  });

  it("copes with finds in every month", () => {
    const info = seasonInfo(new Array<number>(12).fill(30), 4);
    expect(info.state).toBe("peak");
    expect(info.from).not.toBeNull();
  });

  it("is unknown with too few finds", () => {
    expect(seasonInfo(new Array<number>(12).fill(0), 9).state).toBe("unknown");
    expect(seasonInfo([0, 0, 0, 0, 0, 0, 0, 0, 3, 2, 0, 0], 8).state).toBe("unknown");
    expect(seasonLabel(seasonInfo([], 8))).toBe("");
  });

  it("labels the current state", () => {
    expect(seasonLabel(seasonInfo(TRAGT_KANTAREL, 9))).toBe("Højsæson nu");
    expect(seasonLabel(seasonInfo(TRAGT_KANTAREL, 10))).toBe("I sæson nu");
  });
});

describe("seasonRank", () => {
  it("orders peak > in > out > unknown", () => {
    const peak = seasonRank(seasonInfo(TRAGT_KANTAREL, 9));
    const inSeason = seasonRank(seasonInfo(TRAGT_KANTAREL, 10));
    const out = seasonRank(seasonInfo(TRAGT_KANTAREL, 3));
    const unknown = seasonRank(undefined);
    expect(peak).toBeGreaterThan(inSeason);
    expect(inSeason).toBeGreaterThan(out);
    expect(out).toBeGreaterThan(unknown);
  });
});

describe("thumbSources", () => {
  it("swaps an iNaturalist large photo for its small variants", () => {
    const base = "https://inaturalist-open-data.s3.amazonaws.com/photos/45641121";
    expect(thumbSources(`${base}/large.jpeg`)).toEqual({
      src: `${base}/square.jpeg`,
      srcset: `${base}/square.jpeg 75w, ${base}/small.jpeg 240w`,
    });
  });

  it("gives the same pair from the manifest's small thumbnail URL", () => {
    const base = "https://inaturalist-open-data.s3.amazonaws.com/photos/56612455";
    expect(thumbSources(`${base}/small.jpg`)).toEqual(thumbSources(`${base}/large.jpg`));
    expect(thumbSources(`${base}/small.jpg`).src).toBe(`${base}/square.jpg`);
  });

  it("leaves other URLs alone", () => {
    expect(thumbSources("https://example.org/a/large-photo.jpg")).toEqual({
      src: "https://example.org/a/large-photo.jpg",
    });
  });
});
