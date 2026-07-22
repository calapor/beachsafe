import { neon } from "@neondatabase/serverless";
import { getTimes } from "suncalc";
import { fingerprint, type ObsRow } from "../../src/lib/similarity";

const sql = neon(process.env.DATABASE_URL!);

const BEACH_BEARING: Record<string, number> = {
  fountainstown: 135,
  ballybunion:   270,
  skerries:      90,
};

const BEACH_COORDS: Record<string, { lat: number; lon: number }> = {
  fountainstown: { lat: 51.7833, lon: -8.2667 },
  ballybunion:   { lat: 52.5137, lon: -9.6722 },
  skerries:      { lat: 53.5833, lon: -6.1000 },
};

function toHHMM(date: Date): string {
  const h = String(date.getUTCHours()).padStart(2, "0");
  const m = String(date.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

async function main() {
  // Only fingerprint condition-driven incidents (NULL treated conservatively as relevant)
  const incidents = await sql`
    SELECT i.id, i.beach_id, i.date, b.slug,
           i.time_of_day::text AS time_of_day
    FROM incidents i
    JOIN beaches b ON b.id = i.beach_id
    WHERE i.condition_related IS NOT FALSE
    ORDER BY i.id
  `;

  console.log(`Fingerprinting ${incidents.length} condition-related incidents...`);

  for (const inc of incidents as Array<{ id: number; beach_id: number; date: string; slug: string; time_of_day: string | null }>) {
    const isoDate = inc.date instanceof Date
      ? inc.date.toISOString().slice(0, 10)
      : String(inc.date).slice(0, 10);

    const window = await sql`
      SELECT date, mean_wind_knots, max_gust_knots, wave_height_m, rain_mm,
             mslp_hpa, moon_illum, tide_range_m, wind_dir_deg,
             sea_temp_c, wave_period_s, temp_max_c,
             high_tide_times, low_tide_times
      FROM observations
      WHERE beach_id = ${inc.beach_id}
        AND date <= ${isoDate}::date
        AND date >= (${isoDate}::date - INTERVAL '7 days')
      ORDER BY date ASC
    ` as ObsRow[];

    if (!window.length) {
      console.warn(`  No obs window for incident ${inc.id} on ${isoDate} — skipping`);
      continue;
    }

    // Compute daylight window via SunCalc for the incident date+location
    const coords = BEACH_COORDS[inc.slug];
    const incidentDate = new Date(`${isoDate}T12:00:00Z`);
    let daylight: { sunrise: string; sunset: string } | undefined;
    if (coords) {
      const sunTimes = getTimes(incidentDate, coords.lat, coords.lon);
      const sr = sunTimes.sunrise;
      const ss = sunTimes.sunset;
      if (sr instanceof Date && ss instanceof Date && !isNaN(sr.getTime()) && !isNaN(ss.getTime())) {
        daylight = { sunrise: toHHMM(sr), sunset: toHHMM(ss) };
      }
    }

    const dayOf = window[window.length - 1];
    const bearing = BEACH_BEARING[inc.slug] ?? 270;

    const features = fingerprint(window, bearing, {
      timeOfDay:     inc.time_of_day,
      highTideTimes: dayOf.high_tide_times ?? null,
      lowTideTimes:  dayOf.low_tide_times  ?? null,
      daylight,
    });

    await sql`
      INSERT INTO incident_fingerprints (incident_id, features, computed_at)
      VALUES (${inc.id}, ${JSON.stringify(features)}, NOW())
      ON CONFLICT (incident_id) DO UPDATE
        SET features = EXCLUDED.features, computed_at = NOW()
    `;
    console.log(`  Fingerprinted incident ${inc.id} (tideConf=${features.tideConfidence.toFixed(1)})`);
  }

  console.log("Fingerprint build complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
