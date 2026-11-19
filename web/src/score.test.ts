import { describe, expect, it } from "vitest";

import { buildEffortGrid } from "./effort";
import { buildHostTreeGrid } from "./hostTree";
import type { CurrentConditions, SpeciesModel } from "./model";
import {
  conditionsScore,
  confidenceBand,
  countWithin,
  dayOfYear,
  dedupeToGrid,
  habitatScore,
  haversineKm,
  nearestCell,
  seasonalityScore,
  weatherScore,
} from "./score";

describe("haversineKm", () => {
  it("is ~111.19 km per degree of latitude and 0 for a point on itself", () => {
    expect(haversineKm(56, 9, 57, 9)).toBeCloseTo(111.19, 1);
    expect(haversineKm(56, 9, 56, 9)).toBe(0);
  });
});

describe("dayOfYear", () => {
  it("counts from 1 on Jan 1", () => {
    expect(dayOfYear(new Date(2026, 0, 1))).toBe(1);
    expect(dayOfYear(new Date(2026, 8, 5))).toBe(248); // 2026-09-05
    expect(dayOfYear(new Date(2024, 11, 31))).toBe(366); // leap year
  });
});

describe("seasonalityScore", () => {
  const curve = Array.from({ length: 366 }, (_, i) => (i === 244 ? 1 : 0.01)); // peak at doy 245

  it("reads the curve by day-of-year and clamps out-of-range days", () => {
    expect(seasonalityScore(curve, 245)).toBe(1);
    expect(seasonalityScore(curve, 10)).toBe(0.01);
    expect(seasonalityScore(curve, 0)).toBe(0.01); // clamped to day 1
    expect(seasonalityScore(curve, 999)).toBe(0.01); // clamped to day 366
  });

  it("is 0 for an empty curve", () => {
    expect(seasonalityScore([], 245)).toBe(0);
  });
});

describe("habitatScore", () => {
  it("is raw / rawRef, clamped to 1, and 0 when rawRef is non-positive", () => {
    expect(habitatScore(20, 40)).toBe(0.5);
    expect(habitatScore(80, 40)).toBe(1);
    expect(habitatScore(5, 0)).toBe(0);
  });

  it("falls back to raw/rawRef when effort or ratioRef is missing (ADR-0018)", () => {
    expect(habitatScore(20, 40, null, 10)).toBe(0.5); // no ratioRef
    expect(habitatScore(20, 40, 5, null)).toBe(0.5); // no effort
  });

  it("corrects by ratio/ratioRef when both are supplied, floored at MIN_EFFORT_TO_CORRECT", () => {
    // raw=10, ratioRef=2: effort=5 (>= floor) -> ratio=10/5=2 -> 2/2=1
    expect(habitatScore(10, 999, 2, 5)).toBeCloseTo(1, 6);
    // same raw/ratioRef but far more effort -> smaller ratio -> lower score
    expect(habitatScore(10, 999, 2, 100)).toBeLessThan(1);
    // effort below the floor is clamped up to it, not divided by directly
    expect(habitatScore(10, 999, 2, 1)).toBeCloseTo(habitatScore(10, 999, 2, 5), 6);
  });
});

describe("dedupeToGrid", () => {
  it("keeps one point per grid cell, first seen (ADR-0011 habitat._dedupe port)", () => {
    const pts: [number, number][] = [
      [9.6, 56.3],
      [9.6009, 56.3009], // same ~660 m cell as the first -> dropped
      [9.61, 56.3], // a new cell east
    ];
    expect(dedupeToGrid(pts, 0.006)).toEqual([
      [9.6, 56.3],
      [9.61, 56.3],
    ]);
  });

  it("matches Python round() half-to-even on a cell boundary", () => {
    // 9.003 / 0.006 = 1500.5 -> Python round -> 1500 (even), not 1501, so 9.000
    // and 9.003 share cell 1500; a naive Math.round would split them.
    const shareCell: [number, number][] = [
      [9.0, 56.3],
      [9.003, 56.3],
    ];
    // 9.009 / 0.006 = 1501.5 -> 1502 (even): a genuinely different cell.
    const differentCells: [number, number][] = [
      [9.003, 56.3],
      [9.009, 56.3],
    ];
    expect(dedupeToGrid(shareCell, 0.006)).toHaveLength(1);
    expect(dedupeToGrid(differentCells, 0.006)).toHaveLength(2);
  });
});

describe("countWithin", () => {
  it("counts points inside the radius", () => {
    const pts: [number, number][] = [
      [9.6, 56.3],
      [9.61, 56.3],
      [10.4, 56.3],
    ];
    expect(countWithin(pts, 2, 9.6, 56.3)).toBe(2);
    expect(countWithin(pts, 200, 9.6, 56.3)).toBe(3);
  });
});

describe("weatherScore", () => {
  const features = {
    precip_14d_mm: { mean: 30, sd: 8 },
    precip_30d_mm: { mean: 60, sd: 15 },
    mean_temp_14d_c: { mean: 13, sd: 2 },
  };

  it("peaks at 1 when every feature sits on its mean", () => {
    expect(
      weatherScore(features, { precip_14d_mm: 30, precip_30d_mm: 60, mean_temp_14d_c: 13 }),
    ).toBeCloseTo(1, 9);
  });

  it("drops well below 1 when the features are far off", () => {
    const v = weatherScore(features, {
      precip_14d_mm: 120,
      precip_30d_mm: 5,
      mean_temp_14d_c: 3,
    });
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.2);
  });

  it("is neutral (1) with no fitted features or no values", () => {
    expect(weatherScore(null, { precip_14d_mm: 30 })).toBe(1);
    expect(weatherScore(features, {})).toBe(1);
    expect(weatherScore(features, { unrelated: 5 })).toBe(1);
  });
});

describe("confidenceBand", () => {
  it("bands by nearby-find count", () => {
    expect(confidenceBand(0)).toBe("low");
    expect(confidenceBand(4)).toBe("low");
    expect(confidenceBand(5)).toBe("medium");
    expect(confidenceBand(19)).toBe("medium");
    expect(confidenceBand(20)).toBe("high");
  });
});

describe("nearestCell", () => {
  it("returns the closest cell and its distance", () => {
    const cell = (id: string, lon: number, lat: number): CurrentConditions["cells"][number] => ({
      cell_id: id,
      lon,
      lat,
      precip_days_covered: 30,
      precip_14d_mm: null,
      precip_30d_mm: null,
      mean_temp_14d_c: null,
      dry_days_30d: null,
      precip_60d_mm: null,
      precip_60d_days_covered: 0,
      prior_summer_precip_mm: null,
      prior_summer_days_covered: 0,
    });
    const cells = [cell("a", 9.5, 56.2), cell("b", 10.5, 56.9)];
    const near = nearestCell(cells, 9.55, 56.22);
    expect(near?.cell.cell_id).toBe("a");
    expect(near?.distKm).toBeLessThan(5);
  });
});

describe("conditionsScore", () => {
  // A tight cluster of finds around (9.6, 56.3); habitat saturates there.
  const points: [number, number][] = Array.from({ length: 12 }, (_, i) => [
    9.6 + (i % 4) * 0.002,
    56.3 + Math.floor(i / 4) * 0.002,
  ]);
  const model: SpeciesModel = {
    slug: "test",
    habitat: { bandwidth_km: 1.7, raw_ref: 2, ratio_ref: null }, // 12 finds -> 4 ~660 m localities (ADR-0011)
    seasonality: {
      sigma_days: 15,
      // 1 in a ~2-month window, a realistic near-zero tail elsewhere
      curve: Array.from({ length: 366 }, (_, i) => (i >= 220 && i <= 275 ? 1 : 1e-5)),
    },
    weather: {
      n_observations: 200,
      features: {
        precip_14d_mm: { mean: 40, sd: 20 },
        precip_30d_mm: { mean: 80, sd: 30 },
        mean_temp_14d_c: { mean: 13, sd: 3 },
        dry_days_30d: { mean: 16, sd: 4 },
      },
    },
    host_tree: { pinus_sylvestris: 0.9 },
    host_tree_scored: true,
    biotope: null,
    calibration: null,
    fit: {
      n_observations: 12,
      locality_spacing_km: 0.2,
      weather_fitted: false,
      biotope_fitted: false,
      effort_corrected: false,
      host_tree_fitted: false,
      host_tree_scored: true,
      calibrated: false,
    },
  };
  const hostTreeGrid = buildHostTreeGrid([{ lon: 9.602, lat: 56.302, pinus_sylvestris: 0.8 }]);
  const current: CurrentConditions = {
    as_of: "2026-09-05",
    features: ["precip_14d_mm", "precip_30d_mm", "mean_temp_14d_c", "dry_days_30d"],
    cells: [
      {
        cell_id: "a",
        lon: 9.6,
        lat: 56.3,
        precip_days_covered: 30,
        precip_14d_mm: 40,
        precip_30d_mm: 80,
        mean_temp_14d_c: 13,
        dry_days_30d: 16,
        precip_60d_mm: null,
        precip_60d_days_covered: 0,
        prior_summer_precip_mm: null,
        prior_summer_days_covered: 0,
      },
    ],
  };
  const base = {
    points,
    model,
    weatherFeatures: current.features,
    current,
    hostTreeGrid,
    date: new Date(2026, 8, 5),
  };

  it("is high in season on the cluster, with weather and host_tree engaged; value = geo-mean of the axes", () => {
    const sc = conditionsScore({ ...base, lon: 9.602, lat: 56.302 });
    expect(sc.habitat).toBe(1);
    expect(sc.seasonality).toBe(1);
    expect(sc.weatherAvailable).toBe(true);
    expect(sc.weather).toBeCloseTo(1, 6);
    expect(sc.hostTreeAvailable).toBe(true);
    expect(sc.hostTree).toBeCloseTo(0.8, 6);
    expect(sc.value).toBe(
      Math.round(100 * (sc.habitat * sc.seasonality * sc.weather * sc.hostTree) ** (1 / 4)),
    );
    expect(sc.value).toBeGreaterThan(90); // all four axes ~0.8-1 -> high
    expect(sc.nNearby).toBe(12);
    expect(sc.confidence).toBe("medium"); // 12 finds nearby, both optional axes present -> not "high"
  });

  it("knocks down confidence a further notch when only one optional axis is present (ADR-0019)", () => {
    const weatherOnly = conditionsScore({ ...base, hostTreeGrid: null, lon: 9.602, lat: 56.302 });
    expect(weatherOnly.weatherAvailable).toBe(true);
    expect(weatherOnly.hostTreeAvailable).toBe(false);
    expect(weatherOnly.confidence).toBe("low"); // "medium" knocked down again

    const hostTreeOnly = conditionsScore({
      ...base,
      current: null,
      lon: 9.602,
      lat: 56.302,
    });
    expect(hostTreeOnly.weatherAvailable).toBe(false);
    expect(hostTreeOnly.hostTreeAvailable).toBe(true);
    expect(hostTreeOnly.confidence).toBe("low");
  });

  it("ignores a fitted host_tree when the species isn't in the scored set (ADR-0019)", () => {
    // mirrors pipeline/model/species_model.py's host_tree_scored gate: real
    // per-tree data can be fitted and published for a species without it
    // ever reaching that species' ranked score.
    const notScored: SpeciesModel = { ...model, host_tree_scored: false };
    const sc = conditionsScore({ ...base, model: notScored, lon: 9.602, lat: 56.302 });
    expect(sc.hostTree).toBe(1);
    expect(sc.hostTreeAvailable).toBe(false);
  });

  it("still spreads a middling axis instead of pinning it near zero", () => {
    // habitat ~1, weather ~1, seasonality on a shoulder day (~0.3):
    // product would be ~0.3 -> 30, geo-mean is (0.3)^(1/3) ~ 0.67 -> ~67
    const shoulder: SpeciesModel = {
      ...model,
      seasonality: { sigma_days: 15, curve: Array.from({ length: 366 }, () => 0.3) },
    };
    const sc = conditionsScore({ ...base, model: shoulder, lon: 9.602, lat: 56.302 });
    expect(sc.seasonality).toBeCloseTo(0.3, 6);
    expect(sc.value).toBeGreaterThan(50);
    expect(sc.value).toBe(
      Math.round(100 * (sc.habitat * sc.seasonality * sc.weather * sc.hostTree) ** (1 / 4)),
    );
  });

  it("collapses off-season", () => {
    const sc = conditionsScore({ ...base, lon: 9.602, lat: 56.302, date: new Date(2026, 1, 5) });
    expect(sc.seasonality).toBeLessThan(0.05);
    expect(sc.value).toBeLessThanOrEqual(5);
  });

  it("collapses far from any find and drops the confidence band", () => {
    const sc = conditionsScore({ ...base, lon: 10.4, lat: 56.3 });
    expect(sc.habitat).toBeLessThan(1e-6);
    expect(sc.value).toBe(0);
    expect(sc.confidence).toBe("low");
  });

  it("treats weather as unavailable when the nearest cell is off the grid", () => {
    const sc = conditionsScore({ ...base, lon: 7.9, lat: 57.5 }); // >12 km from cell "a"
    expect(sc.weatherAvailable).toBe(false);
    expect(sc.weather).toBe(1);
  });

  it("nulls out an undercovered wide-window feature without disabling weather entirely (ADR-0017)", () => {
    const modelWith60d: SpeciesModel = {
      ...model,
      weather: {
        n_observations: 200,
        features: { ...model.weather!.features, precip_60d_mm: { mean: 160, sd: 40 } },
      },
    };
    const undercovered: CurrentConditions = {
      ...current,
      features: [...current.features, "precip_60d_mm"],
      cells: [{ ...current.cells[0], precip_60d_mm: 999, precip_60d_days_covered: 40 }], // < 56
    };
    const sc = conditionsScore({
      ...base,
      model: modelWith60d,
      current: undercovered,
      weatherFeatures: undercovered.features,
      lon: 9.602,
      lat: 56.302,
    });
    // still engaged (the other four features are fully covered) and unchanged
    // by the wildly-off precip_60d_mm value, since it was excluded, not used
    expect(sc.weatherAvailable).toBe(true);
    expect(sc.weather).toBeCloseTo(1, 6);
  });

  it("effort-corrects the habitat term when an effort grid is supplied (ADR-0018)", () => {
    const modelWithRatio: SpeciesModel = {
      ...model,
      habitat: { ...model.habitat, ratio_ref: model.habitat.raw_ref },
    };
    const q = { ...base, model: modelWithRatio, lon: 9.602, lat: 56.302 };

    const lowEffort = conditionsScore({
      ...q,
      effortGrid: buildEffortGrid([{ lon: 9.602, lat: 56.302, n: 5 }]),
    });
    const highEffort = conditionsScore({
      ...q,
      effortGrid: buildEffortGrid([{ lon: 9.602, lat: 56.302, n: 500 }]),
    });
    // same raw density either way; far more background recording at the same
    // spot should read as *less* remarkable for this species, not more
    expect(highEffort.habitat).toBeLessThan(lowEffort.habitat);

    // omitting the grid entirely falls back to exactly the plain model's score
    // (no ratio_ref at all) at the same point -- a caller that doesn't look up
    // effort is unaffected by whether ratio_ref happens to be set
    const withoutGrid = conditionsScore(q);
    const plain = conditionsScore({ ...q, model });
    expect(withoutGrid.habitat).toBe(plain.habitat);
  });
});
