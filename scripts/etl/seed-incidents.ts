import postgres from "postgres";
import { readFileSync } from "fs";
import { resolve } from "path";

const sql = postgres(process.env.DATABASE_URL!);

interface IncidentRecord {
  date: string;
  type: string;
  severity: number;
  casualties: number;
  title: string;
  description: string;
  source_url: string;
  source_type: string;
  // Optional enrichment fields (explicit values win over the enrichment pass)
  time_of_day?: string | null;
  time_source?: string | null;
  activity?: string | null;
  activity_source?: string | null;
  condition_related?: boolean | null;
  exclusion_cause?: string | null;
}

async function main() {
  const beaches = await sql`SELECT id, slug FROM beaches`;
  for (const beach of beaches as unknown as Array<{ id: number; slug: string }>) {
    const filePath = resolve(__dirname, `../../data/incidents.${beach.slug}.json`);
    let incidents: IncidentRecord[];
    try {
      incidents = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      console.log(`No incident file for ${beach.slug}, skipping`);
      continue;
    }

    for (const inc of incidents) {
      await sql`
        INSERT INTO incidents
          (beach_id, date, type, severity, casualties, title, description, source_url, source_type,
           time_of_day, time_source, activity, activity_source, condition_related, exclusion_cause)
        VALUES
          (${beach.id}, ${inc.date}::date, ${inc.type}, ${inc.severity}, ${inc.casualties},
           ${inc.title}, ${inc.description}, ${inc.source_url}, ${inc.source_type},
           ${inc.time_of_day ?? null}::time,
           ${inc.time_source ?? "unknown"},
           ${inc.activity ?? "unknown"},
           ${inc.activity_source ?? null},
           ${inc.condition_related ?? null},
           ${inc.exclusion_cause ?? null})
        ON CONFLICT DO NOTHING
      `;
    }
    console.log(`Seeded ${incidents.length} incidents for ${beach.slug}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => sql.end());
