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

function epochToHour(ms: unknown): number | null {
  if (ms === null || ms === undefined) return null;
  const n = Number(ms);
  if (isNaN(n)) return null;
  return new Date(n).getUTCHours();
}

function str(v: unknown): string {
  return v != null ? String(v).trim() : "";
}

// Only keep incidents where sea conditions directly endangered a person or small craft
const QUALIFYING_REASONS = [
  "in water",
  "blown/swept out to sea",
  "capsize",
  "swamping",
  "person in distress",
  "cut off by tide",
  "man overboard",
  "fell/jumped from height",
];

function isQualifyingIncident(reason: string): boolean {
  const r = reason.toLowerCase();
  return QUALIFYING_REASONS.some((q) => r.includes(q));
}

async function backfillHourOfDay(beachId: number, lat: number, lon: number) {
  const existing = await sql`
    SELECT id, external_id FROM incidents
    WHERE beach_id = ${beachId} AND source_type = 'rnli' AND hour_of_day IS NULL AND external_id IS NOT NULL
  ` as Array<{ id: number; external_id: string }>;

  for (const inc of existing) {
    const params = new URLSearchParams({
      f: "json",
      outFields: "DateTimeOfLaunch,DateOfLaunch",
      where: `ROSNumber = '${inc.external_id}'`,
      resultRecordCount: "1",
      geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
      geometryType: "esriGeometryPoint",
      spatialRel: "esriSpatialRelIntersects",
      distance: String(RADIUS_KM),
      units: "esriSRUnit_Kilometer",
      inSR: "4326",
    });
    try {
      const res = await fetch(`${ARCGIS_BASE}?${params}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const json = await res.json() as { features?: ArcGISFeature[] };
      const epoch = json.features?.[0]?.attributes?.["DateTimeOfLaunch"] ?? json.features?.[0]?.attributes?.["DateOfLaunch"];
      const hour = epochToHour(epoch);
      if (hour != null) {
        await sql`UPDATE incidents SET hour_of_day = ${hour} WHERE id = ${inc.id}`;
        console.log(`  Backfilled hour_of_day=${hour} for incident ${inc.id} (ROS ${inc.external_id})`);
      }
    } catch { /* skip on error */ }
  }
}

async function ingestRnliForBeach(beachId: number, lat: number, lon: number) {
  let offset = 0;
  let total = 0;
  let skipped = 0;

  while (true) {
    console.log(`  Fetching RNLI page offset=${offset} for beach ${beachId}`);
    const { features, exceeded } = await fetchPage(lat, lon, offset);

    for (const f of features) {
      const attrs = f.attributes;

      // On first page, log available fields so station ID mismatches can be diagnosed
      if (offset === 0 && total === 0 && features.indexOf(f) === 0) {
        console.log(`  RNLI fields: ${Object.keys(attrs).join(", ")}`);
      }

      const rosNumber = str(attrs["ROSNumber"] ?? attrs["rosNumber"] ?? attrs["ROSNUMBER"] ?? "");
      if (!rosNumber) { skipped++; continue; }

      const launchEpoch = attrs["DateTimeOfLaunch"] ?? attrs["DateOfLaunch"] ?? attrs["date"];
      const dateStr = epochToDate(launchEpoch);
      if (!dateStr) { skipped++; continue; }
      const hourOfDay = epochToHour(launchEpoch);

      const station = str(attrs["LifeboatStationNameProper"] ?? attrs["LifeboatStationName"] ?? attrs["Station"] ?? "RNLI");
      const reason  = str(attrs["ReasonforLaunch"] ?? attrs["ReasonForLaunch"] ?? attrs["Reason"] ?? "");
      const outcome = str(attrs["OutcomeOfService"] ?? attrs["Outcome"] ?? "");

      if (!isQualifyingIncident(reason)) { skipped++; continue; }

      const title = `RNLI ${station} launch`;
      const description = [reason, outcome].filter(Boolean).join(" — ") || null;

      // Skip if this external_id already in DB (idempotent re-run)
      const existing = await sql`
        SELECT id FROM incidents WHERE external_id = ${rosNumber} LIMIT 1
      `;
      if (existing.length) { skipped++; continue; }

      await sql`
        INSERT INTO incidents
          (beach_id, date, type, severity, casualties, title, description, source_type, external_id, hour_of_day)
        VALUES
          (${beachId}, ${dateStr}::date, 'rnli_launch', 2, 0,
           ${title}, ${description}, 'rnli', ${rosNumber}, ${hourOfDay})
      `;
      total++;
    }

    if (!exceeded || features.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  console.log(`  Inserted ${total} RNLI incidents, skipped ${skipped} for beach ${beachId}`);
}

async function main() {
  for (const beach of BEACHES) {
    const rows = await sql`SELECT id FROM beaches WHERE slug = ${beach.slug}`;
    if (!rows.length) { console.warn(`Beach not found: ${beach.slug}`); continue; }
    const beachId = (rows[0] as { id: number }).id;
    await backfillHourOfDay(beachId, beach.lat, beach.lon);
    await ingestRnliForBeach(beachId, beach.lat, beach.lon);
  }
  console.log("RNLI ingest complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
