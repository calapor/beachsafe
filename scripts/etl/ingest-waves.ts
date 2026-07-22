import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

// IWBNetwork uses M2/M3/M5 station IDs; WaveHeight is in metres.
// M3 (51.22N, -10.55W) is the best Atlantic proxy for both Cork and Kerry south/west coasts.
// M2 (53.48N, -5.43W) covers the Irish Sea for Skerries.
const BEACHES = [
  { slug: "fountainstown", buoyId: "M3" },
  { slug: "ballybunion",   buoyId: "M3" },
  { slug: "skerries",      buoyId: "M2" },
];

const DATASET   = "IWBNetwork";
const CHUNK_SIZE = 500;

function buildUrl(buoyId: string, fromDate: string, toDate: string): string {
  const base = `https://erddap.marine.ie/erddap/tabledap/${DATASET}.csv`;
  const fields = "station_id,time,WaveHeight,WavePeriod,SeaTemperature";
  const constraints = [
    `time%3E=${fromDate}`,
    `time%3C=${toDate}`,
    `station_id=%22${buoyId}%22`,
  ].join("&");
  return `${base}?${fields}&${constraints}`;
}

async function fetchWaves(buoyId: string, fromDate: string, toDate: string) {
  const url = buildUrl(buoyId, fromDate, toDate);
  console.log(`  Fetching waves: ${buoyId} from ${fromDate} to ${toDate}`);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`  HTTP ${res.status} for buoy ${buoyId} — skipping. ${body.slice(0, 200)}`);
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

    const wh = parseFloat(row["waveheight"]);
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
    meanSeaTemp: v.temps.length   ? v.temps.reduce((a, b) => a + b, 0) / v.temps.length : null,
  }));
}

async function ingestWavesForBeach(beachId: number, buoyId: string) {
  const fromDate = "2001-01-01T00:00:00Z";
  const toDate   = new Date().toISOString().split("T")[0] + "T23:59:59Z";

  const records = await fetchWaves(buoyId, fromDate, toDate);
  const daily   = aggregate(records).filter((r) => r.maxWave || r.meanPeriod || r.meanSeaTemp);
  console.log(`  Aggregated ${daily.length} wave days for buoy ${buoyId} — upserting in chunks of ${CHUNK_SIZE}...`);

  for (let i = 0; i < daily.length; i += CHUNK_SIZE) {
    const chunk   = daily.slice(i, i + CHUNK_SIZE);
    const beachIds      = chunk.map(() => beachId);
    const dates         = chunk.map((r) => r.date);
    const waveHeights   = chunk.map((r) => r.maxWave);
    const wavePeriods   = chunk.map((r) => r.meanPeriod);
    const seaTemps      = chunk.map((r) => r.meanSeaTemp);

    await sql`
      INSERT INTO observations (beach_id, date, wave_height_m, wave_period_s, sea_temp_c, source_flags)
      SELECT b::integer, d::date, wh, wp, st, '{"waves":"erddap_buoy"}'::jsonb
      FROM unnest(
        ${beachIds}::integer[],
        ${dates}::text[],
        ${waveHeights}::float4[],
        ${wavePeriods}::float4[],
        ${seaTemps}::float4[]
      ) AS t(b, d, wh, wp, st)
      ON CONFLICT (beach_id, date) DO UPDATE SET
        wave_height_m = EXCLUDED.wave_height_m,
        wave_period_s = EXCLUDED.wave_period_s,
        sea_temp_c    = EXCLUDED.sea_temp_c,
        source_flags  = COALESCE(observations.source_flags, '{}'::jsonb) || EXCLUDED.source_flags
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
    await ingestWavesForBeach((rows[0] as { id: number }).id, beach.buoyId);
  }
  console.log("Wave ingest complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
