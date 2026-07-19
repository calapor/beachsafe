/**
 * Seeds synthetic observation rows from the approx_conditions field
 * in each incident data file. Used as a fallback when real weather/wave
 * data cannot be fetched (e.g. network restrictions). Also creates
 * 7 prior-day rows with slightly varied conditions for fingerprint building.
 */
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";
import { resolve } from "path";
import { getMoonIllumination } from "suncalc";

const sql = neon(process.env.DATABASE_URL!);

interface IncidentWithConditions {
  date: string;
  approx_conditions?: {
    mean_wind_knots: number;
    max_gust_knots: number;
    wind_dir_deg: number;
    wave_height_m: number;
    rain_mm: number;
    mslp_hpa: number;
    tide_range_m: number;
  };
}

const BASE_TIDE_RANGE: Record<string, { spring: number; neap: number }> = {
  fountainstown: { spring: 3.8, neap: 2.0 },
  ballybunion:   { spring: 5.0, neap: 2.6 },
  skerries:      { spring: 3.2, neap: 1.6 },
};

function jitter(v: number, pct = 0.15): number {
  return v * (1 + (Math.random() * 2 - 1) * pct);
}

async function seedForBeach(beachId: number, slug: string) {
  const filePath = resolve(__dirname, `../../data/incidents.${slug}.json`);
  let incidents: IncidentWithConditions[];
  try {
    incidents = JSON.parse(readFileSync(filePath, "utf8"));
  } catch { return; }

  const ranges = BASE_TIDE_RANGE[slug] ?? { spring: 3.5, neap: 2.0 };

  for (const inc of incidents) {
    if (!inc.approx_conditions) continue;
    const c = inc.approx_conditions;
    const incDate = new Date(inc.date);

    // Build 8 rows: 7 prior days + incident day
    for (let dayOffset = -7; dayOffset <= 0; dayOffset++) {
      const d = new Date(incDate);
      d.setDate(d.getDate() + dayOffset);
      const isoDate = d.toISOString().split("T")[0];

      const moon = getMoonIllumination(d);
      const tideRange = Math.min(moon.phase, 1 - moon.phase) < 0.12
        ? ranges.spring : ranges.neap;

      // Prior days have milder conditions; incident day has full values
      const scale = dayOffset === 0 ? 1 : 0.7 + Math.random() * 0.4;

      const data = {
        rain_mm:         parseFloat((jitter(c.rain_mm) * scale).toFixed(1)),
        mean_wind_knots: parseFloat((jitter(c.mean_wind_knots) * scale).toFixed(1)),
        max_gust_knots:  parseFloat((jitter(c.max_gust_knots) * scale).toFixed(1)),
        wind_dir_deg:    parseFloat((c.wind_dir_deg + (Math.random() * 20 - 10)).toFixed(0)),
        mslp_hpa:        parseFloat((c.mslp_hpa + (dayOffset * -1)).toFixed(1)),
        wave_height_m:   parseFloat((jitter(c.wave_height_m) * scale).toFixed(2)),
        moon_phase:      parseFloat(moon.phase.toFixed(4)),
        moon_illum:      parseFloat(moon.fraction.toFixed(4)),
        tide_range_m:    parseFloat((c.tide_range_m ?? tideRange).toFixed(1)),
      };

      const cols = ["beach_id", "date", ...Object.keys(data)];
      const vals = [beachId, isoDate, ...Object.values(data)];
      const setClauses = Object.keys(data).map((k) => `${k} = EXCLUDED.${k}`).join(", ");

      await sql.query(
        `INSERT INTO observations (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
         ON CONFLICT (beach_id, date) DO UPDATE SET ${setClauses},
         source_flags = COALESCE(observations.source_flags, '{}'::jsonb) || '{"synthetic":true}'::jsonb`,
        vals
      );
    }
    console.log(`  Seeded synthetic obs for ${slug} incident ${inc.date}`);
  }
}

async function main() {
  const beaches = await sql`SELECT id, slug FROM beaches`;
  for (const beach of beaches as Array<{ id: number; slug: string }>) {
    await seedForBeach(beach.id, beach.slug);
  }
  console.log("Synthetic obs seed complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
