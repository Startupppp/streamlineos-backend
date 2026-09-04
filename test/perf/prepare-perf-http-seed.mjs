#!/usr/bin/env node
/**
 * Makes a perf seed able to answer an authenticated HTTP request.
 *
 * Two rows the perf seed never wrote stop the application dead, and neither is visible to any
 * database-side instrument — which is why 100 benchmarks could be captured against this database
 * while not one route had ever been timed over HTTP.
 *
 * 1. PLACEMENT. `withTenant` resolves the organisation's placement before it opens a tenant
 *    transaction, and `RegionRegistry.resolvePlacement` THROWS when there is no
 *    `organization_placement` row. `MembershipStateService.fetchMembershipState` catches every
 *    throw into `UNKNOWN`, and `JwtAuthGuard` turns `UNKNOWN` into `403 ORG_MEMBERSHIP_INACTIVE`.
 *    So an unplaced seed answers 403 to EVERY authenticated request, with a message about
 *    membership — a placement defect wearing an authorization error's clothes. Measured on
 *    `scratch_perf_seed`: 8 organisations, 0 placement rows, `organizations.region` NULL on all 8.
 *
 * 2. MODULE ENTITLEMENT. `ModuleGuard` throws `ModuleDisabledException` (402 PAYMENT_REQUIRED)
 *    for any `@RequireModule` route whose module has no enabled `org_modules` row. Measured on
 *    the same seed: `org_modules` held ZERO rows, so HR, CRM, inventory, payroll, timesheets,
 *    support, invoices and accounting all answered 402. An organisation with no enabled module is
 *    not production-shaped, and a benchmark run against it measures the guard, not the route.
 *
 * Both are seed gaps, not application defects, and both are fixed here rather than in the app.
 *
 * WHAT IT WRITES
 *
 *   organization_placement  one row per organisation, exactly what `placeOrganization()` writes:
 *                           region `primary`, cell `legacy-1`, shard `primary`, search cluster
 *                           `primary`, version 1, ACTIVE, a fresh write-fence lease.
 *                           `resolvePlacement` refuses a placement whose cellId differs from the
 *                           configured cell, so these are the topology defaults from
 *                           `src/common/region/placement.ts`, not invented values.
 *   org_modules             one enabled row per organisation per `modules_catalog` key. An
 *                           enabled row grants access regardless of plan, which is the documented
 *                           resolution order in `module-availability.ts` step 3.
 *
 * SAFETY
 *
 *   - refuses any database whose name does not contain "scratch", and `cornerstone_*` outright;
 *   - `ON CONFLICT DO NOTHING`, so it never rewrites an existing row;
 *   - dry run by default; prints counts, never a connection string.
 *
 * Usage:
 *   DATABASE_URL=postgres://…/scratch_… node test/perf/prepare-perf-http-seed.mjs
 *   DATABASE_URL=postgres://…/scratch_… node test/perf/prepare-perf-http-seed.mjs --write
 *   node test/perf/prepare-perf-http-seed.mjs --self-test
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";

const LEGACY_CELL_ID = "legacy-1";
const DEFAULT_DATABASE_SHARD = "primary";
const DEFAULT_SEARCH_CLUSTER = "primary";
const DEFAULT_REGION = "primary";
/** `FENCE_LEASE_MS` in src/common/region/placement.ts. */
const FENCE_LEASE_MS = 5 * 60_000;

export function databaseName(url) {
  try {
    return new URL(url).pathname.replace(/^\//, "").split("?")[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * `ssl: false` was hardcoded here, so this script could never reach a managed
 * Postgres that requires TLS — it failed with "connection is insecure" before
 * writing a row, which reads as a seed problem rather than a harness one.
 */
export function sslModeOf(url) {
  try {
    const mode = new URL(url).searchParams.get("sslmode");
    if (mode === "disable") return false;
    return mode ? "require" : false;
  } catch {
    return false;
  }
}

/** The same rule `assertDisposableDatabase` applies, plus an explicit cornerstone refusal. */
export function assertWritable(url) {
  const database = databaseName(url);
  if (!database) return { ok: false, reason: "the connection string does not name a database" };
  if (/^cornerstone/i.test(database))
    return { ok: false, reason: `refusing to write to "${database}" — cornerstone databases are off limits` };
  if (!/scratch/i.test(database))
    return {
      ok: false,
      reason:
        `refusing to write to "${database}" — this places organisations and grants entitlements, so ` +
        `the target must be a disposable database whose name contains "scratch"`,
    };
  return { ok: true, database };
}

export function placementRow(orgId, now = Date.now()) {
  return {
    organization_id: orgId,
    region: DEFAULT_REGION,
    cell_id: LEGACY_CELL_ID,
    database_shard: DEFAULT_DATABASE_SHARD,
    object_storage_region: process.env.R2_REGION ?? "auto",
    search_cluster: DEFAULT_SEARCH_CLUSTER,
    placement_version: 1,
    write_fence_token: randomUUID(),
    lease_expires_at: new Date(now + FENCE_LEASE_MS).toISOString(),
    status: "ACTIVE",
  };
}

async function placeOrganizations(sql, write) {
  const unplaced = await sql.unsafe(
    `SELECT o.id
       FROM organizations o
       LEFT JOIN organization_placement p ON p.organization_id = o.id
      WHERE p.organization_id IS NULL
      ORDER BY o.id`,
  );
  process.stdout.write(`[prepare-perf-http-seed] unplaced organisations: ${String(unplaced.length)}\n`);
  if (!write) return 0;

  let inserted = 0;
  for (const org of unplaced) {
    const row = placementRow(String(org.id));
    const result = await sql.unsafe(
      `INSERT INTO organization_placement
         (organization_id, region, cell_id, database_shard, object_storage_region, search_cluster,
          placement_version, write_fence_token, lease_expires_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (organization_id) DO NOTHING
       RETURNING organization_id`,
      [
        row.organization_id,
        row.region,
        row.cell_id,
        row.database_shard,
        row.object_storage_region,
        row.search_cluster,
        row.placement_version,
        row.write_fence_token,
        row.lease_expires_at,
        row.status,
      ],
    );
    inserted += result.length;
  }
  return inserted;
}

/**
 * 3. THE WORKSPACE GATE. `app/(authenticated)/layout.tsx` redirects any session whose
 *    organisation has no `onboarding_completed_at` to `/org-setup`, so every authenticated
 *    route answers 307 and renders nothing. Measured on this seed: 3 organisations, 0 with
 *    the stamp. That is the third reason a perf seed cannot answer an authenticated request,
 *    and like placement and module entitlement it is a seed gap rather than an application
 *    defect — completing or skipping the wizard is what stamps it in the product.
 */
async function completeOrgOnboarding(sql, write) {
  const pending = await sql.unsafe(
    `SELECT id FROM organizations WHERE onboarding_completed_at IS NULL ORDER BY id`,
  );
  process.stdout.write(
    `[prepare-perf-http-seed] organisations short of the workspace gate: ${String(pending.length)}\n`,
  );
  if (!write) return 0;

  let stamped = 0;
  for (const row of pending) {
    const result = await sql.unsafe(
      `UPDATE organizations SET onboarding_completed_at = now()
        WHERE id = $1 AND onboarding_completed_at IS NULL
        RETURNING id`,
      [String(row.id)],
    );
    stamped += result.length;
  }
  return stamped;
}

async function enableModules(sql, write) {
  const missing = await sql.unsafe(
    `SELECT o.id AS org_id, c.module_key
       FROM organizations o
       CROSS JOIN modules_catalog c
       LEFT JOIN org_modules m ON m.org_id = o.id AND m.module_key = c.module_key
      WHERE m.id IS NULL
      ORDER BY o.id, c.module_key`,
  );
  process.stdout.write(
    `[prepare-perf-http-seed] missing org_modules rows: ${String(missing.length)}\n`,
  );
  if (!write) return 0;

  let inserted = 0;
  for (const row of missing) {
    const result = await sql.unsafe(
      `INSERT INTO org_modules (org_id, module_key, enabled)
       VALUES ($1, $2, true)
       ON CONFLICT (org_id, module_key) DO NOTHING
       RETURNING id`,
      [String(row.org_id), String(row.module_key)],
    );
    inserted += result.length;
  }
  return inserted;
}

async function main() {
  const write = process.argv.includes("--write");
  const url = process.env.DATABASE_URL ?? "";
  const guard = assertWritable(url);
  if (!guard.ok) {
    process.stderr.write(`[prepare-perf-http-seed] ${guard.reason}\n`);
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, prepare: false, ssl: sslModeOf(url), onnotice: () => {} });
  try {
    process.stdout.write(`[prepare-perf-http-seed] database=${guard.database}\n`);
    const placed = await placeOrganizations(sql, write);
    const enabled = await enableModules(sql, write);
    const stamped = await completeOrgOnboarding(sql, write);
    if (!write) {
      process.stdout.write("[prepare-perf-http-seed] dry run — pass --write to insert\n");
      return;
    }
    process.stdout.write(
      `[prepare-perf-http-seed] inserted ${String(placed)} placement row(s), ${String(enabled)} module row(s), stamped ${String(stamped)} workspace gate(s)\n`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function selfTest() {
  const checks = [];
  const check = (name, condition) => checks.push({ name, ok: condition === true });

  check("refuses a non-scratch database", assertWritable("postgres://u@h/production").ok === false);
  check("refuses cornerstone by name", assertWritable("postgres://u@h/cornerstone_scratch").ok === false);
  check("accepts a scratch database", assertWritable("postgres://u@h/scratch_perf_seed").ok === true);
  check("reads the database name out of the path", databaseName("postgres://u@h/scratch_x?sslmode=disable") === "scratch_x");
  check("sslmode=require asks postgres for TLS", sslModeOf("postgres://u@h/scratch_x?sslmode=require") === "require");
  check("sslmode=disable stays plaintext", sslModeOf("postgres://u@h/scratch_x?sslmode=disable") === false);
  check("no sslmode stays plaintext", sslModeOf("postgres://u@h/scratch_x") === false);
  check("refuses an unparseable url", assertWritable("not a url").ok === false);

  const row = placementRow("org-1", 0);
  check("places into the configured cell", row.cell_id === LEGACY_CELL_ID);
  check("places into the primary region", row.region === DEFAULT_REGION);
  check("issues an ACTIVE placement", row.status === "ACTIVE");
  check("issues a lease in the future", Date.parse(row.lease_expires_at) === FENCE_LEASE_MS);
  check("issues a distinct fence token per row", placementRow("a").write_fence_token !== placementRow("b").write_fence_token);

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) process.stdout.write(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}\n`);
  process.stdout.write(
    `[prepare-perf-http-seed] self-test ${String(checks.length - failed.length)}/${String(checks.length)}\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv.includes("--self-test")) selfTest();
else
  main().catch((error) => {
    process.stderr.write(`[prepare-perf-http-seed] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
