import { describe, it, expect } from "vitest";
import {
  normalizeFeatures,
  fingerprint,
  score,
  alertLevel,
  matchAll,
  type ObsRow,
  type FeatureVector,
} from "./similarity";

describe("normalizeFeatures", () => {
  it("fills missing keys with 0", () => {
    const f = normalizeFeatures({});
    expect(f.meanWind).toBe(0);
    expect(f.maxWave).toBe(0);
  });

  it("passes through provided values", () => {
    const f = normalizeFeatures({ maxWave: 0.8, moonIllum: 0.5 });
    expect(f.maxWave).toBe(0.8);
    expect(f.moonIllum).toBe(0.5);
  });
});

describe("fingerprint", () => {
  const makeObs = (overrides: Partial<ObsRow> = {}): ObsRow => ({
    date: "2020-07-01",
    mean_wind_knots: 10,
    max_gust_knots: 20,
    wave_height_m: 1.5,
    rain_mm: 5,
    mslp_hpa: 1010,
    moon_illum: 0.8,
    tide_range_m: 3.5,
    wind_dir_deg: 225,
    ...overrides,
  });

  it("returns zeros for empty window", () => {
    const f = fingerprint([], 200);
    expect(f.maxWave).toBe(0);
  });

  it("computes onshore component correctly for head-on wind", () => {
    // beach bearing 225° (SW-facing), wind from SW (225°) → onshore
    const obs = [makeObs({ wind_dir_deg: 225 })];
    const f = fingerprint(obs, 225);
    expect(f.onshoreComponent).toBeCloseTo(1, 2);
  });

  it("sets offshore component to 0 (clamped)", () => {
    // wind from 45° (NE) into SW-facing beach → offshore
    const obs = [makeObs({ wind_dir_deg: 45 })];
    const f = fingerprint(obs, 225);
    expect(f.onshoreComponent).toBe(0);
  });

  it("computes pressure drop from multi-day window", () => {
    const window: ObsRow[] = [
      makeObs({ date: "2020-06-25", mslp_hpa: 1020 }),
      makeObs({ date: "2020-06-26", mslp_hpa: 1018 }),
      makeObs({ date: "2020-06-27", mslp_hpa: 1010 }),
    ];
    const f = fingerprint(window, 200);
    // pressure drop = 1020 - 1010 = 10 → normalised as 10/30
    expect(f.pressureDrop).toBeCloseTo(10 / 30, 3);
  });
});

describe("score", () => {
  const perfect: FeatureVector = {
    meanWind: 0.5, maxGust: 0.5, maxWave: 0.5, totalRain: 0.5,
    pressureDrop: 0.5, moonIllum: 0.5, tideRange: 0.5, onshoreComponent: 0.5,
  };

  it("identical vectors score 1.0", () => {
    expect(score(perfect, perfect)).toBeCloseTo(1.0, 3);
  });

  it("very different vectors score near 0", () => {
    const zero: FeatureVector = normalizeFeatures({});
    const high: FeatureVector = {
      meanWind: 1, maxGust: 1, maxWave: 1, totalRain: 1,
      pressureDrop: 1, moonIllum: 1, tideRange: 1, onshoreComponent: 1,
    };
    expect(score(zero, high)).toBeLessThan(0.15);
  });

  it("score is symmetric", () => {
    const a: FeatureVector = normalizeFeatures({ maxWave: 0.3 });
    const b: FeatureVector = normalizeFeatures({ maxWave: 0.6 });
    expect(score(a, b)).toBeCloseTo(score(b, a), 5);
  });
});

describe("alertLevel", () => {
  it("buckets correctly", () => {
    expect(alertLevel(0.9)).toBe("severe");
    expect(alertLevel(0.75)).toBe("warning");
    expect(alertLevel(0.6)).toBe("watch");
    expect(alertLevel(0.4)).toBe("none");
  });
});

describe("matchAll", () => {
  const fp = (id: number, wave: number) => ({
    incidentId: id,
    date: "2020-01-01",
    title: `Incident ${id}`,
    type: "rescue",
    severity: 2,
    features: normalizeFeatures({ maxWave: wave }),
  });

  it("returns results sorted by score descending", () => {
    const candidate = normalizeFeatures({ maxWave: 0.8 });
    const results = matchAll(candidate, [fp(1, 0.2), fp(2, 0.8), fp(3, 0.5)]);
    expect(results[0].incidentId).toBe(2);
    expect(results[results.length - 1].incidentId).toBe(1);
  });

  it("empty fingerprints returns empty results", () => {
    expect(matchAll(normalizeFeatures({}), [])).toEqual([]);
  });
});
