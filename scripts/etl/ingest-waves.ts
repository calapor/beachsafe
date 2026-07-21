import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

const BEACHES = [
  { slug: "fountainstown", buoyId: "M5" },
  { slug: "ballybunion",   buoyId: "M3" },
  { slug: "skerries",      buoyId: "M2" },
];

const CHUNK = 500;

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

async function getLastObsDate(beachId: number): Promise<string | null> {
  const rows = await sql`
    SELECT MAX(date)::text AS max_date FROM observations
    WHERE beach_id = ${beachId} AND wave_height_m IS NOT NULL
  `;
  return (rows[0] as { max_date: string | null }).max_date ?? null;
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
  if (lines.length < 3) return [];

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
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
      seaTemp:    isNaN(st) ? null : st,
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
    if (r.seaTemp    !== null) byDate[r.date].temps.push(r.seaTemp);
  }
  return Object.entries(byDate).map(([date, v]) => ({
    date,
    maxWave:     v.heights.length ? Math.max(...v.heights) : null,
    meanPeriod:  v.periods.length ? v.periods.reduce((a, b) => a + b, 0) / v.periods.length : null,
    meanSeaTemp: v.temps.length   ? v.temps.reduce((a, b) => a + b, 0)   / v.temps.length   : null,
  }));
}

async function ingestWavesForBeach(beachId: number, buoyId: string) {
  const lastDate = await getLastObsDate(beachId);
  const fromDate = lastDate
    ? new Date(new Date(lastDate).getTime() - 7 * 86400_000).toISOString().split("T")[0] + "T00:00:00Z"
    : "2005-01-01T00:00:00Z";
  const toDate = new Date().toISOString().split("T")[0] + "T23:59:59Z";

  const records = await fetchWaves(buoyId, fromDate, toDate);
  const daily = aggregate(records).filter((r) => r.maxWave !== null || r.meanPeriod !== null || r.meanSeaTemp !== null);
  console.log(`  Aggregated ${daily.length} wave days for buoy ${buoyId}`);

  for (let start = 0; start < daily.length; start += CHUNK) {
    const chunk = daily.slice(start, start + CHUNK);
    const placeholders: string[] = [];
    const vals: unknown[] = [];
    let p = 1;

    for (const row of chunk) {
      vals.push(beachId, row.date, row.maxWave, row.meanPeriod, row.meanSeaTemp);
      placeholders.push(`($${p},$${p+1}::date,$${p+2},$${p+3},$${p+4},'{"waves":"erddap_buoy"}'::jsonb)`);
      p += 5;
    }

    console.log(`  Upserting waves ${start + 1}–${start + chunk.length} / ${daily.length}`);
    await sql.query(
      `INSERT INTO observations (beach_id, date, wave_height_m, wave_period_s, sea_temp_c, source_flags)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (beach_id, date) DO UPDATE SET
         wave_height_m = EXCLUDED.wave_height_m,
         wave_period_s = EXCLUDED.wave_period_s,
         sea_temp_c    = EXCLUDED.sea_temp_c,
         source_flags  = COALESCE(observations.source_flags, '{}'::jsonb) || EXCLUDED.source_flags`,
      vals
    );
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
