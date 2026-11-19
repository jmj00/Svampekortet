import { describe, expect, it } from "vitest";

import {
  describeSections,
  factorLevelText,
  limitingFactor,
  redlistFact,
  scoreFactors,
  qualitativeLabel,
  seasonRangeText,
  seasonSummary,
} from "./detailModel";
import { type Conditions, scoreBand } from "./score";

const TRAGT = [40, 4, 0, 0, 0, 0, 16, 167, 431, 559, 210, 83];

function conditions(overrides: Partial<Conditions>): Conditions {
  return {
    value: 45,
    raw: 0.09,
    habitat: 0.32,
    seasonality: 0.45,
    weather: 0.62,
    hostTree: 1,
    nNearby: 53,
    weatherAvailable: true,
    hostTreeAvailable: false,
    confidence: "medium",
    ...overrides,
  };
}

describe("seasonSummary", () => {
  it("returns null when there are no dated finds", () => {
    expect(seasonSummary(new Array(12).fill(0), 9)).toBeNull();
    expect(seasonSummary([], 9)).toBeNull();
  });

  it("finds the peak and the unbroken season around it", () => {
    const summary = seasonSummary(TRAGT, 10);
    expect(summary?.peakMonth).toBe(9);
    expect(summary && seasonRangeText(summary)).toBe("august–november");
    expect(summary?.total).toBe(1510);
    expect(summary?.inSeason[0]).toBe(false); // January's stragglers are not the season
  });

  it("grades the current month", () => {
    expect(seasonSummary(TRAGT, 9)?.status).toBe("peak");
    expect(seasonSummary(TRAGT, 10)?.status).toBe("in");
    expect(seasonSummary(TRAGT, 4)?.status).toBe("out");
  });

  it("wraps a winter season across the new year", () => {
    const winter = [50, 40, 5, 0, 0, 0, 0, 0, 0, 5, 30, 60];
    const summary = seasonSummary(winter, 0);
    expect(summary && seasonRangeText(summary)).toBe("november–februar");
    expect(summary?.status).toBe("peak");
  });

  it("handles a species found evenly all year", () => {
    const summary = seasonSummary(new Array(12).fill(7), 3);
    expect(summary && seasonRangeText(summary)).toBe("hele året");
  });
});

describe("score factors", () => {
  it("lists weather as missing and leaves host trees out unless they count", () => {
    const factors = scoreFactors(conditions({ weatherAvailable: false }));
    expect(factors.map((f) => f.key)).toEqual(["habitat", "season", "weather"]);
    expect(factors[2].fraction).toBeNull();
    expect(
      scoreFactors(conditions({ hostTreeAvailable: true, hostTree: 0.4 })).map((f) => f.key),
    ).toContain("hostTree");
  });

  it("names the lowest factor as the one holding the number down", () => {
    expect(limitingFactor(scoreFactors(conditions({})))?.key).toBe("habitat");
    expect(
      limitingFactor(scoreFactors(conditions({ weatherAvailable: false, weather: 0 })))?.key,
    ).toBe("habitat");
  });

  it("names none when every factor is good", () => {
    const all = conditions({ habitat: 0.7, seasonality: 0.9, weather: 0.65 });
    expect(limitingFactor(scoreFactors(all))).toBeNull();
  });

  it("words a factor by the colour band of its bar", () => {
    expect(factorLevelText(0.29)).toBe("Lav");
    expect(factorLevelText(0.3)).toBe("Middel");
    expect(factorLevelText(0.32)).toBe("Middel");
    expect(factorLevelText(0.59)).toBe("Middel");
    expect(factorLevelText(0.6)).toBe("God");
    for (let pct = 0; pct <= 100; pct++) {
      const word = factorLevelText(pct / 100);
      expect(word).toBe({ low: "Lav", ok: "Middel", good: "God" }[scoreBand(pct)]);
    }
  });

  it("changes the overall label where the colour band changes", () => {
    expect(qualitativeLabel(14)).toBe("Meget lave forhold");
    expect(qualitativeLabel(15)).toBe("Lave forhold");
    expect(qualitativeLabel(29)).toBe("Lave forhold");
    expect(qualitativeLabel(30)).toBe("Middel forhold");
    expect(qualitativeLabel(59)).toBe("Middel forhold");
    expect(qualitativeLabel(60)).toBe("Gode forhold");
    expect(qualitativeLabel(80)).toBe("Meget gode forhold");
  });
});

describe("redlistFact", () => {
  it("translates the categories in the payload", () => {
    expect(redlistFact("LC")).toEqual({ value: "Livskraftig", code: "LC" });
    expect(redlistFact("not assessed")).toEqual({ value: "Ikke vurderet", code: null });
    expect(redlistFact("NA")).toEqual({ value: "Vurderes ikke", code: "NA" });
    expect(redlistFact(null)).toEqual({ value: "Ukendt", code: null });
  });
});

describe("describeSections", () => {
  it("labels the three-part pattern", () => {
    const text =
      "Tragt-kantarel er en lille svamp.\nKødet er tyndt.\n\n" +
      "Den vokser sent på året.\n\nDer er ingen farlige forvekslingsarter. Andre ligner.";
    const sections = describeSections(text, "Tragt-Kantarel");
    expect(sections.map((s) => s.heading)).toEqual([
      "Kendetegn",
      "Levested og sæson",
      "Forveksling",
    ]);
    expect(sections[0].text).toBe("Tragt-kantarel er en lille svamp. Kødet er tyndt.");
  });

  it("leaves a paragraph unlabelled when its subject is not plain", () => {
    const text = "Skær altid svampen igennem.\n\nKødet er blødt og smagen mild.";
    expect(describeSections(text, "Kæmpestøvbold").map((s) => s.heading)).toEqual([null, null]);
  });

  it("heads a paragraph that mentions lookalikes or poison anywhere", () => {
    const text =
      "Skær altid støvbolden helt igennem. Ser du en hat, er det en ung fluesvamp (*Amanita*).\n\n" +
      "En eftertragtet spisesvamp. Ægte Stenmorkel er giftig.";
    expect(describeSections(text, "Spiselig Morkel").map((s) => s.heading)).toEqual([
      "Forveksling og sikkerhed",
      "Forveksling og sikkerhed",
    ]);
  });

  it("names cooking cautions", () => {
    const text =
      "Hatten er orange. Den skal steges eller koges – aldrig spises rå.\n\n" +
      "Arten er vednedbryder og ses fra maj. Svampen skal altid gennemsteges.\n\n" +
      "Spiselig men blød; steg dem godt. Ingen giftige forvekslingsarter.";
    expect(describeSections(text, "Gran-Mælkehat").map((s) => s.heading)).toEqual([
      "Kendetegn og tilberedning",
      "Levested og tilberedning",
      "Tilberedning og forveksling",
    ]);
    // "råddent" and "råt" are not "rå"
    expect(describeSections("Den vokser på råddent ved.", "X")[0].heading).toBe(
      "Levested og sæson",
    );
  });

  it("heads the species' own description when it follows a safety paragraph", () => {
    const text =
      "Skær altid støvbolden igennem. En hat med lameller er en ung fluesvamp.\n\n" +
      "Pære-Støvbold er den eneste støvbold på træ.";
    expect(describeSections(text, "Pære-Støvbold").map((s) => s.heading)).toEqual([
      "Forveksling og sikkerhed",
      "Kendetegn",
    ]);
  });

  it("does not call a harmless colour change a lookalike", () => {
    const text =
      "Rustrød Skælrørhat har en orange hat. Snitfladen bliver rødlig – det er helt ufarligt.";
    expect(describeSections(text, "Rustrød Skælrørhat")[0].heading).toBe("Kendetegn");
    expect(describeSections("Den er ikke farlig, men kedelig.", "X")[0].heading).toBe(
      "Forveksling og sikkerhed",
    );
  });

  it("keeps Kendetegn first but still names the safety content", () => {
    const text = "Tvefarvet Mælkehat har orange mælk. Ingen giftig mælkehat har orange mælk.";
    expect(describeSections(text, "Tvefarvet Mælkehat")[0].heading).toBe(
      "Kendetegn og forveksling",
    );
  });

  it("puts every lookalike or poison paragraph in the tracked data under a Forveksling heading", () => {
    // the tracked snapshot the app ships with (web/public/data)
    const docs = Object.values(
      import.meta.glob<{ danish_name: string; description: string | null }>(
        "../public/data/species/*.json",
        { eager: true, import: "default" },
      ),
    );
    expect(docs.length).toBeGreaterThanOrEqual(50);
    let checked = 0;
    for (const doc of docs) {
      if (!doc.description) continue;
      const sections = describeSections(doc.description, doc.danish_name);
      // every paragraph survives, in order
      expect(sections.map((s) => s.text).join(" ")).toBe(
        doc.description.replace(/\s+/g, " ").trim(),
      );
      for (const section of sections) {
        if (
          !/forveksl|giftig|(^|[^u])farlig|fluesvamp|amanita|hold dig fra|lad svampen stå/i.test(
            section.text,
          )
        )
          continue;
        checked++;
        expect(section.heading, `${doc.danish_name}: ${section.text.slice(0, 60)}`).toMatch(
          /forveksling/i,
        );
      }
    }
    expect(checked).toBeGreaterThan(40);
  });
});
