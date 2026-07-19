import { neon } from "@neondatabase/serverless";
import { readFileSync } from "fs";
import { resolve } from "path";

const sql = neon(process.env.DATABASE_URL!);

interface IncidentRecord {
  date: string;
  type: string;
  severity: number;
  casualties: number;
  title: string;
  description: string;
  source_url: string;
  source_type: string;
}

async function main() {
  const beaches = await sql`SELECT id, slug FROM beaches`;
  for (const beach of beaches as Array<{ id: number; slug: string }>) {
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
        INSERT INTO incidents (beach_id, date, type, severity, casualties, title, description, source_url, source_type)
        VALUES (${beach.id}, ${inc.date}::date, ${inc.type}, ${inc.severity}, ${inc.casualties},
                ${inc.title}, ${inc.description}, ${inc.source_url}, ${inc.source_type})
        ON CONFLICT DO NOTHING
      `;
    }
    console.log(`Seeded ${incidents.length} incidents for ${beach.slug}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
