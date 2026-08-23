import postgres from "postgres";
import { readFileSync } from "fs";
import { resolve } from "path";

const sql = postgres(process.env.DATABASE_URL!);

async function main() {
  const schema = readFileSync(resolve(__dirname, "../src/db/schema.sql"), "utf8");
  const statements = schema.split(";").map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await sql.unsafe(stmt);
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

  await sql.unsafe(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS external_id TEXT`);
  await sql.unsafe(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS time_of_day TIME`);
  await sql.unsafe(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS time_source TEXT CHECK (time_source IN ('rnli','reported','unknown')) DEFAULT 'unknown'`);
  await sql.unsafe(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS activity TEXT CHECK (activity IN ('swimmer','watercraft','shore','other','unknown')) DEFAULT 'unknown'`);
  await sql.unsafe(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS activity_source TEXT`);
  await sql.unsafe(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS condition_related BOOLEAN`);
  await sql.unsafe(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS exclusion_cause TEXT`);
  await sql.unsafe(`ALTER TABLE incidents ADD COLUMN IF NOT EXISTS activity_evidence TEXT`);

  // Beach-specific offshore wave point (probe-wave-points.ts writes these)
  await sql.unsafe(`ALTER TABLE beaches ADD COLUMN IF NOT EXISTS wave_lat DOUBLE PRECISION`);
  await sql.unsafe(`ALTER TABLE beaches ADD COLUMN IF NOT EXISTS wave_lon DOUBLE PRECISION`);

  // Swell and wind-wave components from Open-Meteo marine (ingest-waves.ts v2)
  await sql.unsafe(`ALTER TABLE observations ADD COLUMN IF NOT EXISTS swell_height_m REAL`);
  await sql.unsafe(`ALTER TABLE observations ADD COLUMN IF NOT EXISTS swell_period_s REAL`);
  await sql.unsafe(`ALTER TABLE observations ADD COLUMN IF NOT EXISTS wind_wave_height_m REAL`);
  // Deduplicate before creating the index (keeps the row with the lowest id per external_id)
  await sql.unsafe(`
    DELETE FROM incident_fingerprints
    WHERE incident_id IN (
      SELECT id FROM incidents
      WHERE external_id IS NOT NULL
        AND id NOT IN (SELECT MIN(id) FROM incidents WHERE external_id IS NOT NULL GROUP BY external_id)
    )
  `);
  await sql.unsafe(`
    DELETE FROM incidents
    WHERE external_id IS NOT NULL
      AND id NOT IN (SELECT MIN(id) FROM incidents WHERE external_id IS NOT NULL GROUP BY external_id)
  `);
  // Drop and recreate to ensure it's a non-partial index (earlier versions created it as partial)
  await sql.unsafe(`DROP INDEX IF EXISTS incidents_external_id`);
  await sql.unsafe(`CREATE UNIQUE INDEX incidents_external_id ON incidents(external_id)`);
  console.log("Schema migrations applied.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => sql.end());
