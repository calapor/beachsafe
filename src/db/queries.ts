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
      AND i.condition_related IS NOT FALSE
      AND i.activity IN ('swimmer', 'shore')
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
      AND i.activity IN ('swimmer', 'shore')
      AND i.condition_related IS NOT FALSE
  `;
}

export async function getAnnualObservations(beachId: number) {
  const sql = db();
  return sql`
    SELECT date, wave_height_m, moon_illum, tide_range_m, max_gust_knots, mean_wind_knots
    FROM observations
    WHERE beach_id = ${beachId}
      AND date >= CURRENT_DATE - INTERVAL '1 year'
    ORDER BY date ASC
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

export async function getExcludedIncidentCounts(beachId: number) {
  const sql = db();
  return sql`
    SELECT activity, exclusion_cause, count(*)::int AS n
    FROM incidents
    WHERE beach_id = ${beachId}
      AND (
        activity NOT IN ('swimmer', 'shore')
        OR condition_related IS FALSE
      )
    GROUP BY activity, exclusion_cause
    ORDER BY n DESC
  `;
}

export async function getClimatology(beachId: number, month: number) {
  const sql = db();
  return sql`
    SELECT metric, n, coverage_start, coverage_end, ladder
    FROM climatology
    WHERE beach_id = ${beachId} AND month = ${month}
  `;
}

export async function upsertClimatology(
  beachId: number, month: number, metric: string,
  n: number, coverageStart: string, coverageEnd: string, ladder: number[]
) {
  const sql = db();
  await sql`
    INSERT INTO climatology (beach_id, month, metric, n, coverage_start, coverage_end, ladder, computed_at)
    VALUES (${beachId}, ${month}, ${metric}, ${n}, ${coverageStart}::date, ${coverageEnd}::date, ${JSON.stringify(ladder)}, NOW())
    ON CONFLICT (beach_id, month, metric) DO UPDATE SET
      n              = EXCLUDED.n,
      coverage_start = EXCLUDED.coverage_start,
      coverage_end   = EXCLUDED.coverage_end,
      ladder         = EXCLUDED.ladder,
      computed_at    = EXCLUDED.computed_at
  `;
}

export async function getFeatureDiscrimination() {
  const sql = db();
  return sql`SELECT * FROM feature_discrimination ORDER BY feature, scope`;
}

export async function upsertFeatureDiscrimination(
  feature: string, scope: string, nCase: number, nControl: number,
  auc: number | null, aucLo: number | null, aucHi: number | null,
  lift: number | null, liftLo: number | null, liftHi: number | null,
) {
  const sql = db();
  await sql`
    INSERT INTO feature_discrimination
      (feature, scope, n_case, n_control, auc, auc_lo, auc_hi, lift, lift_lo, lift_hi, computed_at)
    VALUES
      (${feature}, ${scope}, ${nCase}, ${nControl}, ${auc}, ${aucLo}, ${aucHi}, ${lift}, ${liftLo}, ${liftHi}, NOW())
    ON CONFLICT (feature, scope) DO UPDATE SET
      n_case      = EXCLUDED.n_case,
      n_control   = EXCLUDED.n_control,
      auc         = EXCLUDED.auc,
      auc_lo      = EXCLUDED.auc_lo,
      auc_hi      = EXCLUDED.auc_hi,
      lift        = EXCLUDED.lift,
      lift_lo     = EXCLUDED.lift_lo,
      lift_hi     = EXCLUDED.lift_hi,
      computed_at = EXCLUDED.computed_at
  `;
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
