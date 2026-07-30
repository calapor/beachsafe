/**
 * Gate 1 acceptance test: replay every day 2005–2026 per beach through the
 * calibrated tier path and print realized tier frequencies.
 *
 * Target:
 *   severe  2%   [0.5–4%]
 *   warning 8%   [4–14%]
 *   watch   15%  [8–24%]
 *   low     75%  [≥60%]
 *
 * Compare against old baseline (92.4 / 75.6 / 99.8% severe from the fingerprint path).
 */
import { neon } from "@neondatabase/serverless";
import { tierFromPercentile, percentileOf, type PercentileTable } from "../../src/lib/calibration";

const sql = neon(process.env.DATABASE_URL!);

// Combine several metrics into a single hazard proxy for the replay.
// This mirrors the hazard index: average the non-null percentiles.
function replayTier(obs: Record<string, number | null>, clim: Record<string, PercentileTable>): string {
  const scores: number[] = [];

  for (const [metric, clTable] of Object.entries(clim)) {
    const val = obs[metric] ?? null;
    const p = percentileOf(val, clTable);
    if (p != null) scores.push(p);
  }

  if (scores.length === 0) return "unknown";
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return tierFromPercentile(mean);
}

interface BeachRow { id: number; slug: string; }

async function main() {
  const beaches = await sql`SELECT id, slug FROM beaches ORDER BY id` as BeachRow[];

  const TARGETS = { severe: [0.005, 0.04], warning: [0.04, 0.14], watch: [0.08, 0.24], low: [0.6, 1.0] };

  let allPass = true;

  for (const beach of beaches) {
    console.log(`\n=== ${beach.slug} ===`);

    // Fetch all climatology for this beach
    const climRows = await sql`
      SELECT metric, month, n, coverage_start, coverage_end, ladder
      FROM climatology
      WHERE beach_id = ${beach.id}
    ` as Array<{ metric: string; month: number; n: number; coverage_start: string; coverage_end: string; ladder: unknown }>;

    if (!climRows.length) {
      console.log("  No climatology — run build-climatology.ts first");
      continue;
    }

    // Index by month → metric → PercentileTable
    const climByMonth: Record<number, Record<string, PercentileTable>> = {};
    for (const row of climRows) {
      if (!climByMonth[row.month]) climByMonth[row.month] = {};
      const ladder = typeof row.ladder === "string" ? JSON.parse(row.ladder) : row.ladder;
      if (Array.isArray(ladder) && ladder.length === 101) {
        climByMonth[row.month][row.metric] = {
          metric: row.metric,
          month: row.month,
          n: row.n,
          coverageStart: String(row.coverage_start ?? ""),
          coverageEnd:   String(row.coverage_end ?? ""),
          ladder,
        };
      }
    }

    // Fetch all daily observations 2005–2026
    const obs = await sql`
      SELECT date::text AS date,
        EXTRACT(month FROM date)::int AS month,
        wave_height_m, tide_range_m, mean_wind_knots,
        max_gust_knots, sea_temp_c, temp_max_c
      FROM observations
      WHERE beach_id = ${beach.id}
        AND date >= '2005-01-01' AND date <= '2026-12-31'
      ORDER BY date
    ` as Array<{ date: string; month: number; wave_height_m?: number | null; tide_range_m?: number | null; mean_wind_knots?: number | null; max_gust_knots?: number | null; sea_temp_c?: number | null; temp_max_c?: number | null }>;

    if (!obs.length) {
      console.log("  No observations in 2005–2026");
      continue;
    }

    const counts: Record<string, number> = { severe: 0, warning: 0, watch: 0, low: 0, unknown: 0 };

    for (const row of obs) {
      const month = row.month;
      const clim = climByMonth[month] ?? {};
      const obsMap: Record<string, number | null> = {
        wave_height_m:   row.wave_height_m  ?? null,
        tide_range_m:    row.tide_range_m   ?? null,
        mean_wind_knots: row.mean_wind_knots ?? null,
        max_gust_knots:  row.max_gust_knots ?? null,
        sea_temp_c:      row.sea_temp_c     ?? null,
        temp_max_c:      row.temp_max_c     ?? null,
      };
      const tier = replayTier(obsMap, clim);
      counts[tier] = (counts[tier] ?? 0) + 1;
    }

    const total = obs.length;
    console.log(`  Total days: ${total}`);

    let beachPass = true;
    for (const tier of ["severe", "warning", "watch", "low"] as const) {
      const freq = (counts[tier] ?? 0) / total;
      const [lo, hi] = TARGETS[tier];
      const pass = freq >= lo && freq <= hi;
      if (!pass) beachPass = false;
      console.log(`  ${tier.padEnd(8)} ${(freq * 100).toFixed(1)}%  target [${(lo*100).toFixed(0)}–${(hi*100).toFixed(0)}%]  ${pass ? "✓" : "✗ FAIL"}`);
    }
    if (counts.unknown) {
      console.log(`  unknown  ${((counts.unknown / total) * 100).toFixed(1)}% (insufficient data)`);
    }

    if (!beachPass) allPass = false;
  }

  console.log(`\n${allPass ? "ALL BEACHES PASS — Stage 1 gate met." : "SOME BEACHES FAIL — review climatology and hazard weights."}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
