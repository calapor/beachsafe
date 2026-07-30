import { describe, it, expect } from "vitest";
import { fingerprint, BEACH_BEARING, type ObsRow } from "./similarity";
import { tideRangeForSlug } from "./forecast";

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

describe("BEACH_BEARING convention", () => {
  it("Fountainstown is 135° (SE-facing — onshore from SE/E)", () => {
    expect(BEACH_BEARING["fountainstown"]).toBe(135);
  });

  it("directly onshore wind (135°) at Fountainstown gives component ≈ 1", () => {
    const direct = fingerprint([makeObs({ wind_dir_deg: 135 })], BEACH_BEARING["fountainstown"]);
    expect(direct.onshoreComponent).toBeCloseTo(1, 2);
  });

  it("Ballybunion is 270° (W-facing — onshore from W)", () => {
    expect(BEACH_BEARING["ballybunion"]).toBe(270);
  });

  it("Skerries is 90° (E-facing — onshore from E)", () => {
    expect(BEACH_BEARING["skerries"]).toBe(90);
  });

  it("directly offshore wind gives 0 onshore component (clamped)", () => {
    // Offshore from Ballybunion is 90° (E) — 90° vs bearing 270° = 180° diff
    const fv = fingerprint([makeObs({ wind_dir_deg: 90 })], 270);
    expect(fv.onshoreComponent).toBe(0);
  });
});

describe("8-row window gives non-zero meanWind and pressureDrop", () => {
  it("meanWind is non-zero with 7 prior rows", () => {
    const prior = Array.from({ length: 7 }, (_, i) => makeObs({
      date: `2020-06-${24 + i}`,
      mean_wind_knots: 15 + i,
      mslp_hpa: 1020 - i,
    }));
    const today = makeObs({ date: "2020-07-01", mslp_hpa: 1010 });
    const window = [...prior, today];
    const fv = fingerprint(window, 270);
    expect(fv.meanWind).toBeGreaterThan(0);
    expect(fv.pressureDrop).toBeGreaterThan(0);
  });

  it("single-row window gives zero meanWind (the old bug)", () => {
    const fv = fingerprint([makeObs()], 270);
    // prior = window.slice(0, -1) = [] → meanWind = 0/1 = 0
    expect(fv.meanWind).toBe(0);
  });
});

describe("tideRangeForSlug", () => {
  it("returns spring range near new/full moon (phase ≈ 0)", () => {
    const range = tideRangeForSlug("ballybunion", 0.0);
    expect(range).toBe(5.0);
  });

  it("returns neap range near quarter moon (phase ≈ 0.25)", () => {
    const range = tideRangeForSlug("ballybunion", 0.25);
    expect(range).toBe(2.6);
  });

  it("returns spring range near full moon (phase ≈ 0.5)", () => {
    const range = tideRangeForSlug("fountainstown", 0.5);
    expect(range).toBe(3.8);
  });

  it("falls back to defaults for unknown slug", () => {
    const range = tideRangeForSlug("unknown-beach", 0.0);
    expect(range).toBe(3.5);
  });
});
