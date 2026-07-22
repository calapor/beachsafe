import { neon } from "@neondatabase/serverless";
import { getMoonIllumination } from "suncalc";
import { parseISO } from "date-fns";

const sql = neon(process.env.DATABASE_URL!);

const CHUNK_SIZE = 500;

function moonPhase(date: Date): number {
  return getMoonIllumination(date).phase;
}

function moonIllum(date: Date): number {
  return getMoonIllumination(date).fraction;
}

// Spring/neap proxy: phase 0=new moon, 0.5=full moon → both produce spring tides
function springNeapProxy(phase: number): "spring" | "neap" {
  const dist = Math.min(phase, 1 - phase);
  return dist < 0.12 ? "spring" : "neap";
}

const BASE_TIDE_RANGE: Record<string, { spring: number; neap: number }> = {
  fountainstown: { spring: 3.8, neap: 2.0 },
  ballybunion:   { spring: 5.0, neap: 2.6 },
  skerries:      { spring: 3.2, neap: 1.6 },
};

export async function computeAstroForBeach(beachId: number, slug: string) {
  // Only process rows where moon data is missing (idempotent)
  const rows = await sql`
    SELECT date FROM observations
    WHERE beach_id = ${beachId}
      AND (moon_phase IS NULL OR moon_illum IS NULL)
  ` as Array<{ date: string | Date }>;

  if (!rows.length) {
    console.log(`  No missing astro rows for beach ${slug}`);
    return;
  }
  console.log(`  Computing astro for ${rows.length} rows for beach ${slug} — updating in chunks of ${CHUNK_SIZE}...`);

  const ranges = BASE_TIDE_RANGE[slug] ?? { spring: 3.5, neap: 2.0 };

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);

    const dates:       string[]  = [];
    const phases:      number[]  = [];
    const illums:      number[]  = [];
    const tideRanges:  number[]  = [];

    for (const row of chunk) {
      const date = typeof row.date === "string" ? parseISO(row.date) : new Date(row.date);
      const phase = moonPhase(date);
      const illum = moonIllum(date);
      const sn    = springNeapProxy(phase);
      const tideRange = sn === "spring" ? ranges.spring : ranges.neap;

      const isoDate = date.toISOString().slice(0, 10);
      dates.push(isoDate);
      phases.push(phase);
      illums.push(illum);
      tideRanges.push(tideRange);
    }

    await sql`
      UPDATE observations SET
        moon_phase   = u.phase,
        moon_illum   = u.illum,
        tide_range_m = COALESCE(observations.tide_range_m, u.tide_range),
        source_flags = COALESCE(observations.source_flags, '{}'::jsonb)
          || jsonb_build_object('moon', 'computed')
          || CASE WHEN observations.tide_range_m IS NULL
                  THEN jsonb_build_object('tide', 'estimated')
                  ELSE '{}'::jsonb END
      FROM unnest(
        ${dates}::text[],
        ${phases}::float8[],
        ${illums}::float8[],
        ${tideRanges}::float4[]
      ) AS u(d, phase, illum, tide_range)
      WHERE observations.beach_id = ${beachId}
        AND observations.date = u.d::date
    `;

    if ((i / CHUNK_SIZE) % 5 === 0) {
      console.log(`    ${Math.min(i + CHUNK_SIZE, rows.length)}/${rows.length}`);
    }
  }
}

async function main() {
  const beaches = await sql`SELECT id, slug FROM beaches`;
  for (const beach of beaches as Array<{ id: number; slug: string }>) {
    await computeAstroForBeach(beach.id, beach.slug);
  }
  console.log("Astro computation complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
