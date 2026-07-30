/**
 * Case-control discrimination analysis.
 *
 * Cases:    condition_related=true AND activity IN ('swimmer','shore')
 * Controls: same beach, same ±10-day calendar window, other years (1990–2026),
 *           excluding dates that are themselves incidents.
 *
 * Computes per-feature AUC with 95% CI (DeLong method approximated as Wilson).
 * Pools across all beaches because per-beach n is too small.
 *
 * Results are upserted into feature_discrimination.
 * Power note: at n=51 the minimum detectable AUC is ≈0.64.
 */
import { neon } from "@neondatabase/serverless";
import { upsertFeatureDiscrimination } from "../../src/db/queries";

const sql = neon(process.env.DATABASE_URL!);

interface ObsRecord {
  beach_id: number;
  date: string;
  wave_height_m: number | null;
  tide_range_m: number | null;
  mean_wind_knots: number | null;
  sea_temp_c: number | null;
  max_gust_knots: number | null;
  wave_period_s: number | null;
  swell_period_s: number | null;
  temp_max_c: number | null;
  wind_dir_deg: number | null;
}

const FEATURES: Array<keyof Omit<ObsRecord, "beach_id" | "date">> = [
  "tide_range_m",
  "wave_height_m",
  "mean_wind_knots",
  "max_gust_knots",
  "sea_temp_c",
  "wave_period_s",
  "swell_period_s",
  "temp_max_c",
];

/** Wilcoxon-Mann-Whitney AUC */
function auc(positives: number[], negatives: number[]): number {
  if (!positives.length || !negatives.length) return NaN;
  let wins = 0;
  for (const p of positives) {
    for (const n of negatives) {
      if (p > n) wins++;
      else if (p === n) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

/** Wilson 95% CI for a proportion */
function wilsonCI(p: number, n: number): [number, number] {
  const z = 1.96;
  const denom = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denom;
  const half   = (z / denom) * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [centre - half, centre + half];
}

/** Wilson-interval lift vs base rate 0.5 */
function wilsonLift(aucVal: number, n: number): [number, number, number] {
  const [lo, hi] = wilsonCI(aucVal, n);
  return [aucVal - 0.5, lo - 0.5, hi - 0.5];
}

async function main() {
  // Fetch all cases
  const cases = await sql`
    SELECT i.beach_id, i.date::text AS date
    FROM incidents i
    WHERE i.condition_related = true
      AND i.activity IN ('swimmer', 'shore')
    ORDER BY i.date
  ` as Array<{ beach_id: number; date: string }>;

  console.log(`Cases: ${cases.length}`);

  // Fetch all incident dates (to exclude from controls)
  const allIncidentDates = new Set(
    (await sql`SELECT beach_id::text || '|' || date::text AS key FROM incidents` as Array<{ key: string }>)
      .map((r) => r.key)
  );

  // For each case, find controls: same beach, same calendar window ±10 days, other years
  const caseKeys = new Set(cases.map((c) => `${c.beach_id}|${c.date}`));

  const controlKeys = new Set<string>();
  for (const c of cases) {
    const [year, month, day] = c.date.split("-").map(Number);
    for (let yr = 1990; yr <= 2026; yr++) {
      if (yr === year) continue;
      for (let offset = -10; offset <= 10; offset++) {
        const d = new Date(yr, month - 1, day + offset);
        const dateStr = d.toISOString().split("T")[0];
        const key = `${c.beach_id}|${dateStr}`;
        if (!allIncidentDates.has(key) && !caseKeys.has(key)) {
          controlKeys.add(key);
        }
      }
    }
  }

  console.log(`Controls (potential): ${controlKeys.size}`);

  // Fetch observations for cases
  const caseDates = cases.map((c) => c.date);
  const caseBeachIds = cases.map((c) => c.beach_id);

  const caseObs = await sql`
    SELECT o.beach_id, o.date::text AS date,
      o.wave_height_m, o.tide_range_m, o.mean_wind_knots,
      o.sea_temp_c, o.max_gust_knots, o.wave_period_s, o.swell_period_s,
      o.temp_max_c, o.wind_dir_deg
    FROM observations o
    WHERE (o.beach_id, o.date::text) IN (
      SELECT UNNEST(${caseBeachIds}::int[]), UNNEST(${caseDates}::text[])
    )
  ` as ObsRecord[];

  console.log(`Case obs found: ${caseObs.length}`);

  // Fetch observations for controls
  const controlArray = [...controlKeys].map((k) => {
    const [bid, date] = k.split("|");
    return { beach_id: Number(bid), date };
  });

  const controlBeachIds = controlArray.map((r) => r.beach_id);
  const controlDates    = controlArray.map((r) => r.date);

  const controlObs = await sql`
    SELECT o.beach_id, o.date::text AS date,
      o.wave_height_m, o.tide_range_m, o.mean_wind_knots,
      o.sea_temp_c, o.max_gust_knots, o.wave_period_s, o.swell_period_s,
      o.temp_max_c, o.wind_dir_deg
    FROM observations o
    WHERE (o.beach_id, o.date::text) IN (
      SELECT UNNEST(${controlBeachIds}::int[]), UNNEST(${controlDates}::text[])
    )
  ` as ObsRecord[];

  console.log(`Control obs found: ${controlObs.length}`);
  console.log(`\nPower note: at n=${caseObs.length} cases, minimum detectable AUC ≈ 0.64`);
  console.log(`\nPer-feature AUC (pooled across beaches):`);
  console.log(`${"feature".padEnd(20)} AUC   [95% CI]            lift    n_case  n_ctrl`);
  console.log("─".repeat(78));

  for (const feat of FEATURES) {
    const caseVals    = caseObs.map((r)    => r[feat] as number | null).filter((v): v is number => v != null);
    const controlVals = controlObs.map((r) => r[feat] as number | null).filter((v): v is number => v != null);

    if (!caseVals.length || !controlVals.length) {
      console.log(`${"  " + feat.padEnd(18)} n/a (insufficient data: ${caseVals.length} cases, ${controlVals.length} controls)`);
      continue;
    }

    const a = auc(caseVals, controlVals);
    const [lo, hi] = wilsonCI(a, caseVals.length * controlVals.length);
    const [lift, liftLo, liftHi] = wilsonLift(a, caseVals.length * controlVals.length);

    console.log(
      `${"  " + feat.padEnd(18)} ${a.toFixed(3)} [${lo.toFixed(2)},${hi.toFixed(2)}]  ${lift >= 0 ? " " : ""}${lift.toFixed(3)} [${liftLo.toFixed(2)},${liftHi.toFixed(2)}]  ${caseVals.length}  ${controlVals.length}`
    );

    await upsertFeatureDiscrimination(
      feat, "pooled",
      caseVals.length, controlVals.length,
      a, lo, hi,
      lift, liftLo, liftHi,
    );
  }

  console.log("\nResults written to feature_discrimination table.");
}

main().catch((e) => { console.error(e); process.exit(1); });
