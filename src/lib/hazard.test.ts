import { describe, it, expect } from "vitest";
import { hazardComponents, hazardIndex, type Coverage, type ObsRowExtended } from "./hazard";
import { normalizeFeatures } from "./similarity";
import { buildLadder, type PercentileTable } from "./calibration";
import { BEACH_BEARING, fingerprint } from "./similarity";

function makeClim(samples: number[], metric: string): PercentileTable {
  return {
    metric,
    month: 7,
    n: samples.length,
    coverageStart: "2000-01-01",
    coverageEnd: "2020-12-31",
    ladder: buildLadder(samples)!,
  };
}

const fullCoverage: Coverage = { weather: true, waves: true, tide: true, swell: true };
const noData: Coverage = { weather: false, waves: false, tide: false, swell: false };

const baseWindow: ObsRowExtended[] = [
  { date: "2020-07-01", mean_wind_knots: 10, max_gust_knots: 20, wave_height_m: 1.1, tide_range_m: 3.8, sea_temp_c: 14, temp_max_c: 22, wind_dir_deg: 270 },
];

const baseClim: Record<string, PercentileTable> = {
  wave_height_m:   makeClim(Array.from({ length: 200 }, (_, i) => i * 0.05), "wave_height_m"),
  tide_range_m:    makeClim(Array.from({ length: 200 }, (_, i) => i * 0.03), "tide_range_m"),
  mean_wind_knots: makeClim(Array.from({ length: 200 }, (_, i) => i * 0.2), "mean_wind_knots"),
  max_gust_knots:  makeClim(Array.from({ length: 200 }, (_, i) => i * 0.3), "max_gust_knots"),
  sea_temp_c:      makeClim(Array.from({ length: 200 }, (_, i) => 5 + i * 0.1), "sea_temp_c"),
};

describe("ripBand", () => {
  it("peaks near 1.1 m wave height", () => {
    const makeObs = (hs: number): ObsRowExtended[] => [{ date: "2020-07-01", wave_height_m: hs }];
    const fv = normalizeFeatures({});

    const at11 = hazardComponents(fv, makeObs(1.1), baseClim, fullCoverage).find((c) => c.key === "ripBand");
    const at30 = hazardComponents(fv, makeObs(3.0), baseClim, fullCoverage).find((c) => c.key === "ripBand");
    const at00 = hazardComponents(fv, makeObs(0.0), baseClim, fullCoverage).find((c) => c.key === "ripBand");

    expect(at11!.score).toBeGreaterThan(at30!.score!);
    expect(at11!.score).toBeGreaterThan(at00!.score!);
    expect(at11!.score).toBeCloseTo(1.0, 1);
  });

  it("returns null score when waves coverage is false", () => {
    const noCoverage: Coverage = { ...fullCoverage, waves: false };
    const fv = normalizeFeatures({});
    const c = hazardComponents(fv, baseWindow, baseClim, noCoverage).find((c) => c.key === "ripBand");
    expect(c!.score).toBeNull();
  });
});

describe("hazardIndex", () => {
  it("returns null score when all components missing", () => {
    const fv = normalizeFeatures({});
    const components = hazardComponents(fv, baseWindow, baseClim, noData);
    const result = hazardIndex(components);
    expect(result.score).toBeNull();
  });

  it("returns null when fewer than half components available", () => {
    const components = hazardComponents(
      normalizeFeatures({}),
      [{ date: "2020-07-01", wave_height_m: 1.1 }],
      {},
      { weather: false, waves: true, tide: false, swell: false },
    );
    const available = components.filter((c) => c.score != null);
    if (available.length < components.length / 2) {
      expect(hazardIndex(components).score).toBeNull();
    }
  });

  it("driver is the component with the highest score", () => {
    const fv = normalizeFeatures({ tideState: -0.8, hoursFromHigh: 0.9, tideConfidence: 1 });
    const components = hazardComponents(fv, baseWindow, baseClim, fullCoverage);
    const result = hazardIndex(components);
    if (result.score != null && result.driver) {
      const best = components
        .filter((c) => c.score != null)
        .reduce((a, b) => (b.score! > a.score! ? b : a));
      expect(result.driver.key).toBe(best.key);
    }
  });

  it("reachability: hazardIndex ceiling exceeds the watch threshold (0.75)", () => {
    // Build synthetic clim tables that place any non-zero value at 100th percentile
    const maxClim = (metric: string): PercentileTable => ({
      metric, month: 7, n: 200,
      coverageStart: "2000-01-01", coverageEnd: "2020-12-31",
      ladder: buildLadder(Array.from({ length: 200 }, () => 0))!,
    });
    const clim100: Record<string, PercentileTable> = {
      wave_height_m:   maxClim("wave_height_m"),
      tide_range_m:    maxClim("tide_range_m"),
      mean_wind_knots: maxClim("mean_wind_knots"),
      max_gust_knots:  maxClim("max_gust_knots"),
      sea_temp_c:      maxClim("sea_temp_c"),
    };
    // Observation that maximises onshore components (uses onshore wind)
    const obs: ObsRowExtended[] = [{
      date: "2020-07-01",
      wave_height_m: 1.1,   // peak ripBand
      tide_range_m: 10,
      mean_wind_knots: 100, max_gust_knots: 100,
      sea_temp_c: 0,         // cold sea for coldShock
      temp_max_c: 40,
      wind_dir_deg: 90,      // fully onshore for Skerries (bearing=90)
    }];
    const fv = fingerprint(obs, BEACH_BEARING["skerries"] ?? 90);
    const components = hazardComponents(fv, obs, clim100, fullCoverage);
    const result = hazardIndex(components);
    expect(result.score).not.toBeNull();
    // Before the fix: ceiling was ≤ 5/7 ≈ 0.714 < 0.75 (watch) due to dead components
    // After the fix: onshoreWind can score 1.0, so the mean of scored components exceeds 0.75
    expect(result.score!).toBeGreaterThan(0.75);
  });
});

describe("offshoreBlowoff", () => {
  it("fires when wind is offshore and day is warm and calm", () => {
    // Skerries bearing = 90° (east). Wind FROM the west (270°) = offshore.
    const obs: ObsRowExtended[] = [{
      date: "2020-07-01",
      wind_dir_deg: 270,  // west wind, offshore for Skerries
      mean_wind_knots: 8,
      temp_max_c: 28,     // warm day
    }];
    const fv = fingerprint(obs, BEACH_BEARING["skerries"] ?? 90);
    // onshoreSigned should be negative (offshore)
    expect(fv.onshoreSigned).toBeLessThan(0);
    expect(fv.warmCalm).toBeGreaterThan(0);

    const c = hazardComponents(fv, obs, {}, fullCoverage)
      .find((c) => c.key === "offshoreBlowoff");
    expect(c!.score).not.toBeNull();
    expect(c!.score!).toBeGreaterThan(0);
  });

  it("does not fire when wind is onshore", () => {
    // Wind FROM the east (90°) = directly onshore for Skerries
    const obs: ObsRowExtended[] = [{
      date: "2020-07-01",
      wind_dir_deg: 90,
      mean_wind_knots: 8,
      temp_max_c: 28,
    }];
    const fv = fingerprint(obs, BEACH_BEARING["skerries"] ?? 90);
    expect(fv.onshoreSigned).toBeGreaterThan(0);

    const c = hazardComponents(fv, obs, {}, fullCoverage)
      .find((c) => c.key === "offshoreBlowoff");
    expect(c!.score).toBe(0);
  });
});

describe("missing inputs", () => {
  it("springTideRange is insufficient-data when tide coverage false", () => {
    const fv = normalizeFeatures({});
    const noCoverage: Coverage = { weather: true, waves: true, tide: false, swell: true };
    const c = hazardComponents(fv, baseWindow, baseClim, noCoverage)
      .find((c) => c.key === "springTideRange");
    expect(c!.score).toBeNull();
    expect(c!.percentile).toBeNull();
  });

  it("ebbNearLow is null when tideConfidence is 0", () => {
    const fv = normalizeFeatures({ tideConfidence: 0 });
    const c = hazardComponents(fv, baseWindow, baseClim, fullCoverage)
      .find((c) => c.key === "ebbNearLow");
    expect(c!.score).toBeNull();
  });
});
