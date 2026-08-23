import { isNeonUrl } from "../src/lib/db-url-guard";

const url = process.env.DATABASE_URL ?? "";

if (isNeonUrl(url)) {
  let host = "(unparseable)";
  try { host = new URL(url).host; } catch { /* noop */ }
  console.error(`ERROR: DATABASE_URL points at Neon (${host})`);
  console.error(`Remediation: update Jenkins credential 'beachsafe-database-url' to the platform-db URL:`);
  console.error(`  postgresql://beachsafe_app:<pw>@platform-postgres.platform.svc.cluster.local:5432/platform_db?options=-csearch_path%3Dbeachsafe&sslmode=disable`);
  process.exit(1);
}

try {
  const host = new URL(url).host;
  console.log(`DATABASE_URL host: ${host} — not Neon ✓`);
} catch {
  console.log("DATABASE_URL: (non-URL format or empty) ✓");
}
