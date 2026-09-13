import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { randomUUID } from "node:crypto";
import * as dotenv from 'dotenv';
import { resolve } from "node:path";

const PRODUCTION_HOST_PATTERNS = ["amazonaws.com", "neon.tech", "neon-db.net", "supabase.co", ".render.com"];

function assertBootstrapTarget(url, allowProduction) {
  if (!url) return { allowed: false, reason: "DATABASE_URL is not set" };
  const matched = PRODUCTION_HOST_PATTERNS.find((p) => url.includes(p));
  if (!matched) return { allowed: true, reason: "not a known production host" };
  if (allowProduction === "1") return { allowed: true, reason: `production host '${matched}' — ALLOW_PRODUCTION_MIGRATION=1 acknowledged` };
  return { allowed: false, reason: `DATABASE_URL names production host '${matched}'; set ALLOW_PRODUCTION_MIGRATION=1 to proceed deliberately` };
}

if (process.argv.includes("--self-test")) {
  const cases = [
    [assertBootstrapTarget("postgresql://u:p@127.0.0.1:5432/app", undefined), true],
    [assertBootstrapTarget("postgresql://u:p@prod.cluster.amazonaws.com/app", undefined), false],
    [assertBootstrapTarget("postgresql://u:p@prod.cluster.amazonaws.com/app", "1"), true],
    [assertBootstrapTarget("postgresql://u:p@db.neon.tech/neondb", undefined), false],
    [assertBootstrapTarget(undefined, undefined), false],
  ];
  let failed = 0;
  for (const [verdict, expected] of cases)
    if (verdict.allowed !== expected) { console.error(`FAIL: expected allowed=${expected}, got '${verdict.reason}'`); failed++; }
  if (failed) process.exit(1);
  console.log("PASS: backfill-org-regions target guard, 5 cases.");
  process.exit(0);
}

dotenv.config({ path: resolve(process.cwd(), ".env") });

async function main() {
  const controlUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  const cellUrl = process.env.REGION_PRIMARY_DATABASE_URL || process.env.DATABASE_URL;

  if (!cellUrl || !controlUrl) {
    console.error('DATABASE_URL (Control Plane) and REGION_PRIMARY_DATABASE_URL (Cell) must be set');
    process.exit(1);
  }

  const _backfillGuard = assertBootstrapTarget(controlUrl, process.env.ALLOW_PRODUCTION_MIGRATION);
  if (!_backfillGuard.allowed) {
    process.stderr.write(`backfill-org-regions BLOCKED — ${_backfillGuard.reason}\n`);
    process.exit(2);
  }

  const cellClient = postgres(cellUrl);
  const controlClient = postgres(controlUrl);

  const cellDb = drizzle(cellClient);
  const controlDb = drizzle(controlClient);

  console.log('Detecting missing placements...');

  // 1. Find organizations missing from Control Plane placement table
  const missingOrgs = await cellDb.execute(sql`
    SELECT id, name, region FROM organizations WHERE id NOT IN (SELECT organization_id FROM organization_placement)
  `);

  if (missingOrgs.length === 0) {
    console.log('No missing placements found.');
    process.exit(0);
  }

  console.log(`Found ${missingOrgs.length} organizations missing placement:`);
  for (const org of missingOrgs) {
    console.log(`- ${org.id} (${org.name})`);
  }

  for (const org of missingOrgs) {
    console.log(`Backfilling placement for ${org.id}...`);

    const FENCE_LEASE_MS = 24 * 60 * 60 * 1000;

    await controlDb.execute(sql`
      INSERT INTO organization_placement (
        organization_id, region, cell_id, database_shard, object_storage_region,
        search_cluster, placement_version, write_fence_token, lease_expires_at, status)
      VALUES (
        ${org.id}, ${org.region}, 'legacy-1', 'legacy-1',
        'auto', 'legacy-1', 1, ${randomUUID()},
        ${new Date(Date.now() + FENCE_LEASE_MS).toISOString()}, 'ACTIVE')
      ON CONFLICT (organization_id) DO NOTHING
    `);

    console.log(`Backfilled ${org.id}.`);
  }

  await cellClient.end();
  await controlClient.end();
  console.log('Done.');
}

main().catch(console.error);
