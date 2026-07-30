/**
 * Builds per-beach, per-month climatology tables from historical observations,
 * then adds annual score ladders (month=0) for combined_score, hazard_score,
 * and exposure_score via a second pass through scoreDay().
 *
 * Metrics: all raw observation columns used by hazard components.
 */
import { neon } from "@neondatabase/serverless";
import { buildLadder, type PercentileTable } from "../../src/lib/calibration";
import { scoreDay } from "../../src/lib/risk";
import type { ObsRowExtended, Coverage } from "../../src/lib/hazard";
import { BEACH_BEARING } from "../../src/lib/similarity";

const sql = neon(process.env.DATABASE_URL!);

const METRICS: Array<{ key: string; col: string }> = [
  { key: "wave_height_m",    col: "wave_height_m" },
  { key: "swell_height_m",   col: "swell_height_m" },
  { key: "swell_period_s",   col: "swell_period_s" },
  { key: "tide_range_m",     col: "tide_range_m" },
  { key: "max_gust_knots",   col: "max_gust_knots" },
  { key: "mean_wind_knots",  col: "mean_wind_knots" },
  { key: "temp_max_c",       col: "temp_max_c" },
  { key: "rain_mm",          col: "rain_mm" },
  { key: "sea_temp_c",       col: "sea_temp_c" },
  { key: "mslp_hpa",         col: "mslp_hpa" },
];

async function buildPerMonthClimatology(beachId: number) {
  for (const { key, col } of METRICS) {
    for (let month = 1; month <= 12; month++) {
      const rows = await sql.query(
        `SELECT ${col} AS val, date::text AS date
         FROM observations
         WHERE beach_id = $1
           AND EXTRACT(month FROM date) = $2
           AND ${col} IS NOT NULL
         ORDER BY date`,
        [beachId, month]
      ) as Array<{ val: unknown; date: string }>;

      const samples = rows.map((r) => Number(r.val)).filter((v) => isFinite(v));
      const ladder = buildLadder(samples);
      if (!ladder) {
        console.log(`  beach=${beachId} month=${month} metric=${key}: only ${samples.length} samples (<100) — skipping`);
        continue;
      }

      const dates = rows.map((r) => r.date).sort();
      const coverageStart = dates[0];
      const coverageEnd   = dates[dates.length - 1];

      await sql`
        INSERT INTO climatology (beach_id, month, metric, n, coverage_start, coverage_end, ladder, computed_at)
        VALUES (${beachId}, ${month}, ${key}, ${samples.length}, ${coverageStart}::date, ${coverageEnd}::date, ${JSON.stringify(ladder)}, NOW())
        ON CONFLICT (beach_id, month, metric) DO UPDATE SET
          n              = EXCLUDED.n,
          coverage_start = EXCLUDED.coverage_start,
          coverage_end   = EXCLUDED.coverage_end,
          ladder         = EXCLUDED.ladder,
          computed_at    = EXCLUDED.computed_at
      `;

      console.log(`  beach=${beachId} month=${month} metric=${key}: n=${samples.length} (${coverageStart} → ${coverageEnd})`);
    }
  }
}

// Index per-month clim rows into a month → metric → PercentileTable map.
function buildClimMap(
  rows: Array<{ metric: string; month: number; n: number; coverage_start: unknown; coverage_end: unknown; ladder: unknown }>,
): Record<number, Record<string, PercentileTable>> {
  const result: Record<number, Record<string, PercentileTable>> = {};
  for (const row of rows) {
    const ladder = typeof row.ladder === "string" ? JSON.parse(row.ladder) : row.ladder;
    if (!Array.isArray(ladder) || ladder.length !== 101) continue;
    if (!result[row.month]) result[row.month] = {};
    result[row.month][row.metric] = {
      metric: row.metric,
      month: row.month,
      n: row.n,
      coverageStart: String(row.coverage_start ?? ""),
      coverageEnd:   String(row.coverage_end ?? ""),
      ladder,
    };
  }
  return result;
}

async function buildAnnualScoreLadders(beach: { id: number; slug: string }) {
  console.log(`  Building annual score ladders for ${beach.slug}...`);

  // Fetch ALL observations with a 7-day rolling window each
  const allObsRaw = await sql.query(
    `SELECT date::text AS date,
            mean_wind_knots, max_gust_knots, wave_height_m, wave_period_s,
            sea_temp_c, rain_mm, mslp_hpa, moon_illum, tide_range_m,
            wind_dir_deg, temp_max_c,
            swell_height_m, swell_period_s,
            high_tide_times, low_tide_times
     FROM observations
     WHERE beach_id = $1
     ORDER BY date ASC`,
    [beach.id]
  ) as Array<ObsRowExtended & { date: string }>;

  if (allObsRaw.length < 100) {
    console.log(`  Skipping annual ladder for ${beach.slug}: only ${allObsRaw.length} observations`);
    return;
  }

  // Pre-load all per-month climatology to avoid N+1 queries in the inner loop
  const allClimRaw = await sql.query(
    `SELECT metric, month::int AS month, n, coverage_start, coverage_end, ladder
     FROM climatology
     WHERE beach_id = $1 AND month >= 1 AND month <= 12`,
    [beach.id]
  ) as Array<{ metric: string; month: number; n: number; coverage_start: unknown; coverage_end: unknown; ladder: unknown }>;
  const climByMonth = buildClimMap(allClimRaw);

  const bearing = BEACH_BEARING[beach.slug] ?? 270;
  const combinedScores: number[] = [];
  const hazardScores:   number[] = [];
  const exposureScores: number[] = [];
  const scoreDates:     string[] = [];

  for (let i = 0; i < allObsRaw.length; i++) {
    const obs = allObsRaw[i];
    const dateStr = obs.date;

    // 7-day prior window + day-of (indices i-7..i)
    const windowStart = Math.max(0, i - 7);
    const window = allObsRaw.slice(windowStart, i + 1) as ObsRowExtended[];

    const d = new Date(dateStr + "T12:00:00Z");
    const calendar = {
      year:      d.getUTCFullYear(),
      month:     d.getUTCMonth() + 1,
      day:       d.getUTCDate(),
      dayOfWeek: d.getUTCDay(),
    };

    const clim: Record<string, PercentileTable | null> = Object.fromEntries(
      Object.entries(climByMonth[calendar.month] ?? {}).map(([k, v]) => [k, v]),
    );

    const coverage: Coverage = {
      weather: obs.mean_wind_knots != null || obs.max_gust_knots != null,
      waves:   obs.wave_height_m != null,
      tide:    obs.high_tide_times != null || obs.low_tide_times != null,
      swell:   obs.swell_period_s != null,
    };

    const day = scoreDay(window, bearing, clim, coverage, calendar);

    if (day.combined != null) { combinedScores.push(day.combined); scoreDates.push(dateStr); }
    if (day.hazard.score != null) hazardScores.push(day.hazard.score);
    if (day.exposure.score != null) exposureScores.push(day.exposure.score);
  }

  const coverageStart = scoreDates[0];
  const coverageEnd   = scoreDates[scoreDates.length - 1];

  for (const [metric, samples] of [
    ["combined_score", combinedScores] as const,
    ["hazard_score",   hazardScores]   as const,
    ["exposure_score", exposureScores] as const,
  ]) {
    const ladder = buildLadder(samples);
    if (!ladder) {
      console.log(`  Annual ${metric} for ${beach.slug}: only ${samples.length} samples (<100) — skipping`);
      continue;
    }
    await sql`
      INSERT INTO climatology (beach_id, month, metric, n, coverage_start, coverage_end, ladder, computed_at)
      VALUES (${beach.id}, 0, ${metric}, ${samples.length}, ${coverageStart}::date, ${coverageEnd}::date, ${JSON.stringify(ladder)}, NOW())
      ON CONFLICT (beach_id, month, metric) DO UPDATE SET
        n              = EXCLUDED.n,
        coverage_start = EXCLUDED.coverage_start,
        coverage_end   = EXCLUDED.coverage_end,
        ladder         = EXCLUDED.ladder,
        computed_at    = EXCLUDED.computed_at
    `;
    console.log(`  Annual ${metric} for ${beach.slug}: n=${samples.length} (${coverageStart} → ${coverageEnd})`);
  }
}

async function main() {
  const beaches = await sql`SELECT id, slug FROM beaches ORDER BY id` as Array<{ id: number; slug: string }>;

  // Pass 1: per-month raw metric ladders (must run before pass 2)
  for (const beach of beaches) {
    console.log(`\nBuilding per-month climatology for ${beach.slug} (id=${beach.id})`);
    await buildPerMonthClimatology(beach.id);
  }

  // Pass 2: annual combined/hazard/exposure score ladders (month=0)
  for (const beach of beaches) {
    console.log(`\nBuilding annual score ladders for ${beach.slug} (id=${beach.id})`);
    await buildAnnualScoreLadders(beach);
  }

  console.log("\nClimatology build complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
