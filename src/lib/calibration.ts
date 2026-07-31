// Pure climatological calibration module.
// No network, no DB, no external imports — suitable for unit tests.

export interface PercentileTable {
  metric: string;
  month: number;
  n: number;
  coverageStart: string;
  coverageEnd: string;
  /** 101 values; index i = i-th percentile, ascending. */
  ladder: number[];
}

export type Tier = "low" | "watch" | "warning" | "severe" | "unknown";

const MIN_SAMPLES = 100;

/**
 * Build a 101-point percentile ladder from raw samples.
 * Returns null if fewer than MIN_SAMPLES are provided.
 */
export function buildLadder(samples: number[]): number[] | null {
  if (samples.length < MIN_SAMPLES) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const ladder: number[] = [];
  for (let i = 0; i <= 100; i++) {
    const idx = Math.floor((i / 100) * (n - 1));
    ladder.push(sorted[idx]);
  }
  return ladder;
}

/**
 * Returns the fraction of climatology at or below `value` (0–1).
 * Returns null when the table is absent or the value is null — never returns 0 for missing data.
 */
export function percentileOf(value: number | null, t: PercentileTable | null): number | null {
  if (value == null || t == null) return null;
  const { ladder } = t;
  if (!ladder || ladder.length !== 101) return null;

  if (value <= ladder[0])   return 0;
  if (value >= ladder[100]) return 1;

  // Binary search for the bracket
  let lo = 0, hi = 100;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (ladder[mid] <= value) lo = mid; else hi = mid;
  }

  // Interpolate between lo and hi
  const range = ladder[hi] - ladder[lo];
  if (range === 0) return lo / 100;
  const frac = (value - ladder[lo]) / range;
  return (lo + frac) / 100;
}

/**
 * Tier thresholds: severe = top 5%, warning = top 20%, watch = top 30%.
 * A null percentile (missing data) returns "unknown".
 */
export function tierFromPercentile(p: number | null): Tier {
  if (p == null) return "unknown";
  if (p >= 0.95) return "severe";
  if (p >= 0.80) return "warning";
  if (p >= 0.70) return "watch";
  return "low";
}

export function buildClimMap(
  rows: Array<{ metric: string; n: number; coverage_start: unknown; coverage_end: unknown; ladder: unknown }>,
  month: number,
): Record<string, PercentileTable> {
  const result: Record<string, PercentileTable> = {};
  for (const row of rows) {
    const ladder = typeof row.ladder === "string" ? JSON.parse(row.ladder) : row.ladder;
    if (!Array.isArray(ladder) || ladder.length !== 101) continue;
    result[row.metric] = {
      metric: row.metric,
      month,
      n: row.n,
      coverageStart: row.coverage_start instanceof Date ? row.coverage_start.toISOString().slice(0, 10) : String(row.coverage_start ?? ""),
      coverageEnd:   row.coverage_end   instanceof Date ? row.coverage_end.toISOString().slice(0, 10)   : String(row.coverage_end   ?? ""),
      ladder,
    };
  }
  return result;
}
