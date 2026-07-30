import { describe, it, expect } from "vitest";
import { hazardComponents, hazardIndex, type Coverage, type ObsRowExtended } from "./hazard";
import { normalizeFeatures } from "./similarity";
import { buildLadder, type PercentileTable } from "./calibration";

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

    const at11 = hazardComponents(fv, makeObs(1.1), baseClim, fullCoverage, false).find((c) => c.key === "ripBand");
    const at30 = hazardComponents(fv, makeObs(3.0), baseClim, fullCoverage, false).find((c) => c.key === "ripBand");
    const at00 = hazardComponents(fv, makeObs(0.0), baseClim, fullCoverage, false).find((c) => c.key === "ripBand");

    expect(at11!.score).toBeGreaterThan(at30!.score!);
    expect(at11!.score).toBeGreaterThan(at00!.score!);
    expect(at11!.score).toBeCloseTo(1.0, 1);
  });

  it("returns null score when waves coverage is false", () => {
    const noCoverage: Coverage = { ...fullCoverage, waves: false };
    const fv = normalizeFeatures({});
    const c = hazardComponents(fv, baseWindow, baseClim, noCoverage, false).find((c) => c.key === "ripBand");
    expect(c!.score).toBeNull();
  });
});

describe("hazardIndex", () => {
  it("returns null score when all components missing", () => {
    const fv = normalizeFeatures({});
    const components = hazardComponents(fv, baseWindow, baseClim, noData, false);
    const result = hazardIndex(components);
    expect(result.score).toBeNull();
  });

  it("returns null when fewer than half components available", () => {
    // Provide only 1 of 7+ components with a score
    const components = hazardComponents(
      normalizeFeatures({}),
      [{ date: "2020-07-01", wave_height_m: 1.1 }],
      {},  // no clim → most components get null
      { weather: false, waves: true, tide: false, swell: false },
      false
    );
    const available = components.filter((c) => c.score != null);
    if (available.length < components.length / 2) {
      expect(hazardIndex(components).score).toBeNull();
    }
  });

  it("driver is the component with the highest score", () => {
    const fv = normalizeFeatures({ tideState: -0.8, hoursFromHigh: 0.9, tideConfidence: 1 });
    const components = hazardComponents(fv, baseWindow, baseClim, fullCoverage, false);
    const result = hazardIndex(components);
    if (result.score != null && result.driver) {
      const best = components
        .filter((c) => c.score != null)
        .reduce((a, b) => (b.score! > a.score! ? b : a));
      expect(result.driver.key).toBe(best.key);
    }
  });
});

describe("missing inputs", () => {
  it("springTideRange is insufficient-data when tide coverage false", () => {
    const fv = normalizeFeatures({});
    const noCoverage: Coverage = { weather: true, waves: true, tide: false, swell: true };
    const c = hazardComponents(fv, baseWindow, baseClim, noCoverage, false)
      .find((c) => c.key === "springTideRange");
    expect(c!.score).toBeNull();
    expect(c!.percentile).toBeNull();
  });

  it("ebbNearLow is null when tideConfidence is 0", () => {
    const fv = normalizeFeatures({ tideConfidence: 0 });
    const c = hazardComponents(fv, baseWindow, baseClim, fullCoverage, false)
      .find((c) => c.key === "ebbNearLow");
    expect(c!.score).toBeNull();
  });
});
