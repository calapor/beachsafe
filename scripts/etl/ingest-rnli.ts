import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

const BEACHES = [
  { slug: "fountainstown", lat: 51.7833, lon: -8.2667 },
  { slug: "ballybunion",   lat: 52.5137, lon: -9.6722 },
  { slug: "skerries",      lat: 53.5833, lon: -6.1000 },
];

const ARCGIS_BASE =
  "https://services1.arcgis.com/evM5NkxAYjTi6XPw/arcgis/rest/services/RNLI_Return_of_Service/FeatureServer/0/query";
const PAGE_SIZE = 2000;
const RADIUS_KM = 15;
const CHUNK_SIZE = 500;

interface ArcGISFeature {
  attributes: Record<string, unknown>;
}

async function fetchPage(lat: number, lon: number, offset: number): Promise<{ features: ArcGISFeature[]; exceeded: boolean }> {
  const geometry = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });
  const params = new URLSearchParams({
    f: "json",
    outFields: "*",
    resultRecordCount: String(PAGE_SIZE),
    resultOffset: String(offset),
    where: "1=1",
    geometry,
    geometryType: "esriGeometryPoint",
    spatialRel: "esriSpatialRelIntersects",
    distance: String(RADIUS_KM),
    units: "esriSRUnit_Kilometer",
    inSR: "4326",
  });

  const res = await fetch(`${ARCGIS_BASE}?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ArcGIS`);
  const json = await res.json() as { features?: ArcGISFeature[]; exceededTransferLimit?: boolean; error?: { message: string } };
  if (json.error) throw new Error(`ArcGIS error: ${json.error.message}`);
  return {
    features: json.features ?? [],
    exceeded: json.exceededTransferLimit ?? false,
  };
}

function epochToDate(ms: unknown): string | null {
  if (ms === null || ms === undefined) return null;
  const n = Number(ms);
  if (isNaN(n)) return null;
  return new Date(n).toISOString().split("T")[0];
}

function epochToTime(ms: unknown): string | null {
  if (ms === null || ms === undefined) return null;
  const n = Number(ms);
  if (isNaN(n)) return null;
  const d = new Date(n);
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  // Suppress midnight 00:00 — it usually means the time was not recorded
  if (h === "00" && m === "00") return null;
  return `${h}:${m}`;
}

function str(v: unknown): string {
  return v != null ? String(v).trim() : "";
}

// Classify RNLI launches by condition-relatedness using the reason/outcome text.
// Returns { conditionRelated, exclusionCause }.
const EXCLUSION_PATTERNS: { cause: string; re: RegExp }[] = [
  { cause: "man_overboard", re: /man.?over.?board|fell.?over.?board|person.{0,20}(fell|fall).{0,20}(overboard|sea|water)/i },
  { cause: "medical",       re: /medical|person.{0,10}(ill|sick|injured|collapsed|unconscious)|cardiac|heart.?attack|seizure|stroke/i },
  { cause: "mechanical",    re: /mechanical|engine.{0,10}fail|machinery|vessel.{0,10}fail|breakdown|gear.?fail|propeller/i },
  { cause: "false_alarm",   re: /false.?alarm|hoax|cancel|stood.?down|unfounded|nothing.{0,10}found|no.{0,10}trace/i },
];

function classifyConditionRelated(reason: string, outcome: string): { conditionRelated: boolean | null; exclusionCause: string | null } {
  const combined = `${reason} ${outcome}`;
  for (const { cause, re } of EXCLUSION_PATTERNS) {
    if (re.test(combined)) {
      return { conditionRelated: false, exclusionCause: cause };
    }
  }
  // Ambiguous — leave for Claude enrichment pass
  return { conditionRelated: null, exclusionCause: null };
}

interface RnliRecord {
  beachId: number;
  dateStr: string;
  timeOfDay: string | null;
  timeSource: string;
  externalId: string;
  station: string;
  reason: string;
  outcome: string;
  conditionRelated: boolean | null;
  exclusionCause: string | null;
}

async function collectRnliForBeach(beachId: number, lat: number, lon: number): Promise<RnliRecord[]> {
  let offset = 0;
  const records: RnliRecord[] = [];
  let loggedFields = false;

  while (true) {
    console.log(`  Fetching RNLI page offset=${offset} for beach ${beachId}`);
    const { features, exceeded } = await fetchPage(lat, lon, offset);

    for (const f of features) {
      const attrs = f.attributes;

      if (!loggedFields && features.indexOf(f) === 0) {
        console.log(`  RNLI fields: ${Object.keys(attrs).join(", ")}`);
        loggedFields = true;
      }

      const rosNumber = str(attrs["ROSNumber"] ?? attrs["rosNumber"] ?? attrs["ROSNUMBER"] ?? "");
      if (!rosNumber) continue;

      // Prefer DateTimeOfLaunch (has time); fall back to DateOfLaunch (date-only)
      const dateTimeMs = attrs["DateTimeOfLaunch"];
      const dateOnlyMs = attrs["DateOfLaunch"];

      const dateStr =
        epochToDate(dateTimeMs) ??
        epochToDate(dateOnlyMs) ??
        epochToDate(attrs["date"]);
      if (!dateStr) continue;

      // Extract time from DateTimeOfLaunch if available
      const timeOfDay = epochToTime(dateTimeMs);
      const timeSource = timeOfDay ? "rnli" : "unknown";

      const station = str(attrs["LifeboatStationNameProper"] ?? attrs["LifeboatStationName"] ?? attrs["Station"] ?? "RNLI");
      const reason  = str(attrs["ReasonforLaunch"] ?? attrs["ReasonForLaunch"] ?? attrs["Reason"] ?? "");
      const outcome = str(attrs["OutcomeOfService"] ?? attrs["Outcome"] ?? "");

      const { conditionRelated, exclusionCause } = classifyConditionRelated(reason, outcome);

      records.push({ beachId, dateStr, timeOfDay, timeSource, externalId: rosNumber, station, reason, outcome, conditionRelated, exclusionCause });
    }

    if (!exceeded || features.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return records;
}

async function ingestRnliForBeach(beachId: number, lat: number, lon: number) {
  const records = await collectRnliForBeach(beachId, lat, lon);
  console.log(`  Collected ${records.length} RNLI records for beach ${beachId}`);

  // Fetch existing external_ids for this beach so we can split insert vs update
  const existingRows = await sql`
    SELECT id, external_id FROM incidents
    WHERE beach_id = ${beachId} AND external_id IS NOT NULL
  ` as Array<{ id: number; external_id: string }>;
  const existingMap = new Map(existingRows.map(r => [r.external_id, r.id]));

  const toInsert = records.filter(r => !existingMap.has(r.externalId));
  const toUpdate = records.filter(r =>  existingMap.has(r.externalId));

  // Batch INSERT new records
  for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CHUNK_SIZE);
    const beachIds      = chunk.map(r => r.beachId);
    const dates         = chunk.map(r => r.dateStr);
    const timeOfDays    = chunk.map(r => r.timeOfDay);
    const timeSources   = chunk.map(r => r.timeSource);
    const titles        = chunk.map(r => `RNLI ${r.station} launch`);
    const descriptions  = chunk.map(r => [r.reason, r.outcome].filter(Boolean).join(" — ") || null);
    const externalIds   = chunk.map(r => r.externalId);
    const condRelateds  = chunk.map(r => r.conditionRelated);
    const exclCauses    = chunk.map(r => r.exclusionCause);

    await sql`
      INSERT INTO incidents
        (beach_id, date, time_of_day, time_source, type, severity, casualties,
         title, description, source_type, external_id, condition_related, exclusion_cause)
      SELECT
        b::integer, d::date,
        CASE WHEN t IS NULL THEN NULL ELSE t::time END,
        ts, 'rnli_launch', 2, 0, ti, de, 'rnli', ei,
        CASE WHEN cr IS NULL THEN NULL ELSE cr::boolean END,
        ec
      FROM unnest(
        ${beachIds}::integer[],
        ${dates}::text[],
        ${timeOfDays}::text[],
        ${timeSources}::text[],
        ${titles}::text[],
        ${descriptions}::text[],
        ${externalIds}::text[],
        ${condRelateds}::boolean[],
        ${exclCauses}::text[]
      ) AS t(b, d, t, ts, ti, de, ei, cr, ec)
      ON CONFLICT (beach_id, date, title) DO UPDATE SET
        external_id       = COALESCE(incidents.external_id, EXCLUDED.external_id),
        time_of_day       = EXCLUDED.time_of_day,
        time_source       = EXCLUDED.time_source,
        condition_related = COALESCE(incidents.condition_related, EXCLUDED.condition_related),
        exclusion_cause   = COALESCE(incidents.exclusion_cause, EXCLUDED.exclusion_cause)
    `;
  }

  // Batch UPDATE existing records (time_of_day and classification only)
  for (let i = 0; i < toUpdate.length; i += CHUNK_SIZE) {
    const chunk = toUpdate.slice(i, i + CHUNK_SIZE);
    const ids           = chunk.map(r => existingMap.get(r.externalId)!);
    const timeOfDays    = chunk.map(r => r.timeOfDay);
    const timeSources   = chunk.map(r => r.timeSource);
    const condRelateds  = chunk.map(r => r.conditionRelated);
    const exclCauses    = chunk.map(r => r.exclusionCause);

    await sql`
      UPDATE incidents SET
        time_of_day       = CASE WHEN t IS NULL THEN NULL ELSE t::time END,
        time_source       = ts,
        condition_related = COALESCE(incidents.condition_related, CASE WHEN cr IS NULL THEN NULL ELSE cr::boolean END),
        exclusion_cause   = COALESCE(incidents.exclusion_cause, ec)
      FROM unnest(
        ${ids}::integer[],
        ${timeOfDays}::text[],
        ${timeSources}::text[],
        ${condRelateds}::boolean[],
        ${exclCauses}::text[]
      ) AS u(uid, t, ts, cr, ec)
      WHERE incidents.id = u.uid
    `;
  }

  const excluded = records.filter(r => r.conditionRelated === false).length;
  const ambiguous = records.filter(r => r.conditionRelated === null).length;
  console.log(`  Done: ${toInsert.length} inserted, ${toUpdate.length} updated, ${excluded} excluded (non-condition), ${ambiguous} ambiguous`);
}

async function main() {
  for (const beach of BEACHES) {
    const rows = await sql`SELECT id FROM beaches WHERE slug = ${beach.slug}`;
    if (!rows.length) { console.warn(`Beach not found: ${beach.slug}`); continue; }
    await ingestRnliForBeach((rows[0] as { id: number }).id, beach.lat, beach.lon);
  }
  console.log("RNLI ingest complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
