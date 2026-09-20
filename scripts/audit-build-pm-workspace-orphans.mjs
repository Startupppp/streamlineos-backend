/**
 * audit-build-pm-workspace-orphans.mjs
 *
 * Reports data integrity gaps in the Build PM workspace / project relationship:
 *   (a) projects where pm_workspace_id IS NULL — orphan rows from before the NOT
 *       NULL constraint was enforced (migration 0333).
 *   (b) projects where managed_product_id references a managed product that
 *       belongs to a DIFFERENT pm_workspace_id than the project itself — these
 *       violate the cross-workspace product guard added in the previous pass.
 *
 * This script REPORTS ONLY. It never writes, updates or deletes rows.
 * Run in dry-run (default) or pass --apply to enable future quarantine steps
 * (currently no-op; the flag is reserved for a follow-up quarantine pass).
 *
 * Usage:
 *   node scripts/audit-build-pm-workspace-orphans.mjs [--url <DSN>]
 *
 * Environment:
 *   APP_DATABASE_URL  — streamline_app role DSN (preferred; exercises RLS path).
 *   DATABASE_URL      — fallback; owner role bypasses RLS so proofs are weaker.
 *
 * Output:
 *   Per-org counts + rows for (a) and (b). Exits non-zero if any violations found.
 */

import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config();

const args = process.argv.slice(2);
let urlOverride;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url") { urlOverride = args[++i]; continue; }
}

const dsn = urlOverride ?? process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
if (!dsn) {
  console.error("No DSN: set APP_DATABASE_URL or pass --url <DSN>");
  process.exit(1);
}

const BATCH = 100;

const sql = postgres(dsn, { prepare: false, max: 1 });

async function auditOrg(orgId) {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.organization_id = '${orgId}'`);

    const nullWs = await tx`
      SELECT id, key, name
      FROM   projects
      WHERE  org_id      = ${orgId}
        AND  deleted_at  IS NULL
        AND  pm_workspace_id IS NULL
      ORDER BY id
      LIMIT  ${BATCH}
    `;

    const crossWs = await tx`
      SELECT p.id,
             p.key,
             p.name,
             p.pm_workspace_id   AS project_ws,
             mp.pm_workspace_id  AS product_ws,
             p.managed_product_id
      FROM   projects p
      JOIN   managed_products mp
             ON  mp.id       = p.managed_product_id
             AND mp.org_id   = ${orgId}
             AND mp.deleted_at IS NULL
      WHERE  p.org_id          = ${orgId}
        AND  p.deleted_at      IS NULL
        AND  p.managed_product_id IS NOT NULL
        AND  p.pm_workspace_id  <> mp.pm_workspace_id
      ORDER BY p.id
      LIMIT  ${BATCH}
    `;

    return { nullWs, crossWs };
  });
}

async function main() {
  let orgs;
  try {
    orgs = await sql`SELECT id FROM organizations ORDER BY created_at`;
  } catch (err) {
    console.error(
      "Failed to list organizations:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }

  console.log(`=== BUILD PM WORKSPACE ORPHAN AUDIT ===`);
  console.log(`Orgs: ${orgs.length}\n`);

  let totalNullWs = 0;
  let totalCrossWs = 0;

  for (const org of orgs) {
    const orgId = org.id;
    let result;
    try {
      result = await auditOrg(orgId);
    } catch (err) {
      console.warn(`org ${orgId}: query failed — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const { nullWs, crossWs } = result;

    if (nullWs.length > 0) {
      console.log(`org ${orgId}: (a) NULL pm_workspace_id — ${nullWs.length} project(s)${nullWs.length >= BATCH ? " (capped)" : ""}:`);
      for (const row of nullWs) {
        console.log(`  project id=${row.id} key=${row.key} name="${row.name}"`);
      }
      totalNullWs += nullWs.length;
    }

    if (crossWs.length > 0) {
      console.log(`org ${orgId}: (b) cross-workspace product link — ${crossWs.length} project(s)${crossWs.length >= BATCH ? " (capped)" : ""}:`);
      for (const row of crossWs) {
        console.log(
          `  project id=${row.id} key=${row.key} project_ws=${row.project_ws} product_id=${row.managed_product_id} product_ws=${row.product_ws}`,
        );
      }
      totalCrossWs += crossWs.length;
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`(a) Projects with NULL pm_workspace_id   : ${totalNullWs}`);
  console.log(`(b) Projects with cross-workspace product: ${totalCrossWs}`);

  if (totalNullWs > 0 || totalCrossWs > 0) {
    console.log(`\nACTION REQUIRED — violations found. See rows above.`);
    console.log(`Next step: run the quarantine backfill (not yet implemented — track in BSN-01-018).`);
    process.exitCode = 1;
  } else {
    console.log(`\nNo violations found.`);
  }
}

main()
  .catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => sql.end());
