import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

const BEACHES = [
  { slug: "fountainstown", stationId: "Ringaskiddy" },
  { slug: "ballybunion",   stationId: "Kilrush" },
  { slug: "skerries",      stationId: "Dublin Port" },
];

// Smoothing window: 30 min at 5-min resolution = 6 points each side
const SMOOTH_HALF = 6;
// Minimum separation between consecutive highs or lows: 3 hours = 36 five-minute steps
const MIN_SEP_STEPS = 36;

function smoothSeries(vals: (number | null)[]): (number | null)[] {
  return vals.map((_, i) => {
    const window: number[] = [];
    for (let j = Math.max(0, i - SMOOTH_HALF); j <= Math.min(vals.length - 1, i + SMOOTH_HALF); j++) {
      const v = vals[j];
      if (v !== null) window.push(v);
    }
    return window.length ? window.reduce((a, b) => a + b, 0) / window.length : null;
  });
}

function findExtrema(times: string[], vals: (number | null)[], type: "max" | "min"): string[] {
  const smoothed = smoothSeries(vals);
  const results: string[] = [];
  let lastIdx = -MIN_SEP_STEPS - 1;

  for (let i = 1; i < smoothed.length - 1; i++) {
    const v = smoothed[i];
    const prev = smoothed[i - 1];
    const next = smoothed[i + 1];
    if (v === null || prev === null || next === null) continue;

    const isExtreme = type === "max" ? v >= prev && v >= next : v <= prev && v <= next;
    if (isExtreme && i - lastIdx >= MIN_SEP_STEPS) {
      // Extract HH:MM from ISO time string
      const timePart = times[i].split("T")[1]?.slice(0, 5) ?? "";
      if (timePart) results.push(timePart);
      lastIdx = i;
    }
  }
  return results;
}

function buildErddapUrl(stationId: string, fromDate: string, toDate: string): string {
  const base = "https://erddap.marine.ie/erddap/tabledap/IrishNationalTideGaugeNetwork.csv";
  const fields = "station_id,time,Water_Level_LAT,QC_Flag";
  const constraints = [
    `time>=${fromDate}`,
    `time<=${toDate}`,
    `station_id="${stationId}"`,
    `QC_Flag=1`,
  ];
  return `${base}?${encodeURIComponent(`${fields}&${constraints.join("&")}`)}`;
}

async function fetchTideReadings(stationId: string, fromDate: string, toDate: string) {
  const url = buildErddapUrl(stationId, fromDate, toDate);
  console.log(`  Fetching tides: ${stationId} from ${fromDate} to ${toDate}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  HTTP ${res.status} for station ${stationId} — skipping`);
    return [];
  }
  const text = await res.text();
  const lines = text.trim().split("\n");
  // ERDDAP CSV: header row, units row, then data
  if (lines.length < 3) return [];

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, ""));
  const timeIdx = headers.findIndex((h) => h === "time");
  const levelIdx = headers.findIndex((h) => h.includes("water_level_lat") || h === "water_level_lat");

  if (timeIdx === -1 || levelIdx === -1) {
    console.warn(`  Unexpected columns: ${headers.join(",")} — expected time and water_level_lat`);
    return [];
  }

  const records: Array<{ time: string; level: number | null }> = [];
  for (let i = 2; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const time = parts[timeIdx]?.trim();
    const levelRaw = parseFloat(parts[levelIdx]?.trim() ?? "");
    if (!time) continue;
    records.push({ time, level: isNaN(levelRaw) ? null : levelRaw });
  }
  return records;
}

async function ingestTidesForStation(beachId: number, stationId: string) {
  const fromDate = "2006-01-01T00:00:00Z";
  const toDate = new Date().toISOString().split("T")[0] + "T23:59:59Z";

  const records = await fetchTideReadings(stationId, fromDate, toDate);
  if (!records.length) return;

  // Group by calendar date
  const byDate: Record<string, { times: string[]; levels: (number | null)[] }> = {};
  for (const r of records) {
    const date = r.time.split("T")[0];
    if (!byDate[date]) byDate[date] = { times: [], levels: [] };
    byDate[date].times.push(r.time);
    byDate[date].levels.push(r.level);
  }

  const dates = Object.keys(byDate).sort();
  console.log(`  Aggregating ${dates.length} tide days for ${stationId}`);

  for (const date of dates) {
    const { times, levels } = byDate[date];
    const cleanLevels = levels.filter((v): v is number => v !== null);
    if (!cleanLevels.length) continue;

    const tideRange = Math.max(...cleanLevels) - Math.min(...cleanLevels);
    const highTimes = findExtrema(times, levels, "max");
    const lowTimes = findExtrema(times, levels, "min");

    await sql`
      INSERT INTO observations (beach_id, date, tide_range_m, high_tide_times, low_tide_times, source_flags)
      VALUES (
        ${beachId}, ${date}::date,
        ${tideRange},
        ${highTimes.join(",") || null},
        ${lowTimes.join(",") || null},
        '{"tide":"gauge"}'::jsonb
      )
      ON CONFLICT (beach_id, date) DO UPDATE SET
        tide_range_m    = EXCLUDED.tide_range_m,
        high_tide_times = EXCLUDED.high_tide_times,
        low_tide_times  = EXCLUDED.low_tide_times,
        source_flags    = COALESCE(observations.source_flags, '{}'::jsonb) || EXCLUDED.source_flags
    `;
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
