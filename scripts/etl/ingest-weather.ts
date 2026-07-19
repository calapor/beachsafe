import { neon } from "@neondatabase/serverless";
import { parse } from "date-fns";

const sql = neon(process.env.DATABASE_URL!);

const BEACHES = [
  { slug: "fountainstown", stationNo: "3904" },
  { slug: "ballybunion",   stationNo: "2275" },
  { slug: "skerries",      stationNo: "532" },
];

async function parseMetCsv(csv: string): Promise<Array<Record<string, string>>> {
  const lines = csv.split("\n");
  // Find header row — Met Éireann CSVs have preamble lines before the data header
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes("date") && lines[i].includes(",")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new Error("Could not find CSV header");

  const headers = lines[headerIdx].split(",").map((h) => h.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, ""));
  const rows: Array<Record<string, string>> = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = (parts[idx] ?? "").trim(); });
    rows.push(row);
  }
  return rows;
}

function num(v: string | undefined): number | null {
  if (!v || v === "" || v.toLowerCase() === "null") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function parseWindDir(v: string | undefined): number | null {
  if (!v) return null;
  const compass: Record<string, number> = {
    N: 0, NNE: 22.5, NE: 45, ENE: 67.5,
    E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
    S: 180, SSW: 202.5, SW: 225, WSW: 247.5,
    W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
  };
  const clean = v.trim().toUpperCase();
  if (compass[clean] !== undefined) return compass[clean];
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

export async function ingestWeatherForStation(beachId: number, stationNo: string) {
  const url = `https://cli.fusio.net/cli/climate_data/webdata/dly${stationNo}.csv`;
  console.log(`  Fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const text = await res.text();
  const rows = await parseMetCsv(text);

  let inserted = 0;
  for (const row of rows) {
    const dateStr = row["date"] || row[""];
    if (!dateStr) continue;
    // Met Éireann format: DD-Mon-YYYY or YYYY-MM-DD
    let parsedDate: Date;
    try {
      if (/^\d{2}-[A-Za-z]{3}-\d{4}$/.test(dateStr)) {
        parsedDate = parse(dateStr, "dd-MMM-yyyy", new Date());
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        parsedDate = new Date(dateStr);
      } else {
        continue;
      }
    } catch { continue; }

    const isoDate = parsedDate.toISOString().split("T")[0];

    const windDirKey = Object.keys(row).find((k) => k.includes("wind") && k.includes("dir"));
    const data = {
      rain_mm:         num(row["rain"] ?? row["rain_mm"]),
      temp_max_c:      num(row["maxtp"] ?? row["max_temp"] ?? row["temp_max"]),
      temp_min_c:      num(row["mintp"] ?? row["min_temp"] ?? row["temp_min"]),
      mean_wind_knots: num(row["wdsp"] ?? row["mean_wind"]),
      max_gust_knots:  num(row["maxgt"] ?? row["max_gust"]),
      wind_dir_deg:    parseWindDir(windDirKey ? row[windDirKey] : undefined),
      mslp_hpa:        num(row["msl"] ?? row["mslp"] ?? row["pressure"]),
    };

    const hasData = Object.values(data).some((v) => v !== null);
    if (!hasData) continue;

    const cols = ["beach_id", "date", ...Object.keys(data).filter((k) => (data as Record<string, unknown>)[k] !== null)];
    const vals = [beachId, isoDate, ...Object.keys(data).filter((k) => (data as Record<string, unknown>)[k] !== null).map((k) => (data as Record<string, unknown>)[k])];
    const setClauses = cols.slice(2).map((c) => `${c} = EXCLUDED.${c}`).join(", ");

    await sql.query(
      `INSERT INTO observations (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
       ON CONFLICT (beach_id, date) DO UPDATE SET ${setClauses}`,
      vals
    );
    inserted++;
  }
  console.log(`  Inserted/updated ${inserted} weather rows for beach ${beachId}`);
}

async function main() {
  for (const beach of BEACHES) {
    const rows = await sql`SELECT id FROM beaches WHERE slug = ${beach.slug}`;
    if (!rows.length) { console.warn(`Beach not found: ${beach.slug}`); continue; }
    const beachId = (rows[0] as { id: number }).id;
    await ingestWeatherForStation(beachId, beach.stationNo);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
