import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";
import { resolve } from "path";

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  const schema = readFileSync(resolve(__dirname, "../src/db/schema.sql"), "utf8");
  const statements = schema.split(";").map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await sql.query(stmt);
  }
  console.log("Schema applied.");

  await sql`
    INSERT INTO beaches (slug, name, county, lat, lon, met_station_no, wave_buoy_id, tide_station_id, notes)
    VALUES
      ('fountainstown', 'Fountainstown Beach', 'Cork',   51.7833, -8.2667, '3904', 'M5',  'Ringaskiddy', 'Sheltered cove, E-facing; RNLI Crosshaven covers'),
      ('ballybunion',   'Ballybunion Beach',   'Kerry',  52.5137, -9.6722, '2275', 'M3',  'Kilrush',     'Exposed Atlantic beach, heavy swell, rips'),
      ('skerries',      'Skerries Beach',      'Dublin', 53.5833, -6.1000, '532',  'M2',  'Dublin Port', 'E-coast, tidal exposure, NE swell sensitivity')
    ON CONFLICT (slug) DO NOTHING
  `;
  console.log("Beaches seeded.");

  await sql.query(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS external_id TEXT`);
  await sql.query(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS hour_of_day SMALLINT`);
  await sql.query(`CREATE UNIQUE INDEX IF NOT EXISTS incidents_beach_date_title_key ON incidents(beach_id, date, title)`);
  console.log("Schema migrations applied.");
}

main().catch((e) => { console.error(e); process.exit(1); });
