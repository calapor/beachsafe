import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);

const BEACHES = [
  { slug: "fountainstown", lat: 51.7833, lon: -8.2667 },
  { slug: "ballybunion",   lat: 52.5137, lon: -9.6722 },
  { slug: "skerries",      lat: 53.5833, lon: -6.1000 },
];

const CHUNK = 500;

function avg(vals: (number | null)[]): number | null {
  const clean = vals.filter((v): v is number => v !== null && !isNaN(v));
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

function nullNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url: string, maxRetries = 5): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") ?? "0", 10);
      const waitMs = (retryAfter > 0 ? retryAfter : 60) * 1000;
      console.warn(`  Rate limited (429) — waiting ${waitMs / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
      await sleep(waitMs);
      continue;
    }
    return res;
  }
  throw new Error("Max retries exceeded after rate limiting");
}

export async function ingestWeatherForBeach(beachId: number, lat: number, lon: number) {
  const today = new Date().toISOString().split("T")[0];

  // Incremental: only fetch dates not yet in the DB to avoid hammering the API
  const latestRow = await sql`
    SELECT MAX(date)::text AS max_date FROM observations
    WHERE beach_id = ${beachId} AND mean_wind_knots IS NOT NULL
  `;
  const latestDate = (latestRow[0] as { max_date: string | null })?.max_date;
  // Re-fetch the last 7 days to catch any late-arriving corrections
  const startDate = latestDate
    ? new Date(new Date(latestDate).getTime() - 7 * 86400_000).toISOString().split("T")[0]
    : "1950-01-01";

  if (startDate >= today) {
    console.log(`  Weather for beach ${beachId} is up to date (${latestDate}) — skipping`);
    return;
  }

  const url =
    `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${lat}&longitude=${lon}` +
    `&start_date=${startDate}&end_date=${today}` +
    `&daily=precipitation_sum,temperature_2m_max,temperature_2m_min,wind_gusts_10m_max,wind_direction_10m_dominant` +
    `&hourly=wind_speed_10m,pressure_msl` +
    `&wind_speed_unit=kn&timezone=UTC`;

  console.log(`  Fetching Open-Meteo ERA5 for beach ${beachId} from ${startDate} to ${today}`);
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from Open-Meteo`);
  const data = await res.json() as {
    daily: {
      time: string[];
      precipitation_sum: (number | null)[];
      temperature_2m_max: (number | null)[];
      temperature_2m_min: (number | null)[];
      wind_gusts_10m_max: (number | null)[];
      wind_direction_10m_dominant: (number | null)[];
    };
    hourly: {
      time: string[];
      wind_speed_10m: (number | null)[];
      pressure_msl: (number | null)[];
    };
  };

  // Build per-day averages from hourly data
  const hourlyByDate: Record<string, { wind: (number | null)[]; pressure: (number | null)[] }> = {};
  for (let i = 0; i < data.hourly.time.length; i++) {
    const date = data.hourly.time[i].split("T")[0];
    if (!hourlyByDate[date]) hourlyByDate[date] = { wind: [], pressure: [] };
    hourlyByDate[date].wind.push(nullNum(data.hourly.wind_speed_10m[i]));
    hourlyByDate[date].pressure.push(nullNum(data.hourly.pressure_msl[i]));
  }

  const days = data.daily.time;
  console.log(`  Got ${days.length} daily rows from ERA5 — inserting in chunks of ${CHUNK}`);

  // Columns are fixed for every row; use NULL for missing values.
  // This allows true multi-row bulk inserts (one query per chunk).
  // 9 params per row × 500 rows = 4500 params, well within Postgres limits.
  const COL_COUNT = 9;
  for (let chunkStart = 0; chunkStart < days.length; chunkStart += CHUNK) {
    const chunk = days.slice(chunkStart, chunkStart + CHUNK);
    console.log(`  Progress: ${chunkStart}/${days.length}`);

    const placeholders: string[] = [];
    const vals: unknown[] = [];
    let p = 1;

    for (const date of chunk) {
      const i = days.indexOf(date);
      const hourly = hourlyByDate[date] ?? { wind: [], pressure: [] };

      vals.push(
        beachId,
        date,
        nullNum(data.daily.precipitation_sum[i]),
        nullNum(data.daily.temperature_2m_max[i]),
        nullNum(data.daily.temperature_2m_min[i]),
        nullNum(data.daily.wind_gusts_10m_max[i]),
        nullNum(data.daily.wind_direction_10m_dominant[i]),
        avg(hourly.wind),
        avg(hourly.pressure),
      );
      placeholders.push(
        `($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8},'{"weather":"era5_openmeteo"}'::jsonb)`
      );
      p += COL_COUNT;
    }

    await sql.unsafe(
      `INSERT INTO observations
         (beach_id, date, rain_mm, temp_max_c, temp_min_c,
          max_gust_knots, wind_dir_deg, mean_wind_knots, mslp_hpa, source_flags)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (beach_id, date) DO UPDATE SET
         rain_mm         = EXCLUDED.rain_mm,
         temp_max_c      = EXCLUDED.temp_max_c,
         temp_min_c      = EXCLUDED.temp_min_c,
         max_gust_knots  = EXCLUDED.max_gust_knots,
         wind_dir_deg    = EXCLUDED.wind_dir_deg,
         mean_wind_knots = EXCLUDED.mean_wind_knots,
         mslp_hpa        = EXCLUDED.mslp_hpa,
         source_flags    = COALESCE(observations.source_flags, '{}'::jsonb) || EXCLUDED.source_flags`,
      vals as Parameters<typeof sql.unsafe>[1]
    );
  }
  console.log(`  Done: ${days.length} weather rows for beach ${beachId}`);
}

async function main() {
  for (let i = 0; i < BEACHES.length; i++) {
    const beach = BEACHES[i];
    const rows = await sql`SELECT id FROM beaches WHERE slug = ${beach.slug}`;
    if (!rows.length) { console.warn(`Beach not found: ${beach.slug}`); continue; }
    await ingestWeatherForBeach((rows[0] as { id: number }).id, beach.lat, beach.lon);
    // Brief pause between beaches to stay within Open-Meteo's rate limit
    if (i < BEACHES.length - 1) await sleep(5000);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => sql.end());
