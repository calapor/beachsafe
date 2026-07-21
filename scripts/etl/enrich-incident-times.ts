import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

const DELAY_MS = 2000;

const TIME_PATTERNS: Array<{ re: RegExp; toHour: (m: RegExpMatchArray) => number }> = [
  // "3:45pm", "3pm", "15:00"
  {
    re: /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i,
    toHour: (m) => {
      let h = parseInt(m[1], 10);
      const mins = m[2] ? parseInt(m[2], 10) : 0;
      const period = m[3].toLowerCase();
      if (period === "pm" && h !== 12) h += 12;
      if (period === "am" && h === 12) h = 0;
      // Return UTC approx (BST = UTC+1, so subtract 1)
      return Math.max(0, h - 1);
    },
  },
  // 24-hour "15:30" or "09:00" – only if looks like a standalone time (not a date like 2013)
  {
    re: /\b([01]\d|2[0-3]):([0-5]\d)\b/,
    toHour: (m) => {
      const h = parseInt(m[1], 10);
      return Math.max(0, h - 1); // BST → UTC
    },
  },
  // Qualitative
  { re: /\bmorning\b/i,   toHour: () => 9  },
  { re: /\bafternoon\b/i, toHour: () => 13 },
  { re: /\bevening\b/i,   toHour: () => 18 },
];

function extractHour(text: string): number | null {
  for (const { re, toHour } of TIME_PATTERNS) {
    const m = text.match(re);
    if (m) return toHour(m);
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "BeachSafeBot/1.0 (+https://github.com/calapor/beachsafe)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .slice(0, 8000);
}

async function searchAndExtract(incident: {
  id: number; title: string; date: string; source_url: string;
}): Promise<number | null> {
  const dateStr = incident.date instanceof Date ? incident.date.toISOString() : String(incident.date);
  const year = dateStr.slice(0, 4);
  const domain = extractDomain(incident.source_url);

  // Build a DuckDuckGo Lite search query
  const keywords = incident.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6)
    .join(" ");
  const query = domain
    ? `site:${domain} ${keywords} ${year}`
    : `${keywords} ${year} ireland beach`;

  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  let ddgHtml: string;
  try {
    ddgHtml = await fetchText(ddgUrl);
  } catch (e) {
    console.log(`    DDG search failed for incident ${incident.id}: ${e}`);
    return null;
  }
  await sleep(DELAY_MS);

  // Extract result links from DDG HTML
  const linkRe = /href="(https?:\/\/[^"]+)"/g;
  const candidateUrls: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(ddgHtml)) !== null) {
    const href = m[1];
    // Skip DDG internal links and unrelated domains
    if (href.includes("duckduckgo.com")) continue;
    if (domain && !href.includes(domain)) continue;
    candidateUrls.push(href);
    if (candidateUrls.length >= 3) break;
  }

  for (const url of candidateUrls) {
    try {
      const articleHtml = await fetchText(url);
      const text = stripHtml(articleHtml);
      const hour = extractHour(text);
      if (hour !== null) {
        console.log(`    Found time in article: hour=${hour} UTC (url: ${url})`);
        await sleep(DELAY_MS);
        return hour;
      }
      await sleep(DELAY_MS);
    } catch (e) {
      console.log(`    Failed to fetch ${url}: ${e}`);
    }
  }

  return null;
}

async function main() {
  const incidents = await sql`
    SELECT id, title, date, source_url, source_type
    FROM incidents
    WHERE source_type IN ('news', 'rnli')
      AND hour_of_day IS NULL
    ORDER BY id
  ` as Array<{ id: number; title: string; date: Date | string; source_url: string; source_type: string }>;

  if (!incidents.length) {
    console.log("No incidents need time enrichment.");
    return;
  }

  console.log(`Enriching ${incidents.length} incidents with time-of-day data...`);

  for (const inc of incidents) {
    console.log(`  Incident ${inc.id}: ${inc.title} (${inc.date})`);
    const hour = await searchAndExtract(inc);
    if (hour !== null) {
      await sql`UPDATE incidents SET hour_of_day = ${hour} WHERE id = ${inc.id}`;
      console.log(`  → Updated hour_of_day=${hour}`);
    } else {
      console.log(`  → No time found, leaving NULL`);
    }
  }

  console.log("Incident time enrichment complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
