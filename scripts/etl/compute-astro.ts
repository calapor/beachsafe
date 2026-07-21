import { neon } from "@neondatabase/serverless";
import { getMoonIllumination } from "suncalc";
import { addDays, format, parseISO } from "date-fns";

const sql = neon(process.env.DATABASE_URL!);

function moonPhase(date: Date): number {
  return getMoonIllumination(date).phase;
}

function moonIllum(date: Date): number {
  return getMoonIllumination(date).fraction;
}

// Spring/neap proxy from moon illumination: spring when full/new (illum close to 1 or 0 from phase perspective)
// phase 0 = new moon, 0.5 = full moon → both produce spring tides
function springNeapProxy(phase: number): "spring" | "neap" {
  const dist = Math.min(phase, 1 - phase); // 0=new/full, 0.25=quarter
  return dist < 0.12 ? "spring" : "neap";
}

// Approximate mean tide range by beach (typical values from UKHO / OPW)
const BASE_TIDE_RANGE: Record<string, { spring: number; neap: number }> = {
  fountainstown: { spring: 3.8, neap: 2.0 },
  ballybunion:   { spring: 5.0, neap: 2.6 },
  skerries:      { spring: 3.2, neap: 1.6 },
};

export async function computeAstroForBeach(beachId: number, slug: string) {
  // Get all observation dates for this beach
  const rows = await sql`
    SELECT date FROM observations
    WHERE beach_id = ${beachId}
      AND (moon_phase IS NULL OR moon_illum IS NULL OR tide_range_m IS NULL)
  `;
  console.log(`  Computing astro for ${rows.length} rows for beach ${slug}`);

  const ranges = BASE_TIDE_RANGE[slug] ?? { spring: 3.5, neap: 2.0 };

  for (const row of rows) {
    const date = typeof row.date === "string" ? parseISO(row.date) : new Date(row.date);
    const phase = moonPhase(date);
    const illum = moonIllum(date);
    const sn = springNeapProxy(phase);
    const tideRange = sn === "spring" ? ranges.spring : ranges.neap;

    await sql`
      UPDATE observations
      SET moon_phase = ${phase},
          moon_illum = ${illum},
          tide_range_m = COALESCE(tide_range_m, ${tideRange}),
          source_flags = COALESCE(source_flags, '{}'::jsonb)
            || jsonb_build_object('moon', 'computed')
            || CASE WHEN tide_range_m IS NULL
                    THEN jsonb_build_object('tide', 'estimated')
                    ELSE '{}'::jsonb END
      WHERE beach_id = ${beachId} AND date = ${row.date}
    `;
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
