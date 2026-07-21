import { neon } from "@neondatabase/serverless";
import { fingerprint, type ObsRow } from "../../src/lib/similarity";

const sql = neon(process.env.DATABASE_URL!);

const BEACH_BEARING: Record<string, number> = {
  fountainstown: 135,
  ballybunion:   270,
  skerries:      90,
};

async function main() {
  const incidents = await sql`
    SELECT i.id, i.beach_id, i.date, i.hour_of_day, b.slug, b.lat, b.lon
    FROM incidents i
    JOIN beaches b ON b.id = i.beach_id
    ORDER BY i.id
  `;

  for (const inc of incidents as Array<{
    id: number; beach_id: number; date: string; hour_of_day: number | null;
    slug: string; lat: number; lon: number;
  }>) {
    const window = await sql`
      SELECT date, mean_wind_knots, max_gust_knots, wave_height_m, rain_mm,
             mslp_hpa, moon_illum, tide_range_m, wind_dir_deg,
             high_tide_times, low_tide_times
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
    const features = fingerprint(window, bearing, {
      lat: inc.lat,
      lon: inc.lon,
      incidentHour: inc.hour_of_day,
    });

    await sql`
      INSERT INTO incident_fingerprints (incident_id, features, computed_at)
      VALUES (${inc.id}, ${JSON.stringify(features)}, NOW())
      ON CONFLICT (incident_id) DO UPDATE
        SET features = EXCLUDED.features, computed_at = NOW()
    `;
    console.log(`  Fingerprinted incident ${inc.id}: daylightHighTide=${features.daylightHighTide.toFixed(2)} risingFraction=${features.risingFraction.toFixed(2)}`);
  }

  console.log("Fingerprint build complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
