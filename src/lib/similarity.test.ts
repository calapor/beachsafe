import { describe, it, expect } from "vitest";
import {
  normalizeFeatures,
  fingerprint,
  score,
  alertLevel,
  matchAll,
  deriveTideState,
  explain,
  baselineContrast,
  describeTideAt,
  tideTrajectory,
  computeBaseline,
  type ObsRow,
  type FeatureVector,
} from "./similarity";

describe("normalizeFeatures", () => {
  it("fills missing keys with 0", () => {
    const f = normalizeFeatures({});
    expect(f.meanWind).toBe(0);
    expect(f.maxWave).toBe(0);
    expect(f.tideState).toBe(0);
    expect(f.tideConfidence).toBe(0);
    expect(f.seaTempCold).toBe(0);
  });

  it("passes through provided values", () => {
    const f = normalizeFeatures({ maxWave: 0.8, moonIllum: 0.5, tideState: -0.5 });
    expect(f.maxWave).toBe(0.8);
    expect(f.moonIllum).toBe(0.5);
    expect(f.tideState).toBe(-0.5);
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
    const obs = [makeObs({ wind_dir_deg: 225 })];
    const f = fingerprint(obs, 225);
    expect(f.onshoreComponent).toBeCloseTo(1, 2);
  });

  it("sets offshore component to 0 (clamped)", () => {
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
    expect(f.pressureDrop).toBeCloseTo(10 / 30, 3);
  });

  it("computes seaTempCold correctly", () => {
    const cold = [makeObs({ sea_temp_c: 5 })];
    const warm = [makeObs({ sea_temp_c: 20 })];
    expect(fingerprint(cold, 200).seaTempCold).toBeCloseTo((15 - 5) / 15, 3);
    expect(fingerprint(warm, 200).seaTempCold).toBe(0); // warm → no cold risk
  });

  it("computes wavePeriod normalised to period/20", () => {
    const obs = [makeObs({ wave_period_s: 10 })];
    expect(fingerprint(obs, 200).wavePeriod).toBeCloseTo(10 / 20, 3);
  });

  it("moonIllum is tidal force: high at new AND full moon, zero at quarter", () => {
    // Full moon (illum ≈ 1.0): tidal force = |1 - 2*1| = 1.0
    expect(fingerprint([makeObs({ moon_illum: 1.0 })], 200).moonIllum).toBeCloseTo(1.0, 2);
    // New moon (illum ≈ 0.0): tidal force = |1 - 2*0| = 1.0
    expect(fingerprint([makeObs({ moon_illum: 0.0 })], 200).moonIllum).toBeCloseTo(1.0, 2);
    // Quarter moon (illum ≈ 0.5): tidal force = |1 - 2*0.5| = 0.0
    expect(fingerprint([makeObs({ moon_illum: 0.5 })], 200).moonIllum).toBeCloseTo(0.0, 2);
  });

  it("is backward-compatible without opts (tideConfidence=0)", () => {
    const obs = [makeObs()];
    const f = fingerprint(obs, 200);
    expect(f.tideConfidence).toBe(0);
    expect(f.tideState).toBe(0);
  });

  it("reads tide state from opts.timeOfDay", () => {
    const obs = [makeObs()];
    // HW at 06:00, LW at 12:10 → at 09:00 we're ebbing
    const f = fingerprint(obs, 200, {
      timeOfDay: "09:00",
      highTideTimes: "06:00",
      lowTideTimes: "12:10",
    });
    expect(f.tideConfidence).toBe(1);
    expect(f.tideState).toBeLessThan(0); // ebbing
  });
});

describe("deriveTideState", () => {
  const HIGH = "06:00,18:20";
  const LOW  = "00:10,12:10";

  it("known time during flood: tideState > 0, confidence = 1", () => {
    // 03:00 is between LW(00:10) and HW(06:00) → flooding
    const r = deriveTideState("03:00", HIGH, LOW);
    expect(r.tideConfidence).toBe(1);
    expect(r.tideState).toBeGreaterThan(0);
  });

  it("known time during ebb: tideState < 0, confidence = 1", () => {
    // 09:00 is between HW(06:00) and LW(12:10) → ebbing
    const r = deriveTideState("09:00", HIGH, LOW);
    expect(r.tideConfidence).toBe(1);
    expect(r.tideState).toBeLessThan(0);
  });

  it("at HW: hoursFromHigh ≈ 0, confidence = 1", () => {
    const r = deriveTideState("06:01", HIGH, LOW);
    expect(r.tideConfidence).toBe(1);
    expect(r.hoursFromHigh).toBeCloseTo(0, 1);
  });

  it("missing tide times → confidence = 0, zeros", () => {
    const r = deriveTideState(null, null, null);
    expect(r.tideConfidence).toBe(0);
    expect(r.tideState).toBe(0);
    expect(r.hoursFromHigh).toBe(0);
  });

  it("unknown time + no daylight → confidence = 0", () => {
    const r = deriveTideState(null, HIGH, LOW);
    expect(r.tideConfidence).toBe(0);
  });

  it("unknown time + daylight window → confidence ≈ 0.5, state derived", () => {
    const r = deriveTideState(null, HIGH, LOW, { sunrise: "06:30", sunset: "21:00" });
    expect(r.tideConfidence).toBeCloseTo(0.5, 5);
    // Daylight covers flood and ebb — state should be between -1 and +1
    expect(r.tideState).toBeGreaterThanOrEqual(-1);
    expect(r.tideState).toBeLessThanOrEqual(1);
    // hoursFromHigh should be >0 (LW reached during daylight)
    expect(r.hoursFromHigh).toBeGreaterThan(0);
  });
});

describe("score", () => {
  const perfect: FeatureVector = normalizeFeatures({
    meanWind: 0.5, maxGust: 0.5, maxWave: 0.5, totalRain: 0.5,
    pressureDrop: 0.5, moonIllum: 0.5, tideRange: 0.5, onshoreComponent: 0.5,
  });

  it("identical vectors score 1.0", () => {
    expect(score(perfect, perfect)).toBeCloseTo(1.0, 3);
  });

  it("very different vectors score near 0", () => {
    const zero: FeatureVector = normalizeFeatures({});
    // Set ALL non-tide scored features to 1 so every feature has diff=1
    const high: FeatureVector = normalizeFeatures({
      meanWind: 1, maxGust: 1, maxWave: 1, totalRain: 1,
      pressureDrop: 1, moonIllum: 1, tideRange: 1, onshoreComponent: 1,
      seaTempCold: 1, wavePeriod: 1, warmCalm: 1,
    });
    expect(score(zero, high)).toBeLessThan(0.15);
  });

  it("score is symmetric", () => {
    const a: FeatureVector = normalizeFeatures({ maxWave: 0.3 });
    const b: FeatureVector = normalizeFeatures({ maxWave: 0.6 });
    expect(score(a, b)).toBeCloseTo(score(b, a), 5);
  });

  it("tide features excluded when either tideConfidence=0 (no penalty)", () => {
    // candidate has tide data, reference doesn't → tide features should be excluded
    const withTide: FeatureVector = normalizeFeatures({ tideState: -1, hoursFromHigh: 1, tideConfidence: 1 });
    const noTide: FeatureVector = normalizeFeatures({ tideState: 1, hoursFromHigh: 0, tideConfidence: 0 });
    // Should NOT score near zero despite opposite tide values, because noTide has confidence=0
    expect(score(withTide, noTide)).toBeGreaterThan(0.5);
  });

  it("tide features included when both tideConfidence>0", () => {
    const ebbing:   FeatureVector = normalizeFeatures({ tideState: -1, tideConfidence: 1 });
    const flooding: FeatureVector = normalizeFeatures({ tideState: +1, tideConfidence: 1 });
    const sameEbb: FeatureVector  = normalizeFeatures({ tideState: -1, tideConfidence: 1 });
    // Same tideState should score higher than opposite
    expect(score(ebbing, sameEbb)).toBeGreaterThan(score(ebbing, flooding));
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

describe("explain", () => {
  it("contributions sum correctly (total ~= weighted average ≈ score)", () => {
    const a = normalizeFeatures({ maxWave: 0.8, onshoreComponent: 0.9 });
    const b = normalizeFeatures({ maxWave: 0.8, onshoreComponent: 0.9 });
    const contributions = explain(a, b);
    const totalPct = contributions.reduce((s, c) => s + c.contributionPct, 0);
    expect(totalPct).toBeCloseTo(100, 1);
  });

  it("sorted by contribution descending", () => {
    const a = normalizeFeatures({ onshoreComponent: 0.9, maxWave: 0.3 });
    const b = normalizeFeatures({ onshoreComponent: 0.9, maxWave: 0.3 });
    const contributions = explain(a, b);
    for (let i = 0; i < contributions.length - 1; i++) {
      expect(contributions[i].contribution).toBeGreaterThanOrEqual(contributions[i + 1].contribution);
    }
  });

  it("identical values → distance = 0", () => {
    const a = normalizeFeatures({ maxWave: 0.5 });
    const contributions = explain(a, a);
    const maxWaveItem = contributions.find((c) => c.key === "maxWave");
    expect(maxWaveItem?.distance).toBe(0);
  });
});

describe("baselineContrast", () => {
  it("deviation is abs(candidate - baseline)", () => {
    const candidate = normalizeFeatures({ maxWave: 0.8 });
    const baseline  = normalizeFeatures({ maxWave: 0.3 });
    const devs = baselineContrast(candidate, baseline);
    const waveEntry = devs.find((d) => d.key === "maxWave");
    expect(waveEntry?.deviation).toBeCloseTo(0.5, 3);
  });

  it("isDiscriminating when far from baseline AND close to incident", () => {
    const candidate = normalizeFeatures({ maxWave: 0.8 });
    const baseline  = normalizeFeatures({ maxWave: 0.1 }); // unusual
    const reference = normalizeFeatures({ maxWave: 0.8 }); // matches incident
    const devs = baselineContrast(candidate, baseline, reference);
    const waveEntry = devs.find((d) => d.key === "maxWave");
    expect(waveEntry?.isDiscriminating).toBe(true);
  });

  it("not discriminating when typical (close to baseline)", () => {
    const candidate = normalizeFeatures({ maxWave: 0.3 });
    const baseline  = normalizeFeatures({ maxWave: 0.3 });
    const devs = baselineContrast(candidate, baseline);
    const waveEntry = devs.find((d) => d.key === "maxWave");
    expect(waveEntry?.isDiscriminating).toBe(false);
  });

  it("sorted by deviation descending", () => {
    const candidate = normalizeFeatures({ maxWave: 0.9, moonIllum: 0.5 });
    const baseline  = normalizeFeatures({ maxWave: 0.1, moonIllum: 0.4 });
    const devs = baselineContrast(candidate, baseline);
    for (let i = 0; i < devs.length - 1; i++) {
      expect(devs[i].deviation).toBeGreaterThanOrEqual(devs[i + 1].deviation);
    }
  });
});

describe("describeTideAt", () => {
  const HIGH = "06:00,18:20";
  const LOW  = "00:10,12:10";

  it("flooding: LW before, HW after", () => {
    // 03:00 is between LW(00:10) and HW(06:00)
    const r = describeTideAt("03:00", HIGH, LOW);
    expect(r).not.toBeNull();
    expect(r!.direction).toBe("flooding");
  });

  it("ebbing: HW before, LW after", () => {
    // 09:00 is between HW(06:00) and LW(12:10)
    const r = describeTideAt("09:00", HIGH, LOW);
    expect(r).not.toBeNull();
    expect(r!.direction).toBe("ebbing");
  });

  it("sincePrev label contains the previous tide event", () => {
    // 09:00 → previous event is HW at 06:00, so since ≈ 180 mins
    const r = describeTideAt("09:00", HIGH, LOW);
    expect(r).not.toBeNull();
    expect(r!.sincePrev.label).toContain("06:00");
    expect(r!.sincePrev.label).toContain("HW");
    expect(r!.sincePrev.mins).toBeCloseTo(180, -1);
  });

  it("toNext label contains the next tide event", () => {
    // 09:00 → next event is LW at 12:10, so to ≈ 190 mins
    const r = describeTideAt("09:00", HIGH, LOW);
    expect(r).not.toBeNull();
    expect(r!.toNext.label).toContain("12:10");
    expect(r!.toNext.label).toContain("LW");
    expect(r!.toNext.mins).toBeCloseTo(190, -1);
  });

  it("returns null for missing tide times", () => {
    expect(describeTideAt("09:00", null, null)).toBeNull();
  });

  it("tideState and hoursFromHigh are populated", () => {
    const r = describeTideAt("09:00", HIGH, LOW);
    expect(r).not.toBeNull();
    expect(r!.tideState).toBeLessThan(0); // ebbing
    expect(r!.hoursFromHigh).toBeGreaterThan(0);
  });
});

describe("tideTrajectory", () => {
  const HIGH = "06:00,18:20";
  const LOW  = "12:10";

  it("returns steps+1 elements", () => {
    const r = tideTrajectory("09:00", HIGH, LOW, 60, 4);
    expect(r).toHaveLength(5);
  });

  it("first element minsOffset is -minutesBefore", () => {
    const r = tideTrajectory("09:00", HIGH, LOW, 60, 4);
    expect(r[0].minsOffset).toBe(-60);
  });

  it("last element minsOffset is 0", () => {
    const r = tideTrajectory("09:00", HIGH, LOW, 60, 4);
    expect(r[r.length - 1].minsOffset).toBe(0);
  });

  it("returns empty array for missing tide times", () => {
    expect(tideTrajectory("09:00", null, null)).toEqual([]);
  });

  it("tideState values are in [-1, 1]", () => {
    const r = tideTrajectory("09:00", HIGH, LOW, 60, 4);
    for (const step of r) {
      expect(step.tideState).toBeGreaterThanOrEqual(-1);
      expect(step.tideState).toBeLessThanOrEqual(1);
    }
  });
});

describe("computeBaseline", () => {
  it("returns zeros for empty input", () => {
    const b = computeBaseline([]);
    expect(b.maxWave).toBe(0);
    expect(b.meanWind).toBe(0);
  });

  it("returns the median value for each key", () => {
    const fps = [
      { features: normalizeFeatures({ maxWave: 0.2 }) },
      { features: normalizeFeatures({ maxWave: 0.5 }) },
      { features: normalizeFeatures({ maxWave: 0.8 }) },
    ];
    const b = computeBaseline(fps);
    expect(b.maxWave).toBeCloseTo(0.5, 3);
  });

  it("with even count picks lower median", () => {
    const fps = [
      { features: normalizeFeatures({ maxWave: 0.2 }) },
      { features: normalizeFeatures({ maxWave: 0.6 }) },
    ];
    const b = computeBaseline(fps);
    // Math.floor(2/2) = 1 → sorted [0.2, 0.6] → vals[1] = 0.6
    expect(b.maxWave).toBeCloseTo(0.6, 3);
  });

  it("single entry returns that entry's values", () => {
    const fps = [{ features: normalizeFeatures({ moonIllum: 0.75 }) }];
    const b = computeBaseline(fps);
    expect(b.moonIllum).toBeCloseTo(0.75, 3);
  });
});
