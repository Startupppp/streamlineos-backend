import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * Runs the pending-migration worker once per configured region, and reports per
 * region.
 *
 * Phase 3, ticket 11. A single pass that says only "ok" or "failed" hides a
 * partial rollout, which is the state that actually hurts: two regions migrated,
 * one not, and an application booting against all three.
 *
 * The migration logic itself is not duplicated here. `run-pending-migrations.mjs`
 * stays the one place that knows how to read the journal, compute the watermark
 * and apply a file; this only decides which database it points at. Duplicating
 * the worker per region is how the two copies would drift, and a migration runner
 * that drifts is a schema that drifts.
 *
 *   pnpm db:migrate:regions             # every configured region
 *   pnpm db:migrate:regions --dry-run   # say what would run, change nothing
 *   pnpm db:migrate:regions --region=eu # one region
 */

const WORKER = path.join(import.meta.dirname, "run-pending-migrations.mjs");

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--region="))?.slice("--region=".length);
const passthrough = args.filter((a) => !a.startsWith("--region="));

/** Mirrors `region.config.ts`: `REGION_<KEY>_APP_DATABASE_URL`, dashes to underscores. */
function envKey(region, suffix) {
  return `REGION_${region.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

function read(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function topology() {
  const primary = (read("PRIMARY_REGION") ?? "primary").toLowerCase();
  const raw = read("REGION_KEYS");

  const keys = raw
    ? raw.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean)
    : [primary];
  if (!keys.includes(primary)) keys.unshift(primary);

  return keys.map((key) => {
    const isPrimary = key === primary;
    // Only the primary inherits the flat variables. A secondary that fell back
    // to them would migrate the primary twice under two names and report both
    // as healthy.
    const url = isPrimary
      ? read(envKey(key, "APP_DATABASE_URL"), envKey(key, "DATABASE_URL"), "DATABASE_URL", "DB")
      : read(envKey(key, "APP_DATABASE_URL"), envKey(key, "DATABASE_URL"));

    return { key, url, isPrimary };
  });
}

const regions = topology().filter((r) => !only || r.key === only);

if (regions.length === 0) {
  console.error(only ? `No region named "${only}" is configured.` : "No regions configured.");
  process.exit(1);
}

console.log(`Migrating ${regions.length} region(s): ${regions.map((r) => r.key).join(", ")}\n`);

const results = [];

for (const region of regions) {
  console.log(`── ${region.key} ${"─".repeat(Math.max(0, 40 - region.key.length))}`);

  if (!region.url) {
    console.error(`  ! no database configured. Set ${envKey(region.key, "APP_DATABASE_URL")}.`);
    results.push({ region: region.key, status: "unconfigured" });
    continue;
  }

  const run = spawnSync(process.execPath, [WORKER, ...passthrough], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: region.url },
  });

  // A region that fails does not stop the others from being attempted or
  // reported: knowing which three of four succeeded is the point.
  results.push({
    region: region.key,
    status: run.status === 0 ? "ok" : "failed",
    code: run.status ?? undefined,
  });
  console.log("");
}

console.log("── result ".padEnd(44, "─"));
for (const result of results) {
  const mark = result.status === "ok" ? "✓" : "✗";
  const detail = result.status === "failed" ? ` (exit ${result.code})` : "";
  console.log(`  ${mark} ${result.region}: ${result.status}${detail}`);
}

const failed = results.filter((r) => r.status !== "ok");
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} region(s) did not migrate.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} region(s) migrated.`);
