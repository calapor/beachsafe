/**
 * ETL enrichment pass — calls Claude to extract time_of_day, activity, and
 * condition_related classification from incident descriptions.
 *
 * Only processes incidents where condition_related IS NULL (not yet classified).
 * Writes results back as a chunked batch upsert.
 */
import Anthropic from "@anthropic-ai/sdk";
import { neon } from "@neondatabase/serverless";
import { verifyReportedTime } from "../../src/lib/extract-time";

const sql   = neon(process.env.DATABASE_URL!);
const client = new Anthropic();

const CHUNK_SIZE = 20;

const SYSTEM_PROMPT = `You extract structured information from coastal incident descriptions.
Return ONLY a JSON array — no other text, no markdown fences.

For each element in the input array (identified by "id"), return an object with these fields:
- id: (number) the incident id, unchanged
- time_of_day: "HH:MM" in 24h format if an explicit clock time is stated, otherwise null
- activity: one of "swimmer" | "watercraft" | "shore" | "other" | "unknown"
  - swimmer: person swimming, bathing, snorkeling, paddling on foot
  - watercraft: kayak, lilo, inflatable, dinghy, jet ski, sailboat, kite, windsurfer
  - shore: person on rocks, cliff, sand, cut off by tide
  - other: only if clearly not the above (e.g., dog rescue)
  - unknown: if description gives insufficient information
- condition_related: true if the incident was CAUSED by sea/weather conditions
  (swimmer in difficulty, rip current, big surf, inflatable blown offshore, person cut off by tide);
  false if it was man-overboard, medical emergency, mechanical failure, or false alarm/hoax
- exclusion_cause: one of "man_overboard" | "medical" | "mechanical" | "false_alarm" | null
  Set only when condition_related is false. Otherwise null.
- evidence: a brief quote (<20 words) from the description supporting your answers

When in doubt about condition_related, prefer true (coastal conditions are usually involved).
Return null for time_of_day unless a specific clock time is stated in the text.`;

interface EnrichResult {
  id: number;
  time_of_day: string | null;
  activity: string;
  condition_related: boolean;
  exclusion_cause: string | null;
  evidence: string;
}

interface IncidentRow {
  id: number;
  description: string | null;
}

async function enrichBatch(batch: IncidentRow[]): Promise<EnrichResult[]> {
  const input = batch.map((r) => ({ id: r.id, description: r.description ?? "" }));

  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // Prompt caching: system prompt is reused across every batch
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: JSON.stringify(input),
      },
    ],
  });

  let raw = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "[]";
  // Strip markdown code fences if present (```json ... ``` or ``` ... ```)
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  let parsed: EnrichResult[];
  try {
    parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
  } catch (e) {
    console.warn(`  Failed to parse Claude response: ${e}`);
    return [];
  }

  // Apply verifyReportedTime guard — reject times not literally present in source
  for (const result of parsed) {
    const row = batch.find((r) => r.id === result.id);
    if (!row) continue;
    result.time_of_day = verifyReportedTime(row.description ?? "", result.time_of_day);
  }

  return parsed;
}

async function upsertResults(results: EnrichResult[]) {
  if (!results.length) return;

  const ids:              number[]          = results.map((r) => r.id);
  const timeOfDays:       (string | null)[] = results.map((r) => r.time_of_day);
  const timeSources:      string[]          = results.map((r) => r.time_of_day ? "reported" : "unknown");
  const activities:       string[]          = results.map((r) => r.activity);
  const activitySources:  string[]          = results.map(() => "reported");
  const conditionRelated: boolean[]         = results.map((r) => r.condition_related);
  const exclusionCauses:  (string | null)[] = results.map((r) => r.exclusion_cause);
  const evidences:        (string | null)[] = results.map((r) => r.evidence ?? null);

  await sql`
    UPDATE incidents SET
      time_of_day       = CASE WHEN t IS NULL THEN NULL ELSE t::time END,
      time_source       = ts,
      activity          = ac,
      activity_source   = as_,
      condition_related = cr::boolean,
      exclusion_cause   = ec,
      activity_evidence = ev
    FROM unnest(
      ${ids}::integer[],
      ${timeOfDays}::text[],
      ${timeSources}::text[],
      ${activities}::text[],
      ${activitySources}::text[],
      ${conditionRelated}::boolean[],
      ${exclusionCauses}::text[],
      ${evidences}::text[]
    ) AS u(id, t, ts, ac, as_, cr, ec, ev)
    WHERE incidents.id = u.id
  `;
}

async function main() {
  const unclassified = await sql`
    SELECT id, description
    FROM incidents
    WHERE condition_related IS NULL
    ORDER BY id
  ` as IncidentRow[];

  if (!unclassified.length) {
    console.log("No unclassified incidents — enrichment not needed.");
    return;
  }

  console.log(`Enriching ${unclassified.length} incidents with Claude...`);
  let processed = 0;

  for (let i = 0; i < unclassified.length; i += CHUNK_SIZE) {
    const batch = unclassified.slice(i, i + CHUNK_SIZE);
    const results = await enrichBatch(batch);
    await upsertResults(results);
    processed += batch.length;
    console.log(`  ${processed}/${unclassified.length} processed`);
  }

  console.log("Enrichment complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
