/**
 * For each beach, walk outward from the beach (lat, lon) in seaward steps until
 * we find an Open-Meteo marine grid point with non-null wave data.
 * Writes the result to beaches.wave_lat / beaches.wave_lon.
 *
 * Run once before ingest-waves.ts to populate the offshore probe points.
 * Rate-limited to ~1 req/sec.
 */
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

// Seaward bearing (degrees true) and step sizes to probe for each beach.
// Walking in the seaward direction minimises risk of hitting land first.
const BEACH_PROBES: Record<string, { bearingDeg: number }> = {
  fountainstown: { bearingDeg: 135 }, // SE — into Cork Harbour mouth / Celtic Sea
  ballybunion:   { bearingDeg: 270 }, // W  — into the North Atlantic
  skerries:      { bearingDeg: 90  }, // E  — into the Irish Sea
};

const STEP_SIZES = [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0];

function offsetLatLon(lat: number, lon: number, bearingDeg: number, distDeg: number) {
  const rad = (bearingDeg * Math.PI) / 180;
  return {
    lat: lat + Math.cos(rad) * distDeg,
    lon: lon + Math.sin(rad) * distDeg,
  };
}

async function probePoint(lat: number, lon: number): Promise<boolean> {
  const url =
    `https://marine-api.open-meteo.com/v1/marine` +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&start_date=2020-07-01&end_date=2020-07-02&daily=wave_height_max`;

  const res = await fetch(url);
  if (!res.ok) return false;
  const data = await res.json() as { daily?: { wave_height_max?: (number | null)[] } };
  const vals = data.daily?.wave_height_max ?? [];
  return vals.some((v) => v != null && !isNaN(v));
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findWavePoint(slug: string, beachLat: number, beachLon: number): Promise<{ lat: number; lon: number } | null> {
  const probe = BEACH_PROBES[slug];
  if (!probe) {
    console.warn(`  No probe config for ${slug} — skipping`);
    return null;
  }

  for (const step of STEP_SIZES) {
    const { lat, lon } = offsetLatLon(beachLat, beachLon, probe.bearingDeg, step);
    console.log(`  Probing (${lat.toFixed(4)}, ${lon.toFixed(4)}) step=${step}°...`);
    const ok = await probePoint(lat, lon);
    await sleep(1100);
    if (ok) {
      console.log(`  Found wave data at (${lat.toFixed(4)}, ${lon.toFixed(4)})`);
      return { lat, lon };
    }
  }

  console.warn(`  No wave data found within ${STEP_SIZES[STEP_SIZES.length - 1]}° of ${slug}`);
  return null;
}

async function main() {
  const beaches = await sql`SELECT id, slug, lat, lon FROM beaches` as Array<{ id: number; slug: string; lat: number; lon: number }>;

  for (const beach of beaches) {
    console.log(`\nProbing wave point for ${beach.slug} (${beach.lat}, ${beach.lon})`);
    const point = await findWavePoint(beach.slug, beach.lat, beach.lon);
    if (!point) continue;

    await sql`
      UPDATE beaches SET wave_lat = ${point.lat}, wave_lon = ${point.lon}
      WHERE id = ${beach.id}
    `;
    console.log(`  Updated beaches.wave_lat/wave_lon for ${beach.slug}`);
  }

  console.log("\nProbe complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
