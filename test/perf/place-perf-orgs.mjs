#!/usr/bin/env node
/**
 * Places the perf seed's organizations so an authenticated HTTP request can reach their data.
 *
 * WHY THIS EXISTS
 *
 * `withTenant` resolves an organisation's placement before it opens a tenant transaction, and
 * `RegionRegistry.resolvePlacement` THROWS when the organisation has no row in
 * `organization_placement`. `MembershipStateService.fetchMembershipState` wraps its read in a
 * `try/catch` that turns any throw into `UNKNOWN`, and `JwtAuthGuard` turns `UNKNOWN` into
 * `403 ORG_MEMBERSHIP_INACTIVE`.
 *
 * So on a seed whose `organization_placement` table is empty, EVERY authenticated request answers
 * 403 with a message about membership — a placement defect wearing an authorization error's
 * clothes. `scratch_perf_seed` is in exactly that state: 8 organisations, 0 placement rows, and
 * `organizations.region` NULL on every one of them. That is why no request-level number existed
 * for this ticket before now, and it is not visible from any database-side instrument.
 *
 * WHAT IT WRITES
 *
 * One `organization_placement` row per organisation, matching what `placeOrganization()` writes:
 * region `primary`, cell `legacy-1`, shard `primary`, search cluster `primary`, version 1, an
 * ACTIVE status and a fresh write-fence lease. `resolvePlacement` refuses a placement whose
 * `cellId` differs from the configured cell, so these values are the topology defaults from
 * `src/common/region/placement.ts` rather than invented ones.
 *
 * SAFETY
 *
 *   - refuses any database whose name does not contain "scratch";
 *   - refuses `cornerstone_*` outright;
 *   - `ON CONFLICT DO NOTHING`, so it never rewrites an existing placement;
 *   - prints a count, never a connection string.
 *
 * Usage:
 *   node test/perf/place-perf-orgs.mjs                  # reports what it would do
 *   node test/perf/place-perf-orgs.mjs --write
 *   node test/perf/place-perf-orgs.mjs --self-test
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
        `refusing to write to "${database}" — this places organisations, so the target must be a ` +
        `disposable database whose name contains "scratch"`,
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

async function main() {
  const write = process.argv.includes("--write");
  const url = process.env.DATABASE_URL ?? "";
  const guard = assertWritable(url);
  if (!guard.ok) {
    process.stderr.write(`[place-perf-orgs] ${guard.reason}\n`);
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
  try {
    const orgs = await sql.unsafe(
      `SELECT o.id
         FROM organizations o
         LEFT JOIN organization_placement p ON p.organization_id = o.id
        WHERE p.organization_id IS NULL
        ORDER BY o.id`,
    );
    const placed = await sql.unsafe(`SELECT count(*)::int AS n FROM organization_placement`);

    process.stdout.write(
      `[place-perf-orgs] database=${guard.database} placed=${String(placed[0]?.n ?? 0)} unplaced=${String(orgs.length)}\n`,
    );
    for (const org of orgs) process.stdout.write(`  unplaced: ${String(org.id)}\n`);

    if (!write) {
      process.stdout.write("[place-perf-orgs] dry run — pass --write to insert\n");
      return;
    }

    let inserted = 0;
    for (const org of orgs) {
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
    process.stdout.write(`[place-perf-orgs] inserted ${String(inserted)} placement row(s)\n`);
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
  check("refuses an unparseable url", assertWritable("not a url").ok === false);

  const row = placementRow("org-1", 0);
  check("places into the configured cell", row.cell_id === LEGACY_CELL_ID);
  check("places into the primary region", row.region === DEFAULT_REGION);
  check("issues an ACTIVE placement", row.status === "ACTIVE");
  check("issues a lease in the future", Date.parse(row.lease_expires_at) === FENCE_LEASE_MS);
  check("issues a distinct fence token per row", placementRow("a").write_fence_token !== placementRow("b").write_fence_token);

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) process.stdout.write(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}\n`);
  process.stdout.write(`[place-perf-orgs] self-test ${String(checks.length - failed.length)}/${String(checks.length)}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv.includes("--self-test")) selfTest();
else
  main().catch((error) => {
    process.stderr.write(`[place-perf-orgs] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
