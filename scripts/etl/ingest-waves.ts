import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

const BEACHES = [
  { slug: "fountainstown", buoyId: "M5" },
  { slug: "ballybunion",   buoyId: "M3" },
  { slug: "skerries",      buoyId: "M2" },
];

function buildErddapUrl(buoyId: string, fromDate: string, toDate: string): string {
  const base = "https://erddap.marine.ie/erddap/tabledap/IWaveBNetwork.csv";
  const params = [
    "station_id,time,SignificantWaveHeight,WavePeriod,SeaTemperature",
    `time>=${fromDate}`,
    `time<=${toDate}`,
    `station_id="${buoyId}"`,
  ];
  return `${base}?${encodeURIComponent(params.join("&"))}`;
}

async function fetchWaves(buoyId: string, fromDate: string, toDate: string) {
  const url = buildErddapUrl(buoyId, fromDate, toDate);
  console.log(`  Fetching waves: ${buoyId} from ${fromDate} to ${toDate}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  HTTP ${res.status} for buoy ${buoyId} — skipping`);
    return [];
  }
  const text = await res.text();
  const lines = text.trim().split("\n");
  // ERDDAP CSV has a units row after the header row
  if (lines.length < 3) return [];

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  // lines[1] is units, skip
  const records: Array<{ date: string; waveHeight: number | null; wavePeriod: number | null; seaTemp: number | null }> = [];

  for (let i = 2; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < headers.length) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = parts[idx]?.trim() ?? ""; });

    const time = row["time"];
    if (!time) continue;
    const date = time.split("T")[0];

    const wh = parseFloat(row["significantwaveheight"]);
    const wp = parseFloat(row["waveperiod"]);
    const st = parseFloat(row["seatemperature"]);

    records.push({
      date,
      waveHeight: isNaN(wh) ? null : wh,
      wavePeriod: isNaN(wp) ? null : wp,
      seaTemp: isNaN(st) ? null : st,
    });
  }
  return records;
}

function aggregate(records: Array<{ date: string; waveHeight: number | null; wavePeriod: number | null; seaTemp: number | null }>) {
  const byDate: Record<string, { heights: number[]; periods: number[]; temps: number[] }> = {};
  for (const r of records) {
    if (!byDate[r.date]) byDate[r.date] = { heights: [], periods: [], temps: [] };
    if (r.waveHeight !== null) byDate[r.date].heights.push(r.waveHeight);
    if (r.wavePeriod !== null) byDate[r.date].periods.push(r.wavePeriod);
    if (r.seaTemp !== null) byDate[r.date].temps.push(r.seaTemp);
  }
  return Object.entries(byDate).map(([date, v]) => ({
    date,
    maxWave: v.heights.length ? Math.max(...v.heights) : null,
    meanPeriod: v.periods.length ? v.periods.reduce((a, b) => a + b, 0) / v.periods.length : null,
    meanSeaTemp: v.temps.length ? v.temps.reduce((a, b) => a + b, 0) / v.temps.length : null,
  }));
}

async function ingestWavesForBeach(beachId: number, buoyId: string) {
  const fromDate = "2005-01-01T00:00:00Z";
  const toDate = new Date().toISOString().split("T")[0] + "T23:59:59Z";

  const records = await fetchWaves(buoyId, fromDate, toDate);
  const daily = aggregate(records);
  console.log(`  Aggregated ${daily.length} wave days for buoy ${buoyId}`);

  for (const row of daily) {
    if (!row.maxWave && !row.meanPeriod && !row.meanSeaTemp) continue;
    await sql`
      INSERT INTO observations (beach_id, date, wave_height_m, wave_period_s, sea_temp_c,
        source_flags)
      VALUES (${beachId}, ${row.date}::date, ${row.maxWave}, ${row.meanPeriod}, ${row.meanSeaTemp},
        '{"waves":"erddap_buoy"}'::jsonb)
      ON CONFLICT (beach_id, date) DO UPDATE SET
        wave_height_m = EXCLUDED.wave_height_m,
        wave_period_s = EXCLUDED.wave_period_s,
        sea_temp_c = EXCLUDED.sea_temp_c,
        source_flags = COALESCE(observations.source_flags, '{}'::jsonb) ||
                       EXCLUDED.source_flags
    `;
  }
}

async function main() {
  for (const beach of BEACHES) {
    const rows = await sql`SELECT id FROM beaches WHERE slug = ${beach.slug}`;
    if (!rows.length) { console.warn(`Beach not found: ${beach.slug}`); continue; }
    await ingestWavesForBeach((rows[0] as { id: number }).id, beach.buoyId);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
