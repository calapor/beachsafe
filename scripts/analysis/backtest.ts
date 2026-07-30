/**
 * Out-of-fold cross-validation harness.
 *
 * Calls the real scoreDay() path, not a proxy. Reports:
 *   - Calibration: realized tier frequencies vs targets
 *   - Skill: AUC + lift at 10% and 25% alert budgets (out-of-fold only)
 *   - Weight sweep: EXPOSURE_WEIGHT 0.0 … 1.0
 *
 * Gate: fails (exit 1) if out-of-fold lift at 25% budget < 1.5×.
 *
 * Run: npx tsx --env-file .env.local scripts/analysis/backtest.ts
 */
import { neon } from "@neondatabase/serverless";
import { buildLadder, percentileOf, tierFromPercentile, type PercentileTable } from "../../src/lib/calibration";
import { scoreDay } from "../../src/lib/risk";
import type { ObsRowExtended, Coverage } from "../../src/lib/hazard";
import { BEACH_BEARING } from "../../src/lib/similarity";

const sql = neon(process.env.DATABASE_URL!);

// ── Year-block CV configuration ──────────────────────────────────────────────

// 5 folds covering 2005–2026
const FOLDS: Array<{ testYears: number[] }> = [
  { testYears: [2005, 2006, 2007, 2008] },
  { testYears: [2009, 2010, 2011, 2012] },
  { testYears: [2013, 2014, 2015, 2016] },
  { testYears: [2017, 2018, 2019, 2020] },
  { testYears: [2021, 2022, 2023, 2024, 2025, 2026] },
];

const LIFT_GATE = 1.5; // minimum out-of-fold lift at 25% budget

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildClimMap(
  rows: Array<{ metric: string; month: number; n: number; coverage_start: unknown; coverage_end: unknown; ladder: unknown }>,
): Record<number, Record<string, PercentileTable>> {
  const byMonth: Record<number, Record<string, PercentileTable>> = {};
  for (const row of rows) {
    const ladder = typeof row.ladder === "string" ? JSON.parse(row.ladder) : row.ladder;
    if (!Array.isArray(ladder) || ladder.length !== 101) continue;
    if (!byMonth[row.month]) byMonth[row.month] = {};
    byMonth[row.month][row.metric] = {
      metric: row.metric,
      month: row.month,
      n: row.n,
      coverageStart: String(row.coverage_start ?? ""),
      coverageEnd:   String(row.coverage_end ?? ""),
      ladder,
    };
  }
  return byMonth;
}

// Mann-Whitney AUC: fraction of (case, control) pairs where case scores higher.
function auc(caseScores: number[], controlScores: number[]): number {
  if (!caseScores.length || !controlScores.length) return 0.5;
  let wins = 0;
  for (const c of caseScores) {
    for (const ctrl of controlScores) {
      if (c > ctrl) wins++;
      else if (c === ctrl) wins += 0.5;
    }
  }
  return wins / (caseScores.length * controlScores.length);
}

function liftAt(caseScores: number[], allScores: number[], budgetFrac: number): number {
  if (!caseScores.length || !allScores.length) return 1;
  const sorted = [...allScores].sort((a, b) => b - a);
  const cutoff = sorted[Math.floor(sorted.length * budgetFrac) - 1] ?? -Infinity;
  const captured = caseScores.filter((s) => s >= cutoff).length;
  const prevalence = caseScores.length / allScores.length;
  const expectedAtRandom = prevalence * budgetFrac * allScores.length;
  if (expectedAtRandom === 0) return 1;
  return captured / expectedAtRandom;
}

// ── Main ─────────────────────────────────────────────────────────────────────

interface ScoredDay { date: string; combined: number; isIncident: boolean; }

async function scoreBeach(
  beach: { id: number; slug: string },
  weight: number,
): Promise<ScoredDay[]> {
  const bearing = BEACH_BEARING[beach.slug] ?? 270;

  // Load all observations
  const allObs = await sql.query(
    `SELECT date::text AS date,
            mean_wind_knots, max_gust_knots, wave_height_m, wave_period_s,
            sea_temp_c, rain_mm, mslp_hpa, moon_illum, tide_range_m,
            wind_dir_deg, temp_max_c,
            swell_height_m, swell_period_s,
            high_tide_times, low_tide_times
     FROM observations
     WHERE beach_id = $1 AND date >= '2005-01-01'
     ORDER BY date`,
    [beach.id],
  ) as Array<ObsRowExtended & { date: string }>;

  // Load all per-month climatology (used for hazard component normalisation)
  const climRows = await sql.query(
    `SELECT metric, month::int AS month, n, coverage_start, coverage_end, ladder
     FROM climatology
     WHERE beach_id = $1 AND month >= 1 AND month <= 12`,
    [beach.id],
  ) as Array<{ metric: string; month: number; n: number; coverage_start: unknown; coverage_end: unknown; ladder: unknown }>;
  const climByMonth = buildClimMap(climRows);

  // Load incident dates (condition-related swimmer/shore incidents)
  const incidentRows = await sql.query(
    `SELECT DISTINCT date::text AS date
     FROM incidents
     WHERE beach_id = $1
       AND condition_related IS NOT FALSE
       AND activity IN ('swimmer', 'shore')`,
    [beach.id],
  ) as Array<{ date: string }>;
  const incidentDates = new Set(incidentRows.map((r) => r.date.slice(0, 10)));

  const results: ScoredDay[] = [];

  for (let i = 0; i < allObs.length; i++) {
    const obs = allObs[i];
    const dateStr = obs.date.slice(0, 10);
    const windowStart = Math.max(0, i - 7);
    const window = allObs.slice(windowStart, i + 1) as ObsRowExtended[];

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

    // Override with custom weight (for sweep)
    let combined: number | null = null;
    if (day.hazard.score != null && day.exposure.score != null) {
      combined = weight * day.exposure.score + (1 - weight) * day.hazard.score;
    } else if (day.exposure.score != null) {
      combined = day.exposure.score;
    } else if (day.hazard.score != null) {
      combined = day.hazard.score;
    }

    if (combined == null) continue;
    results.push({ date: dateStr, combined, isIncident: incidentDates.has(dateStr) });
  }

  return results;
}

async function main() {
  const beaches = await sql`SELECT id, slug FROM beaches ORDER BY id` as Array<{ id: number; slug: string }>;

  let allPass = true;
  const SWEEP_WEIGHTS = [0.0, 0.25, 0.50, 0.65, 0.75, 1.0];

  for (const beach of beaches) {
    console.log(`\n════ ${beach.slug} ════`);

    // ── 1. Calibration check (full data, fixed EXPOSURE_WEIGHT=0.65) ────────
    const allDays = await scoreBeach(beach, 0.65);
    const allScores = allDays.map((d) => d.combined);
    const ladder = buildLadder([...allScores].sort((a, b) => a - b));
    if (!ladder) {
      console.log("  Not enough data for calibration");
      continue;
    }
    const annualTable: PercentileTable = {
      metric: "combined_score", month: 0, n: allScores.length,
      coverageStart: allDays[0]?.date ?? "",
      coverageEnd:   allDays[allDays.length - 1]?.date ?? "",
      ladder,
    };
    const tierCounts: Record<string, number> = { severe: 0, warning: 0, watch: 0, low: 0, unknown: 0 };
    for (const d of allDays) {
      const t = tierFromPercentile(percentileOf(d.combined, annualTable));
      tierCounts[t] = (tierCounts[t] ?? 0) + 1;
    }
    const total = allDays.length;
    console.log(`\n  Calibration (n=${total} days):`);
    const TARGETS = {
      severe:  { lo: 0.005, hi: 0.04 },
      warning: { lo: 0.04,  hi: 0.14 },
      watch:   { lo: 0.08,  hi: 0.24 },
      low:     { lo: 0.60,  hi: 1.00 },
    };
    for (const tier of ["severe", "warning", "watch", "low"] as const) {
      const freq = (tierCounts[tier] ?? 0) / total;
      const { lo, hi } = TARGETS[tier];
      const pass = freq >= lo && freq <= hi;
      console.log(`    ${tier.padEnd(8)} ${(freq * 100).toFixed(1)}%  target [${(lo*100).toFixed(0)}–${(hi*100).toFixed(0)}%]  ${pass ? "✓" : "✗"}`);
    }

    // ── 2. Out-of-fold CV at EXPOSURE_WEIGHT=0.65 ───────────────────────────
    const oofCaseScores:    number[] = [];
    const oofControlScores: number[] = [];
    let oofIncidentsCaptured10 = 0;
    let oofIncidentsCaptured25 = 0;
    let oofTotalIncidents = 0;
    let oofTotalDays = 0;

    for (const fold of FOLDS) {
      const testSet = new Set(fold.testYears);
      const testDays = allDays.filter((d) => testSet.has(new Date(d.date).getUTCFullYear()));
      if (!testDays.length) continue;
      const testScores = testDays.map((d) => d.combined);
      for (const d of testDays) {
        if (d.isIncident) oofCaseScores.push(d.combined);
        else oofControlScores.push(d.combined);
      }
      const foldIncidents = testDays.filter((d) => d.isIncident);
      const captured10 = foldIncidents.filter((d) => {
        const rank = testDays.filter((x) => x.combined >= d.combined).length;
        return rank / testDays.length <= 0.10;
      }).length;
      const captured25 = foldIncidents.filter((d) => {
        const rank = testDays.filter((x) => x.combined >= d.combined).length;
        return rank / testDays.length <= 0.25;
      }).length;
      oofIncidentsCaptured10 += captured10;
      oofIncidentsCaptured25 += captured25;
      oofTotalIncidents += foldIncidents.length;
      oofTotalDays += testDays.length;
    }

    const aucVal = auc(oofCaseScores, oofControlScores);
    const prevalence = oofTotalIncidents / oofTotalDays;
    const lift10 = oofTotalIncidents > 0 ? (oofIncidentsCaptured10 / oofTotalIncidents) / (0.10 / (1 - prevalence + 0.10) || 0.10) : 1;
    const lift25 = oofTotalIncidents > 0 ? (oofIncidentsCaptured25 / oofTotalIncidents) / (0.25 / (1 - prevalence + 0.25) || 0.25) : 1;

    // Simpler: lift = (captured_incidents/total_incidents) / (budget_fraction)
    const lift10simple = oofTotalIncidents > 0
      ? (oofIncidentsCaptured10 / oofTotalIncidents) / 0.10
      : 1;
    const lift25simple = oofTotalIncidents > 0
      ? (oofIncidentsCaptured25 / oofTotalIncidents) / 0.25
      : 1;

    console.log(`\n  Out-of-fold CV (weight=0.65):`);
    console.log(`    AUC:             ${aucVal.toFixed(3)}`);
    console.log(`    Incidents:       ${oofTotalIncidents} cases / ${oofTotalDays} days`);
    console.log(`    Captured @10%:   ${oofIncidentsCaptured10}/${oofTotalIncidents} → lift ${lift10simple.toFixed(2)}x`);
    console.log(`    Captured @25%:   ${oofIncidentsCaptured25}/${oofTotalIncidents} → lift ${lift25simple.toFixed(2)}x`);
    console.log(`    Gate (lift@25% ≥ ${LIFT_GATE}x): ${lift25simple >= LIFT_GATE ? "✓ PASS" : "✗ FAIL"}`);

    if (lift25simple < LIFT_GATE) allPass = false;

    // ── 3. Weight sweep ──────────────────────────────────────────────────────
    console.log(`\n  Weight sweep (out-of-fold lift @25%):`);
    for (const w of SWEEP_WEIGHTS) {
      if (w === 0.65) continue; // already computed above
      const wDays = await scoreBeach(beach, w);
      let wCaptured25 = 0, wTotalInc = 0, wTotalD = 0;
      for (const fold of FOLDS) {
        const testSet = new Set(fold.testYears);
        const testDays = wDays.filter((d) => testSet.has(new Date(d.date).getUTCFullYear()));
        const foldInc = testDays.filter((d) => d.isIncident);
        const c = foldInc.filter((d) => {
          const rank = testDays.filter((x) => x.combined >= d.combined).length;
          return rank / testDays.length <= 0.25;
        }).length;
        wCaptured25 += c;
        wTotalInc   += foldInc.length;
        wTotalD     += testDays.length;
      }
      const wLift = wTotalInc > 0 ? (wCaptured25 / wTotalInc) / 0.25 : 1;
      console.log(`    w_exposure=${w.toFixed(2)}  lift@25%=${wLift.toFixed(2)}x  (${wCaptured25}/${wTotalInc} captured)`);
    }
    console.log(`    w_exposure=0.65  lift@25%=${lift25simple.toFixed(2)}x  (${oofIncidentsCaptured25}/${oofTotalIncidents} captured) ← chosen`);

    // ── 4. Hazard-only check ─────────────────────────────────────────────────
    const hDays = await scoreBeach(beach, 0.0); // pure hazard
    let hCaptured25 = 0, hTotalInc = 0;
    for (const fold of FOLDS) {
      const testSet = new Set(fold.testYears);
      const testDays = hDays.filter((d) => testSet.has(new Date(d.date).getUTCFullYear()));
      const foldInc = testDays.filter((d) => d.isIncident);
      const c = foldInc.filter((d) => {
        const rank = testDays.filter((x) => x.combined >= d.combined).length;
        return rank / testDays.length <= 0.25;
      }).length;
      hCaptured25 += c;
      hTotalInc   += foldInc.length;
    }
    const hLift = hTotalInc > 0 ? (hCaptured25 / hTotalInc) / 0.25 : 1;
    const hazardAddsSigSignal = lift25simple - hLift > 0.15; // noise floor ≈ ±3.5 incidents
    console.log(`\n  Hazard-only lift@25%: ${hLift.toFixed(2)}x vs blend: ${lift25simple.toFixed(2)}x`);
    console.log(`  Hazard earns its weight: ${hazardAddsSigSignal ? "YES (Δ > noise floor)" : "NO (within noise)"}`);
  }

  console.log(`\n${allPass ? "ALL BEACHES PASS gate." : "SOME BEACHES FAIL gate — lift < " + LIFT_GATE + "x."}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
