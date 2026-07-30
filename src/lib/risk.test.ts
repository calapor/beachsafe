import { describe, it, expect } from "vitest";
import { buildLadder, percentileOf, tierFromPercentile } from "./calibration";
import { scoreDay, EXPOSURE_WEIGHT } from "./risk";
import type { ObsRowExtended, Coverage } from "./hazard";
import type { PercentileTable } from "./calibration";

// Synthetic per-month clim tables (used by hazard components)
function makeClim(vals: number[], metric: string): PercentileTable {
  return {
    metric, month: 7, n: vals.length,
    coverageStart: "2000-01-01", coverageEnd: "2020-12-31",
    ladder: buildLadder(vals)!,
  };
}

const uniformClim: Record<string, PercentileTable | null> = {
  wave_height_m:   makeClim(Array.from({ length: 200 }, (_, i) => i * 0.025), "wave_height_m"),
  tide_range_m:    makeClim(Array.from({ length: 200 }, (_, i) => i * 0.025), "tide_range_m"),
  mean_wind_knots: makeClim(Array.from({ length: 200 }, (_, i) => i * 0.15),  "mean_wind_knots"),
  max_gust_knots:  makeClim(Array.from({ length: 200 }, (_, i) => i * 0.25),  "max_gust_knots"),
  sea_temp_c:      makeClim(Array.from({ length: 200 }, (_, i) => 5 + i * 0.1), "sea_temp_c"),
  temp_max_c:      makeClim(Array.from({ length: 200 }, (_, i) => i * 0.2),   "temp_max_c"),
};

const fullCoverage: Coverage = { weather: true, waves: true, tide: true, swell: true };

const baseObs: ObsRowExtended[] = [{
  date: "2020-07-04",
  mean_wind_knots: 10, max_gust_knots: 20,
  wave_height_m: 1.1, tide_range_m: 3.0,
  sea_temp_c: 14, temp_max_c: 22, wind_dir_deg: 270,
}];

const baseCalendar = { year: 2020, month: 7, day: 4, dayOfWeek: 6 }; // Saturday in July

describe("scoreDay", () => {
  it("returns a combined score between 0 and 1", () => {
    const result = scoreDay(baseObs, 90, uniformClim, fullCoverage, baseCalendar);
    expect(result.combined).not.toBeNull();
    expect(result.combined!).toBeGreaterThanOrEqual(0);
    expect(result.combined!).toBeLessThanOrEqual(1);
  });

  it("combined = EXPOSURE_WEIGHT * exposure + (1-EXPOSURE_WEIGHT) * hazard when both available", () => {
    const result = scoreDay(baseObs, 90, uniformClim, fullCoverage, baseCalendar);
    if (result.hazard.score != null && result.exposure.score != null) {
      const expected = EXPOSURE_WEIGHT * result.exposure.score + (1 - EXPOSURE_WEIGHT) * result.hazard.score;
      expect(result.combined).toBeCloseTo(expected, 10);
    }
  });

  it("returns features with onshoreSigned set", () => {
    const result = scoreDay(baseObs, 90, uniformClim, fullCoverage, baseCalendar);
    // wind_dir_deg=270 (west), bearing=90 (east): wind is offshore → onshoreSigned < 0
    expect(result.features.onshoreSigned).toBeLessThan(0);
    // onshoreComponent must be clamped to 0
    expect(result.features.onshoreComponent).toBe(0);
  });

  it("weekend and peak season increase exposure score vs weekday off-season", () => {
    const summerWeekend = scoreDay(baseObs, 90, uniformClim, fullCoverage,
      { year: 2020, month: 7, day: 4, dayOfWeek: 6 }); // Saturday in July

    const winterWeekday = scoreDay(baseObs, 90, uniformClim, fullCoverage,
      { year: 2020, month: 1, day: 6, dayOfWeek: 1 }); // Monday in January

    expect(summerWeekend.exposure.score!).toBeGreaterThan(winterWeekday.exposure.score!);
  });
});

describe("ladder round-trip", () => {
  it("buildLadder + percentileOf + tierFromPercentile yields expected tier frequencies", () => {
    // Build a uniform distribution of 1000 scores from 0 to 1
    const samples = Array.from({ length: 1000 }, (_, i) => i / 999);
    const ladder = buildLadder(samples)!;
    expect(ladder).not.toBeNull();

    const table: PercentileTable = {
      metric: "combined_score", month: 0, n: 1000,
      coverageStart: "2005-01-01", coverageEnd: "2026-12-31",
      ladder,
    };

    // Count how many of the original scores fall into each tier
    const tiers = samples.map((s) => tierFromPercentile(percentileOf(s, table)));
    const severe  = tiers.filter((t) => t === "severe").length;
    const warning = tiers.filter((t) => t === "warning").length;
    const watch   = tiers.filter((t) => t === "watch").length;
    const low     = tiers.filter((t) => t === "low").length;

    // Tier thresholds: severe ≥0.98, warning ≥0.90, watch ≥0.75
    // With a uniform distribution: severe=2%, warning=8%, watch=15%, low=75%
    expect(severe  / 1000).toBeCloseTo(0.02, 1);
    expect(warning / 1000).toBeCloseTo(0.08, 1);
    expect(watch   / 1000).toBeCloseTo(0.15, 1);
    expect(low     / 1000).toBeCloseTo(0.75, 1);
  });
});
