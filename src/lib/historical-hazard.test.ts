import { describe, it, expect } from "vitest";
import { buildLadder, percentileOf, tierFromPercentile } from "./calibration";
import type { PercentileTable } from "./calibration";

// Simulates the annual combined_score distribution built from real observations.
// Historically the raw combined score ranges 0–0.657 across 83 k beach-days.
function makeAnnualTable(maxScore: number, n = 1000): PercentileTable {
  const samples = Array.from({ length: n }, (_, i) => (i / (n - 1)) * maxScore);
  return {
    metric: "combined_score", month: 0, n,
    coverageStart: "1950-01-01", coverageEnd: "2026-07-22",
    ladder: buildLadder(samples)!,
  };
}

describe("historical-hazard calibration regression", () => {
  const annualTable = makeAnnualTable(0.657);

  it("the old path (raw mean treated as percentile) could never exceed watch threshold", () => {
    // Defect 1: the pre-fix code passed hazardIndex().percentile (which is the arithmetic
    // mean of component scores, max 0.657) directly to tierFromPercentile, which needs
    // ≥0.75 to leave "low". So no day in 76 years could ever escape "low".
    expect(tierFromPercentile(0.657)).toBe("low");
    expect(tierFromPercentile(0.566)).toBe("low"); // Skerries 2010-07-31 drowning
    expect(tierFromPercentile(0.588)).toBe("low"); // ballybunion max
  });

  it("a high combined score ranks above low via the annual ladder", () => {
    // In a uniform 0–0.657 distribution, 0.566 is at the ~86th percentile → "watch".
    // The point: the same value treated as a raw pseudo-percentile gives "low"
    // (0.566 < 0.75 watch threshold); routed through the annual ladder it escapes "low".
    const pct = percentileOf(0.566, annualTable);
    expect(pct).not.toBeNull();
    expect(pct!).toBeGreaterThan(0.75); // at least watch territory
    expect(tierFromPercentile(pct)).not.toBe("low");
  });

  it("a median combined score tiers low via the annual ladder", () => {
    // p50 of the distribution is maxScore/2 = 0.328
    const pct = percentileOf(0.328, annualTable);
    expect(pct).not.toBeNull();
    expect(pct!).toBeCloseTo(0.5, 1);
    expect(tierFromPercentile(pct)).toBe("low");
  });

  it("tierFromPercentile(null) returns unknown, not low", () => {
    // When no annual ladder exists (pre-ETL state), we should get unknown, not silently low.
    expect(tierFromPercentile(percentileOf(0.5, null))).toBe("unknown");
  });
});
