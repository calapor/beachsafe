import { neon } from "@neondatabase/serverless";
import { fingerprint, type ObsRow } from "../../src/lib/similarity";

const sql = neon(process.env.DATABASE_URL!);

// Beach facing direction (degrees: from which direction waves/wind arrive)
const BEACH_BEARING: Record<string, number> = {
  fountainstown: 135, // SE-facing bay
  ballybunion:   270, // W-facing Atlantic
  skerries:      90,  // E-facing
};

async function main() {
  const incidents = await sql`
    SELECT i.id, i.beach_id, i.date, b.slug
    FROM incidents i
    JOIN beaches b ON b.id = i.beach_id
    ORDER BY i.id
  `;

  for (const inc of incidents as Array<{ id: number; beach_id: number; date: string; slug: string }>) {
    const window = await sql`
      SELECT date, mean_wind_knots, max_gust_knots, wave_height_m, rain_mm,
             mslp_hpa, moon_illum, tide_range_m, wind_dir_deg
      FROM observations
      WHERE beach_id = ${inc.beach_id}
        AND date <= ${inc.date}::date
        AND date >= (${inc.date}::date - INTERVAL '7 days')
      ORDER BY date ASC
    ` as ObsRow[];

    if (!window.length) {
      console.warn(`  No obs window for incident ${inc.id} on ${inc.date} — skipping`);
      continue;
    }

    const bearing = BEACH_BEARING[inc.slug] ?? 270;
    const features = fingerprint(window, bearing);

    await sql`
      INSERT INTO incident_fingerprints (incident_id, features, computed_at)
      VALUES (${inc.id}, ${JSON.stringify(features)}, NOW())
      ON CONFLICT (incident_id) DO UPDATE
        SET features = EXCLUDED.features, computed_at = NOW()
    `;
    console.log(`  Fingerprinted incident ${inc.id}: ${JSON.stringify(features)}`);
  }

  console.log("Fingerprint build complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
