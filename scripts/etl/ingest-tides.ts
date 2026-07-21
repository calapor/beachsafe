import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

const BEACHES = [
  { slug: "fountainstown", stationId: "Ringaskiddy" },
  { slug: "ballybunion",   stationId: "Kilrush" },
  { slug: "skerries",      stationId: "Dublin Port" },
];

const SMOOTH_HALF = 6;
const MIN_SEP_STEPS = 36;
const CHUNK = 500;

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

async function getLastObsDate(beachId: number): Promise<string | null> {
  const rows = await sql`
    SELECT MAX(date)::text AS max_date FROM observations
    WHERE beach_id = ${beachId} AND tide_range_m IS NOT NULL
  `;
  return (rows[0] as { max_date: string | null }).max_date ?? null;
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
  const lastDate = await getLastObsDate(beachId);
  const fromDate = lastDate
    ? new Date(new Date(lastDate).getTime() - 7 * 86400_000).toISOString().replace(".000Z", "Z").split("T")[0] + "T00:00:00Z"
    : "2006-01-01T00:00:00Z";
  const toDate = new Date().toISOString().split("T")[0] + "T23:59:59Z";

  const records = await fetchTideReadings(stationId, fromDate, toDate);
  if (!records.length) return;

  const byDate: Record<string, { times: string[]; levels: (number | null)[] }> = {};
  for (const r of records) {
    const date = r.time.split("T")[0];
    if (!byDate[date]) byDate[date] = { times: [], levels: [] };
    byDate[date].times.push(r.time);
    byDate[date].levels.push(r.level);
  }

  const dates = Object.keys(byDate).sort();
  console.log(`  Aggregating ${dates.length} tide days for ${stationId}`);

  // Compute daily summaries first (CPU-bound, no I/O)
  const rows: Array<{ date: string; tideRange: number; highTimes: string | null; lowTimes: string | null }> = [];
  for (const date of dates) {
    const { times, levels } = byDate[date];
    const cleanLevels = levels.filter((v): v is number => v !== null);
    if (!cleanLevels.length) continue;

    rows.push({
      date,
      tideRange: Math.max(...cleanLevels) - Math.min(...cleanLevels),
      highTimes: findExtrema(times, levels, "max").join(",") || null,
      lowTimes:  findExtrema(times, levels, "min").join(",") || null,
    });
  }

  // Bulk upsert in chunks of CHUNK rows
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const placeholders: string[] = [];
    const vals: unknown[] = [];
    let p = 1;

    for (const row of chunk) {
      vals.push(beachId, row.date, row.tideRange, row.highTimes, row.lowTimes);
      placeholders.push(`($${p},$${p+1}::date,$${p+2},$${p+3},$${p+4},'{"tide":"gauge"}'::jsonb)`);
      p += 5;
    }

    console.log(`  Upserting tides ${start + 1}–${start + chunk.length} / ${rows.length}`);
    await sql.query(
      `INSERT INTO observations (beach_id, date, tide_range_m, high_tide_times, low_tide_times, source_flags)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (beach_id, date) DO UPDATE SET
         tide_range_m    = EXCLUDED.tide_range_m,
         high_tide_times = EXCLUDED.high_tide_times,
         low_tide_times  = EXCLUDED.low_tide_times,
         source_flags    = COALESCE(observations.source_flags, '{}'::jsonb) || EXCLUDED.source_flags`,
      vals
    );
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
