import { describe, expect, it } from "vitest";
import { detectPlatform } from "./install";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

describe("detectPlatform", () => {
  it("knows an iPhone", () => expect(detectPlatform(IPHONE, 5)).toBe("ios"));
  it("knows an iPad that claims to be a Mac", () =>
    expect(detectPlatform(IPAD_DESKTOP_UA, 5)).toBe("ios"));
  it("leaves a real Mac alone", () => expect(detectPlatform(IPAD_DESKTOP_UA, 0)).toBe("other"));
  it("knows Android", () => expect(detectPlatform(ANDROID, 5)).toBe("android"));
  it("treats desktop as other", () => expect(detectPlatform(WINDOWS, 0)).toBe("other"));
});
