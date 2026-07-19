import { neon } from "@neondatabase/serverless";

function db() {
  return neon(process.env.DATABASE_URL!);
}

export async function getBeaches() {
  const sql = db();
  return sql`SELECT * FROM beaches ORDER BY name`;
}

export async function getBeachBySlug(slug: string) {
  const sql = db();
  const rows = await sql`SELECT * FROM beaches WHERE slug = ${slug} LIMIT 1`;
  return rows[0] ?? null;
}

export async function getIncidentsByBeach(beachId: number) {
  const sql = db();
  return sql`
    SELECT i.*, f.features
    FROM incidents i
    LEFT JOIN incident_fingerprints f ON f.incident_id = i.id
    WHERE i.beach_id = ${beachId}
    ORDER BY i.date DESC
  `;
}

export async function getIncidentById(id: number) {
  const sql = db();
  const rows = await sql`
    SELECT i.*, f.features, b.slug AS beach_slug, b.name AS beach_name, b.lat, b.lon
    FROM incidents i
    JOIN beaches b ON b.id = i.beach_id
    LEFT JOIN incident_fingerprints f ON f.incident_id = i.id
    WHERE i.id = ${id}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getObservationWindow(beachId: number, endDate: string, days = 8) {
  const sql = db();
  return sql`
    SELECT * FROM observations
    WHERE beach_id = ${beachId}
      AND date <= ${endDate}::date
      AND date >= (${endDate}::date - INTERVAL '1 day' * ${days})
    ORDER BY date ASC
  `;
}

export async function getRecentObservations(beachId: number, days = 30) {
  const sql = db();
  return sql`
    SELECT * FROM observations
    WHERE beach_id = ${beachId}
      AND date >= NOW() - INTERVAL '1 day' * ${days}
    ORDER BY date DESC
  `;
}

export async function getAllFingerprints(beachId: number) {
  const sql = db();
  return sql`
    SELECT f.incident_id, f.features, i.date, i.title, i.type, i.severity
    FROM incident_fingerprints f
    JOIN incidents i ON i.id = f.incident_id
    WHERE i.beach_id = ${beachId}
  `;
}

export async function upsertObservation(beachId: number, date: string, data: Record<string, unknown>) {
  const sql = db();
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (!keys.length) return;

  const cols = ["beach_id", "date", ...keys];
  const vals = [beachId, date, ...keys.map((k) => data[k])];

  const setClauses = keys.map((k) => `${k} = EXCLUDED.${k}`).join(", ");

  await sql.query(
    `INSERT INTO observations (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
     ON CONFLICT (beach_id, date) DO UPDATE SET ${setClauses}`,
    vals
  );
}

export async function upsertIncidentFingerprint(incidentId: number, features: object) {
  const sql = db();
  await sql`
    INSERT INTO incident_fingerprints (incident_id, features, computed_at)
    VALUES (${incidentId}, ${JSON.stringify(features)}, NOW())
    ON CONFLICT (incident_id) DO UPDATE
      SET features = EXCLUDED.features, computed_at = EXCLUDED.computed_at
  `;
}
