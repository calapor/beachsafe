import { neon } from "@neondatabase/serverless";
import { getMoonIllumination } from "suncalc";
import { format, parseISO } from "date-fns";

const sql = neon(process.env.DATABASE_URL!);

const CHUNK = 500;

function moonPhase(date: Date): number {
  return getMoonIllumination(date).phase;
}

function moonIllum(date: Date): number {
  return getMoonIllumination(date).fraction;
}

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
  const rows = await sql`
    SELECT date FROM observations
    WHERE beach_id = ${beachId}
      AND (moon_phase IS NULL OR moon_illum IS NULL OR tide_range_m IS NULL)
  `;
  console.log(`  Computing astro for ${rows.length} rows for beach ${slug}`);
  if (!rows.length) return;

  const ranges = BASE_TIDE_RANGE[slug] ?? { spring: 3.5, neap: 2.0 };

  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);

    // Compute suncalc values in-process (no I/O)
    const valueParts: string[] = [];
    const vals: unknown[] = [beachId];
    let p = 2;

    for (const row of chunk) {
      const date = typeof row.date === "string" ? parseISO(row.date) : new Date(row.date);
      const phase = moonPhase(date);
      const illum = moonIllum(date);
      const tideRange = springNeapProxy(phase) === "spring" ? ranges.spring : ranges.neap;
      const dateStr = format(date, "yyyy-MM-dd");

      vals.push(dateStr, phase, illum, tideRange);
      valueParts.push(
        `($${p}::date,$${p+1}::double precision,$${p+2}::double precision,$${p+3}::double precision)`
      );
      p += 4;
    }

    await sql.query(
      `UPDATE observations AS o
       SET moon_phase   = v.moon_phase,
           moon_illum   = v.moon_illum,
           tide_range_m = COALESCE(o.tide_range_m, v.est_tide_range),
           source_flags = COALESCE(o.source_flags, '{}'::jsonb)
             || jsonb_build_object('moon', 'computed')
             || CASE WHEN o.tide_range_m IS NULL
                     THEN jsonb_build_object('tide', 'estimated')
                     ELSE '{}'::jsonb END
       FROM (VALUES ${valueParts.join(",")}) AS v(date, moon_phase, moon_illum, est_tide_range)
       WHERE o.beach_id = $1 AND o.date = v.date`,
      vals
    );
    console.log(`  Astro ${start + chunk.length}/${rows.length}`);
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
