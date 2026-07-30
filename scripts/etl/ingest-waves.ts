/**
 * Ingests wave data from the Open-Meteo marine archive for each beach.
 * Uses beaches.wave_lat/wave_lon (set by probe-wave-points.ts) rather than
 * the beach's own lat/lon — Open-Meteo returns all-nulls at coastal grid points.
 *
 * Fetches: wave_height_max, swell_wave_height_max, swell_wave_period_max,
 *          wind_wave_height_max (plus sea_surface_temperature for SST).
 * Falls back to the IWBNetwork buoy for sea temperature where Open-Meteo lacks it.
 */
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

// IWBNetwork buoy → beach mapping for sea temperature fallback
const BUOY_FOR_SLUG: Record<string, string> = {
  fountainstown: "M3",
  ballybunion:   "M3",
  skerries:      "M2",
};

const CHUNK_SIZE = 500;

interface DailyWave {
  date: string;
  maxWave: number | null;
  swellHeight: number | null;
  swellPeriod: number | null;
  windWaveHeight: number | null;
  seaTemp: number | null;
}

async function fetchOpenMeteoWaves(lat: number, lon: number, fromDate: string, toDate: string): Promise<DailyWave[]> {
  const url =
    `https://marine-api.open-meteo.com/v1/marine` +
    `?latitude=${lat}&longitude=${lon}` +
    `&start_date=${fromDate}&end_date=${toDate}` +
    `&daily=wave_height_max,swell_wave_height_max,swell_wave_period_max,wind_wave_height_max,sea_surface_temperature_max`;

  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  Open-Meteo HTTP ${res.status} for (${lat}, ${lon}) — skipping`);
    return [];
  }

  const data = await res.json() as {
    daily?: {
      time: string[];
      wave_height_max: (number | null)[];
      swell_wave_height_max: (number | null)[];
      swell_wave_period_max: (number | null)[];
      wind_wave_height_max: (number | null)[];
      sea_surface_temperature_max: (number | null)[];
    };
  };

  if (!data.daily) return [];

  const { time, wave_height_max, swell_wave_height_max, swell_wave_period_max, wind_wave_height_max, sea_surface_temperature_max } = data.daily;
  return time.map((date, i) => ({
    date,
    maxWave:       wave_height_max?.[i]             ?? null,
    swellHeight:   swell_wave_height_max?.[i]       ?? null,
    swellPeriod:   swell_wave_period_max?.[i]       ?? null,
    windWaveHeight: wind_wave_height_max?.[i]       ?? null,
    seaTemp:       sea_surface_temperature_max?.[i] ?? null,
  }));
}

async function fetchBuoySeaTemp(buoyId: string, fromDate: string, toDate: string): Promise<Record<string, number>> {
  const base = `https://erddap.marine.ie/erddap/tabledap/IWBNetwork.csv`;
  const fields = "station_id,time,SeaTemperature";
  const constraints = [
    `time%3E=${fromDate}T00:00:00Z`,
    `time%3C=${toDate}T23:59:59Z`,
    `station_id=%22${buoyId}%22`,
  ].join("&");
  const url = `${base}?${fields}&${constraints}`;

  const res = await fetch(url);
  if (!res.ok) return {};
  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 3) return {};

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const timeIdx = headers.indexOf("time");
  const tempIdx = headers.findIndex((h) => h.includes("seatemperature"));
  if (timeIdx === -1 || tempIdx === -1) return {};

  const byDate: Record<string, number[]> = {};
  for (let i = 2; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const time = parts[timeIdx]?.trim();
    const temp = parseFloat(parts[tempIdx]?.trim() ?? "");
    if (!time || isNaN(temp)) continue;
    const date = time.split("T")[0];
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(temp);
  }

  const result: Record<string, number> = {};
  for (const [date, temps] of Object.entries(byDate)) {
    result[date] = temps.reduce((a, b) => a + b, 0) / temps.length;
  }
  return result;
}

async function ingestWavesForBeach(beachId: number, slug: string, waveLat: number, waveLon: number) {
  const fromDate = "2000-01-01";
  const toDate   = new Date().toISOString().split("T")[0];

  console.log(`  Fetching Open-Meteo waves for ${slug} at (${waveLat}, ${waveLon})`);
  const daily = await fetchOpenMeteoWaves(waveLat, waveLon, fromDate, toDate);
  if (!daily.length) {
    console.warn(`  No wave data returned for ${slug} — run probe-wave-points.ts first`);
    return;
  }

  // Fetch SST from buoy to fill gaps in Open-Meteo SST
  const buoyId = BUOY_FOR_SLUG[slug];
  const buoySst = buoyId ? await fetchBuoySeaTemp(buoyId, fromDate, toDate) : {};

  const hasData = daily.filter((r) =>
    r.maxWave != null || r.swellHeight != null || r.swellPeriod != null || r.seaTemp != null
  );
  console.log(`  ${hasData.length}/${daily.length} days with wave data — upserting in chunks of ${CHUNK_SIZE}...`);

  for (let i = 0; i < daily.length; i += CHUNK_SIZE) {
    const chunk       = daily.slice(i, i + CHUNK_SIZE);
    const beachIds    = chunk.map(() => beachId);
    const dates       = chunk.map((r) => r.date);
    const waveHeights = chunk.map((r) => r.maxWave);
    const swellHts    = chunk.map((r) => r.swellHeight);
    const swellPers   = chunk.map((r) => r.swellPeriod);
    const windWaveHts = chunk.map((r) => r.windWaveHeight);
    const seaTemps    = chunk.map((r) => r.seaTemp ?? buoySst[r.date] ?? null);

    await sql`
      INSERT INTO observations
        (beach_id, date, wave_height_m, swell_height_m, swell_period_s, wind_wave_height_m, sea_temp_c, source_flags)
      SELECT b::integer, d::date, wh, sh, sp, ww, st, '{"waves":"open-meteo"}'::jsonb
      FROM unnest(
        ${beachIds}::integer[],
        ${dates}::text[],
        ${waveHeights}::float4[],
        ${swellHts}::float4[],
        ${swellPers}::float4[],
        ${windWaveHts}::float4[],
        ${seaTemps}::float4[]
      ) AS t(b, d, wh, sh, sp, ww, st)
      ON CONFLICT (beach_id, date) DO UPDATE SET
        wave_height_m      = EXCLUDED.wave_height_m,
        swell_height_m     = EXCLUDED.swell_height_m,
        swell_period_s     = EXCLUDED.swell_period_s,
        wind_wave_height_m = EXCLUDED.wind_wave_height_m,
        sea_temp_c         = COALESCE(EXCLUDED.sea_temp_c, observations.sea_temp_c),
        source_flags       = COALESCE(observations.source_flags, '{}'::jsonb) || EXCLUDED.source_flags
    `;

    if ((i / CHUNK_SIZE) % 5 === 0) {
      console.log(`    ${Math.min(i + CHUNK_SIZE, daily.length)}/${daily.length}`);
    }
  }
}

async function main() {
  const beaches = await sql`
    SELECT id, slug, wave_lat, wave_lon FROM beaches
  ` as Array<{ id: number; slug: string; wave_lat: number | null; wave_lon: number | null }>;

  for (const beach of beaches) {
    if (beach.wave_lat == null || beach.wave_lon == null) {
      console.warn(`Beach ${beach.slug} has no wave_lat/wave_lon — run probe-wave-points.ts first`);
      continue;
    }
    await ingestWavesForBeach(beach.id, beach.slug, beach.wave_lat, beach.wave_lon);
  }
  console.log("Wave ingest complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
