import { execSync } from "child_process";
import { resolve } from "path";

const ROOT = resolve(__dirname, "../..");
const SCRIPTS = resolve(__dirname, ".."); // scripts/

function run(script: string) {
  console.log(`\n=== Running ${script} ===`);
  execSync(`tsx ${resolve(SCRIPTS, script)}`, {
    stdio: "inherit",
    env: { ...process.env },
    cwd: ROOT,
  });
}

const args = new Set(process.argv.slice(2));
const skip = (flag: string) => args.has("--skip-" + flag) || args.has("--skip-all-ingest");

async function main() {
  run("migrate.ts");
  if (!skip("weather")) run("etl/ingest-weather.ts");
  if (!skip("waves"))   run("etl/ingest-waves.ts");
  if (!skip("tides")) run("etl/ingest-tides.ts");
  if (!skip("rnli"))  run("etl/ingest-rnli.ts");
  run("etl/compute-astro.ts");
  run("etl/seed-incidents.ts");
  run("etl/seed-synthetic-obs.ts");
  // Enrich incidents with Claude: time_of_day, activity, condition_related classification
  if (!skip("enrich")) run("etl/enrich-incidents.ts");
  run("etl/build-fingerprints.ts");
  console.log("\n=== ETL complete ===");
}

main().catch((e) => { console.error(e); process.exit(1); });
