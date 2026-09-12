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
 *   pnpm db:migrate:regions --self-test # exercise the selection rules, touch nothing
 */

const WORKER = path.join(import.meta.dirname, "run-pending-migrations.mjs");

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--region="))?.slice("--region=".length);
const passthrough = args.filter((a) => !a.startsWith("--region=") && a !== "--self-test");

/** Mirrors `region.config.ts`: `REGION_<KEY>_APP_DATABASE_URL`, dashes to underscores. */
function envKey(region, suffix) {
  return `REGION_${region.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

function read(env, ...names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return { name, value: value.trim() };
  }
  return undefined;
}

function regionKeys(env) {
  const primary = (read(env, "PRIMARY_REGION")?.value ?? "primary").toLowerCase();
  const raw = read(env, "REGION_KEYS")?.value;

  const keys = raw
    ? raw.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean)
    : [primary];
  if (!keys.includes(primary)) keys.unshift(primary);

  return { primary, keys };
}

/**
 * Migrations connect as the **owner**, not as the application role.
 *
 * `env.validation.ts` refuses to boot production when `APP_DATABASE_URL` equals
 * `DATABASE_URL`, because the application role is deliberately RLS-enforced and
 * without BYPASSRLS. So the two are different roles, and only one of them can
 * run DDL.
 *
 * This used to read `REGION_<KEY>_APP_DATABASE_URL` first for a secondary while
 * the primary correctly preferred `DATABASE_URL` -- meaning every region but the
 * primary was migrated through the RLS-enforced role. Owner candidates now come
 * first everywhere. Falling back to the application role still works, because a
 * development region often has only one role, but it is reported rather than
 * assumed: a production region migrated by the app role has either failed on
 * privileges or been given an owner-privileged app role, and the second is worse
 * than the first.
 */
function databaseFor(env, key, isPrimary) {
  const owner = isPrimary
    ? read(env, envKey(key, "DATABASE_URL"), "DATABASE_URL", "DB")
    : read(env, envKey(key, "DATABASE_URL"));
  if (owner) return { ...owner, role: "owner" };

  // Only the primary inherits the flat variables. A secondary that fell back to
  // them would migrate the primary twice under two names and report both as
  // healthy.
  const app = read(env, envKey(key, "APP_DATABASE_URL"));
  return app ? { ...app, role: "application" } : undefined;
}

function topology(env) {
  const { primary, keys } = regionKeys(env);

  return keys.map((key) => {
    const isPrimary = key === primary;
    return { key, isPrimary, database: databaseFor(env, key, isPrimary) };
  });
}

/**
 * Regions the environment describes but `REGION_KEYS` does not list.
 *
 * `REGION_KEYS` is the whole list; a per-region URL on its own configures
 * nothing. Setting `REGION_EU_APP_DATABASE_URL` and forgetting `REGION_KEYS`
 * used to migrate the primary, print "All 1 region(s) migrated" and exit 0 --
 * a region skipped by a run that reported success, which is the one outcome
 * this script exists to make impossible.
 */
function unlistedRegions(env, keys) {
  const listed = new Set(keys);
  const found = new Set();

  for (const name of Object.keys(env)) {
    const match = /^REGION_(.+?)_(?:APP_DATABASE_URL|DATABASE_URL)$/.exec(name);
    if (!match) continue;
    const key = match[1].toLowerCase().replace(/_/g, "-");
    if (!listed.has(key)) found.add(key);
  }

  return [...found].sort();
}

if (args.includes("--self-test")) {
  const checks = [];
  const check = (name, actual, expected) =>
    checks.push({ name, pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });

  const three = {
    PRIMARY_REGION: "india",
    REGION_KEYS: "india,eu,us",
    DATABASE_URL: "postgres://owner@india/app",
    REGION_INDIA_APP_DATABASE_URL: "postgres://app@india/app",
    REGION_EU_DATABASE_URL: "postgres://owner@eu/app",
    REGION_EU_APP_DATABASE_URL: "postgres://app@eu/app",
    REGION_US_APP_DATABASE_URL: "postgres://app@us/app",
  };

  const resolved = topology(three);

  check("enumerates every listed region", resolved.map((r) => r.key), ["india", "eu", "us"]);
  check(
    "primary migrates as the owner, not the application role",
    [resolved[0].database.value, resolved[0].database.role],
    ["postgres://owner@india/app", "owner"],
  );
  check(
    "a secondary with both roles migrates as the owner",
    [resolved[1].database.value, resolved[1].database.role],
    ["postgres://owner@eu/app", "owner"],
  );
  check(
    "a secondary with only an application role is used, and says so",
    [resolved[2].database.value, resolved[2].database.role],
    ["postgres://app@us/app", "application"],
  );
  check(
    "a secondary never inherits the primary's flat variables",
    topology({ REGION_KEYS: "primary,eu", DATABASE_URL: "postgres://owner@primary/app" })[1]
      .database ?? null,
    null,
  );
  check(
    "a region configured but unlisted is detected, not skipped",
    unlistedRegions({ REGION_EU_APP_DATABASE_URL: "x", REGION_AP_SOUTH_DATABASE_URL: "y" }, [
      "primary",
    ]),
    ["ap-south", "eu"],
  );
  check("a fully listed environment reports nothing unlisted", unlistedRegions(three, ["india", "eu", "us"]), []);

  const pass = checks.every((c) => c.pass);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

const all = topology(process.env);
const { keys } = regionKeys(process.env);
const regions = all.filter((r) => !only || r.key === only);

if (regions.length === 0) {
  console.error(only ? `No region named "${only}" is configured.` : "No regions configured.");
  process.exit(1);
}

const unlisted = unlistedRegions(process.env, keys);
if (unlisted.length > 0 && !only) {
  console.error(
    `REGION_KEYS does not list ${unlisted.join(", ")}, but the environment configures ` +
      `${unlisted.length === 1 ? "it" : "them"}. Add ${unlisted.length === 1 ? "it" : "them"} ` +
      `to REGION_KEYS, or unset the variables — migrating without ${unlisted.length === 1 ? "it" : "them"} ` +
      `would report success for a region nobody migrated.`,
  );
  process.exit(1);
}

console.log(`Migrating ${regions.length} region(s): ${regions.map((r) => r.key).join(", ")}\n`);

const results = [];

for (const region of regions) {
  console.log(`── ${region.key} ${"─".repeat(Math.max(0, 40 - region.key.length))}`);

  if (!region.database) {
    console.error(`  ! no database configured. Set ${envKey(region.key, "DATABASE_URL")}.`);
    results.push({ region: region.key, status: "unconfigured" });
    continue;
  }

  if (region.database.role === "application")
    console.warn(
      `  ! migrating through ${region.database.name}, the RLS-enforced application role. ` +
        `Set ${envKey(region.key, "DATABASE_URL")} to the owner role if DDL is refused.`,
    );

  const run = spawnSync(process.execPath, [WORKER, ...passthrough], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: region.database.value },
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
