import { describe, it, expect } from "vitest";
import { buildLadder, percentileOf, tierFromPercentile, type PercentileTable } from "./calibration";

describe("buildLadder", () => {
  it("returns null below 100 samples", () => {
    expect(buildLadder(Array.from({ length: 99 }, (_, i) => i))).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(buildLadder([])).toBeNull();
  });

  it("returns 101 values for 100+ samples", () => {
    const ladder = buildLadder(Array.from({ length: 100 }, (_, i) => i));
    expect(ladder).not.toBeNull();
    expect(ladder!.length).toBe(101);
  });

  it("ladder is non-decreasing", () => {
    const samples = Array.from({ length: 200 }, () => Math.random() * 10);
    const ladder = buildLadder(samples);
    for (let i = 1; i < ladder!.length; i++) {
      expect(ladder![i]).toBeGreaterThanOrEqual(ladder![i - 1]);
    }
  });

  it("ladder[0] is minimum and ladder[100] is maximum", () => {
    const samples = [1, 2, 3, ...Array.from({ length: 97 }, () => 5)];
    const ladder = buildLadder(samples)!;
    expect(ladder[0]).toBe(1);
    expect(ladder[100]).toBe(5);
  });
});

function makePerfectTable(n = 200): PercentileTable {
  const samples = Array.from({ length: n }, (_, i) => i);
  return {
    metric: "test",
    month: 7,
    n,
    coverageStart: "2000-01-01",
    coverageEnd: "2020-12-31",
    ladder: buildLadder(samples)!,
  };
}

describe("percentileOf", () => {
  it("returns null for null value", () => {
    expect(percentileOf(null, makePerfectTable())).toBeNull();
  });

  it("returns null for null table", () => {
    expect(percentileOf(5, null)).toBeNull();
  });

  it("returns 0 for value at or below minimum", () => {
    expect(percentileOf(-999, makePerfectTable())).toBe(0);
  });

  it("returns 1 for value at or above maximum", () => {
    expect(percentileOf(9999, makePerfectTable())).toBe(1);
  });

  it("returns ~0.5 for median value of uniform distribution", () => {
    const t = makePerfectTable(200);
    const p = percentileOf(100, t);
    expect(p).toBeGreaterThan(0.45);
    expect(p).toBeLessThan(0.55);
  });

  it("higher values yield higher percentiles", () => {
    const t = makePerfectTable();
    const p1 = percentileOf(50, t)!;
    const p2 = percentileOf(150, t)!;
    expect(p2).toBeGreaterThan(p1);
  });
});

describe("tierFromPercentile", () => {
  it("null → unknown", () => {
    expect(tierFromPercentile(null)).toBe("unknown");
  });

  it("≥0.98 → severe", () => {
    expect(tierFromPercentile(0.98)).toBe("severe");
    expect(tierFromPercentile(1.0)).toBe("severe");
  });

  it("≥0.90 and <0.98 → warning", () => {
    expect(tierFromPercentile(0.90)).toBe("warning");
    expect(tierFromPercentile(0.97)).toBe("warning");
  });

  it("≥0.75 and <0.90 → watch", () => {
    expect(tierFromPercentile(0.75)).toBe("watch");
    expect(tierFromPercentile(0.89)).toBe("watch");
  });

  it("<0.75 → low", () => {
    expect(tierFromPercentile(0.74)).toBe("low");
    expect(tierFromPercentile(0.0)).toBe("low");
  });
});
