import { execSync } from "child_process";
import { resolve } from "path";

const ROOT = resolve(__dirname, "../..");

function run(script: string) {
  console.log(`\n=== Running ${script} ===`);
  execSync(`tsx ${resolve(__dirname, script)}`, {
    stdio: "inherit",
    env: { ...process.env },
    cwd: ROOT,
  });
}

async function main() {
  run("migrate.ts");
  run("etl/ingest-weather.ts");
  run("etl/ingest-waves.ts");
  run("etl/compute-astro.ts");
  run("etl/seed-incidents.ts");
  // Seed synthetic observations from approx_conditions as fallback when
  // real weather/wave data is unavailable (e.g. restricted network).
  run("etl/seed-synthetic-obs.ts");
  run("etl/build-fingerprints.ts");
  console.log("\n=== ETL complete ===");
}

main().catch((e) => { console.error(e); process.exit(1); });
