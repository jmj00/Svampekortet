import { describe, expect, it } from "vitest";
import { chipText } from "./chipname";

describe("chipText", () => {
  const part = { long: "I Børsmose Plantage i Kærgård Klitplantage", short: "I Børsmose Plantage" };

  it("shows the long form when it fits", () => {
    expect(chipText(part, true)).toEqual({
      visible: "I Børsmose Plantage i Kærgård Klitplantage",
      hidden: "",
      tooltip: "",
      form: "long",
    });
  });

  it("shows the short form when the long one does not fit, keeping the rest for readers", () => {
    const text = chipText(part, false);
    expect(text.visible).toBe("I Børsmose Plantage");
    expect(text.hidden).toBe(" i Kærgård Klitplantage");
    expect(text.visible + text.hidden).toBe(part.long); // read together: the long form
    expect(text.tooltip).toBe(part.long);
    expect(text.form).toBe("short");
  });

  it("has nothing shorter to offer for a name with one form", () => {
    const plain = { long: "Ved Høgildovergård Plantage", short: "Ved Høgildovergård Plantage" };
    // too long or not, it is what there is (the chip's own ellipsis takes over)
    expect(chipText(plain, false)).toEqual({
      visible: plain.long,
      hidden: "",
      tooltip: "",
      form: "long",
    });
  });

  it("does not invent a hidden remainder when the short form is not a prefix", () => {
    const text = chipText({ long: "Rold Skov, Mølleskov", short: "Mølleskov" }, false);
    expect(text.hidden).toBe("");
    expect(text.tooltip).toBe("Rold Skov, Mølleskov");
  });
});
