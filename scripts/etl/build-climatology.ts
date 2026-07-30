/**
 * Builds per-beach, per-month climatology tables from historical observations.
 * Each metric is calibrated over its own coverage window so that missing-data
 * periods don't bias the percentile ladder.
 *
 * Metrics: all raw observation columns used by hazard components.
 */
import { neon } from "@neondatabase/serverless";
import { buildLadder } from "../../src/lib/calibration";

const sql = neon(process.env.DATABASE_URL!);

// Metrics to calibrate and the observation column name for each
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

async function buildClimatologyForBeach(beachId: number) {
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

async function main() {
  const beaches = await sql`SELECT id, slug FROM beaches ORDER BY id` as Array<{ id: number; slug: string }>;

  for (const beach of beaches) {
    console.log(`\nBuilding climatology for ${beach.slug} (id=${beach.id})`);
    await buildClimatologyForBeach(beach.id);
  }

  console.log("\nClimatology build complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
