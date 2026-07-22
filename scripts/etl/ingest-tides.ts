import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

// Correct station names from IrishNationalTideGaugeNetwork (verified 2026-07).
// Skerries Harbour is an exact geographic match for Skerries beach.
// Ballycotton Harbour is the closest gauge to Fountainstown (12 km east of Crosshaven).
// Inishmore (Aran Islands) shares the same longitude as Ballybunion and is the closest
// west-coast gauge (67 km north) — tidal timing is representative of the Kerry coast.
const BEACHES = [
  { slug: "fountainstown", stationId: "Ballycotton Harbour" },
  { slug: "ballybunion",   stationId: "Inishmore" },
  { slug: "skerries",      stationId: "Skerries Harbour" },
];

const DATASET    = "IrishNationalTideGaugeNetwork";
const CHUNK_SIZE = 500;

// Smoothing window: 30 min at ~6-min resolution = 5 points each side
const SMOOTH_HALF   = 5;
// Minimum separation between consecutive highs or lows: 3 h at 6 min = 30 steps
const MIN_SEP_STEPS = 30;

function smoothSeries(vals: (number | null)[]): (number | null)[] {
  return vals.map((_, i) => {
    const w: number[] = [];
    for (let j = Math.max(0, i - SMOOTH_HALF); j <= Math.min(vals.length - 1, i + SMOOTH_HALF); j++) {
      const v = vals[j];
      if (v !== null) w.push(v);
    }
    return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
  });
}

function findExtrema(times: string[], vals: (number | null)[], type: "max" | "min"): string[] {
  const smoothed = smoothSeries(vals);
  const results: string[] = [];
  let lastIdx = -MIN_SEP_STEPS - 1;

  for (let i = 1; i < smoothed.length - 1; i++) {
    const v = smoothed[i], prev = smoothed[i - 1], next = smoothed[i + 1];
    if (v === null || prev === null || next === null) continue;
    const isExtreme = type === "max" ? v >= prev && v >= next : v <= prev && v <= next;
    if (isExtreme && i - lastIdx >= MIN_SEP_STEPS) {
      const timePart = times[i].split("T")[1]?.slice(0, 5) ?? "";
      if (timePart) results.push(timePart);
      lastIdx = i;
    }
  }
  return results;
}

function buildUrl(stationId: string, fromDate: string, toDate: string): string {
  const base = `https://erddap.marine.ie/erddap/tabledap/${DATASET}.csv`;
  // encodeURIComponent handles spaces and special chars in station names
  const encodedStation = encodeURIComponent(stationId);
  const constraints = [
    `time%3E=${fromDate}`,
    `time%3C=${toDate}`,
    `station_id=%22${encodedStation}%22`,
  ].join("&");
  return `${base}?station_id,time,Water_Level_LAT&${constraints}`;
}

async function fetchTideReadings(stationId: string, fromDate: string, toDate: string) {
  const url = buildUrl(stationId, fromDate, toDate);
  console.log(`  Fetching tides: ${stationId} from ${fromDate} to ${toDate}`);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`  HTTP ${res.status} for station ${stationId} — skipping. ${body.slice(0, 300)}`);
    return [];
  }
  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 3) return [];

  const headers  = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, ""));
  const timeIdx  = headers.findIndex((h) => h === "time");
  const levelIdx = headers.findIndex((h) => h.includes("water_level_lat"));

  if (timeIdx === -1 || levelIdx === -1) {
    console.warn(`  Unexpected columns: ${headers.join(",")} — expected time and water_level_lat`);
    return [];
  }

  const records: Array<{ time: string; level: number | null }> = [];
  for (let i = 2; i < lines.length; i++) {
    const parts    = lines[i].split(",");
    const time     = parts[timeIdx]?.trim();
    const levelRaw = parseFloat(parts[levelIdx]?.trim() ?? "");
    if (!time) continue;
    records.push({ time, level: isNaN(levelRaw) ? null : levelRaw });
  }
  return records;
}

interface DailyTide {
  date: string;
  tideRange: number;
  highTimes: string;   // comma-joined HH:MM, or empty
  lowTimes: string;
}

function aggregateTides(records: Array<{ time: string; level: number | null }>): DailyTide[] {
  const byDate: Record<string, { times: string[]; levels: (number | null)[] }> = {};
  for (const r of records) {
    const date = r.time.split("T")[0];
    if (!byDate[date]) byDate[date] = { times: [], levels: [] };
    byDate[date].times.push(r.time);
    byDate[date].levels.push(r.level);
  }

  return Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([date, { times, levels }]) => {
      const clean = levels.filter((v): v is number => v !== null);
      if (!clean.length) return [];
      return [{
        date,
        tideRange: Math.max(...clean) - Math.min(...clean),
        highTimes: findExtrema(times, levels, "max").join(","),
        lowTimes:  findExtrema(times, levels, "min").join(","),
      }];
    });
}

async function ingestTidesForStation(beachId: number, stationId: string) {
  const fromDate = "2006-01-01T00:00:00Z";
  const toDate   = new Date().toISOString().split("T")[0] + "T23:59:59Z";

  const records = await fetchTideReadings(stationId, fromDate, toDate);
  if (!records.length) return;

  const daily = aggregateTides(records);
  console.log(`  Aggregated ${daily.length} tide days for ${stationId} — upserting in chunks of ${CHUNK_SIZE}...`);

  for (let i = 0; i < daily.length; i += CHUNK_SIZE) {
    const chunk       = daily.slice(i, i + CHUNK_SIZE);
    const beachIds    = chunk.map(() => beachId);
    const dates       = chunk.map((r) => r.date);
    const tideRanges  = chunk.map((r) => r.tideRange);
    const highTimes   = chunk.map((r) => r.highTimes || null);
    const lowTimes    = chunk.map((r) => r.lowTimes  || null);

    await sql`
      INSERT INTO observations (beach_id, date, tide_range_m, high_tide_times, low_tide_times, source_flags)
      SELECT b::integer, d::date, tr, ht, lt, '{"tide":"gauge"}'::jsonb
      FROM unnest(
        ${beachIds}::integer[],
        ${dates}::text[],
        ${tideRanges}::float4[],
        ${highTimes}::text[],
        ${lowTimes}::text[]
      ) AS t(b, d, tr, ht, lt)
      ON CONFLICT (beach_id, date) DO UPDATE SET
        tide_range_m    = EXCLUDED.tide_range_m,
        high_tide_times = EXCLUDED.high_tide_times,
        low_tide_times  = EXCLUDED.low_tide_times,
        source_flags    = COALESCE(observations.source_flags, '{}'::jsonb) || EXCLUDED.source_flags
    `;
    if ((i / CHUNK_SIZE) % 5 === 0) {
      console.log(`    ${Math.min(i + CHUNK_SIZE, daily.length)}/${daily.length}`);
    }
  }
}

async function main() {
  for (const beach of BEACHES) {
    const rows = await sql`SELECT id FROM beaches WHERE slug = ${beach.slug}`;
    if (!rows.length) { console.warn(`Beach not found: ${beach.slug}`); continue; }
    await ingestTidesForStation((rows[0] as { id: number }).id, beach.stationId);
  }
  console.log("Tide ingest complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
