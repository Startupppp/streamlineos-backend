#!/usr/bin/env node
/**
 * Seeds the fixture required by verify:multi-org-employment.
 *
 * The verifier boots a Nest application context, locates any user who holds two
 * active memberships, writes a distinct designation to each of their employment
 * records, reads back EmploymentFacts, and asserts the two are independent.
 * Without this seeder no such user exists and the gate always exits 1 with
 * { skipped: true }.
 *
 * What it creates (all idempotent — safe to run twice):
 *   1. One fixture user (FIXTURE_USER_ID) if not already present.
 *   2. An ACTIVE organization_members row in LARGE_ORG and in SMALL_ORG.
 *   3. An hr_people row linked to that user in each org.
 *   4. A primary hr_employments row for each hr_people, if one does not
 *      already exist.
 *
 * Prerequisite: run pnpm seed:scratch-e2e first so LARGE_ORG and SMALL_ORG exist.
 *
 * Usage:
 *   DATABASE_URL=<url> node src/scripts/seed-multi-org-employment-fixture.mjs
 *
 *   The seeder reads DATABASE_URL from .env via --env-file=.env (wired in
 *   package.json). The database name must contain "scratch", "local", or "test";
 *   set ALLOW_SEEDER_ON_ANY_DB=true to bypass this guard on a known-safe target.
 */

import postgres from "postgres";
import * as dotenv from "dotenv";
import { resolve } from "node:path";

const PRODUCTION_HOST_PATTERNS = ["amazonaws.com", "neon.tech", "neon-db.net", "supabase.co", ".render.com"];

function assertDisposableTarget(url) {
  if (!url) return { allowed: false, reason: "DATABASE_URL is not set" };
  const matched = PRODUCTION_HOST_PATTERNS.find((p) => url.includes(p));
  if (matched) return { allowed: false, reason: `DATABASE_URL names production host '${matched}'` };
  let host, dbName;
  try {
    const u = new URL(url.replace(/^postgresql:\/\//, "http://").replace(/^postgres:\/\//, "http://"));
    host = u.hostname;
    dbName = u.pathname.replace(/^\//, "");
  } catch {
    return { allowed: false, reason: "DATABASE_URL does not parse" };
  }
  if (host === "127.0.0.1" || host === "localhost") return { allowed: true, reason: `loopback target '${host}'` };
  if (/scratch|test/i.test(dbName)) return { allowed: true, reason: `scratch/test database '${dbName}'` };
  return { allowed: false, reason: `host '${host}' is not loopback and database '${dbName}' is not a scratch/test database` };
}

if (process.argv.includes("--self-test")) {
  const cases = [
    [assertDisposableTarget("postgresql://u:p@127.0.0.1:5432/scratch_local"), true],
    [assertDisposableTarget("postgresql://u:p@localhost:5432/app"), true],
    [assertDisposableTarget("postgresql://u:p@prod.cluster.amazonaws.com/app"), false],
    [assertDisposableTarget("postgresql://u:p@prod.cluster.amazonaws.com/scratch_test"), false],
    [assertDisposableTarget(null), false],
  ];
  let failed = 0;
  for (const [verdict, expected] of cases)
    if (verdict.allowed !== expected) { console.error(`FAIL: expected allowed=${expected}, got ${verdict.reason}`); failed++; }
  if (failed) process.exit(1);
  console.log("PASS: seed-multi-org-employment-fixture target guard, 5 cases.");
  process.exit(0);
}

dotenv.config({ path: resolve(process.cwd(), ".env") });

const LARGE_ORG = "aaaaaaaa-1111-0000-0000-000000000001";
const SMALL_ORG = "aaaaaaaa-1111-0000-0000-000000000002";
const FIXTURE_USER_ID = "cccccccc-0001-0000-0000-000000000001";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error(
    "seed-multi-org-employment-fixture: DATABASE_URL is required.\n" +
    "This seeder targets the same database as verify:multi-org-employment.",
  );
  process.exit(1);
}

const _multiOrgGuard = assertDisposableTarget(DB_URL);
if (!_multiOrgGuard.allowed) {
  process.stderr.write(
    `seed-multi-org-employment-fixture BLOCKED — ${_multiOrgGuard.reason}\n` +
    "  Set DATABASE_URL to a loopback or named scratch/test database before seeding.\n",
  );
  process.exit(1);
}

const ssl = DB_URL.includes("sslmode=disable") ? false : "require";
const sql = postgres(DB_URL, { max: 1, prepare: false, ssl, onnotice: () => {} });

const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

async function main() {
  log(`database: ${new URL(DB_URL.replace(/^postgresql:\/\//, "http://").replace(/^postgres:\/\//, "http://")).pathname.replace(/^\//, "")}`);

  const orgs = await sql.unsafe(
    `SELECT id FROM organizations WHERE id = $1 OR id = $2`,
    [LARGE_ORG, SMALL_ORG],
  );
  if (orgs.length < 2) {
    console.error(
      "seed-multi-org-employment-fixture: LARGE_ORG and SMALL_ORG must both exist.\n" +
      "Run: pnpm seed:scratch-e2e",
    );
    process.exit(1);
  }

  log("upserting fixture user...");
  await sql.unsafe(
    `INSERT INTO users (id, name, email, email_verified, first_name, last_name, is_active, created_at, updated_at)
     VALUES ($1, 'Multi Org Fixture', 'multi-org-fixture@scratch-seed.test', now(), 'Multi', 'Org', true, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [FIXTURE_USER_ID],
  );

  for (const [orgId, empNumber] of [
    [LARGE_ORG, "EMP-FIXTURE-A"],
    [SMALL_ORG, "EMP-FIXTURE-B"],
  ]) {
    const label = orgId === LARGE_ORG ? "LARGE_ORG" : "SMALL_ORG";

    log(`  ${label}: ensuring ACTIVE membership...`);
    await sql.unsafe(
      `INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
       VALUES ($1, $2, 'MEMBER', false, 'ACTIVE', now())
       ON CONFLICT DO NOTHING`,
      [FIXTURE_USER_ID, orgId],
    );
    await sql.unsafe(
      `UPDATE organization_members SET status = 'ACTIVE'
       WHERE user_id = $1 AND org_id = $2 AND status != 'ACTIVE'`,
      [FIXTURE_USER_ID, orgId],
    );

    log(`  ${label}: ensuring hr_people row...`);
    await sql.unsafe(
      `INSERT INTO hr_people (org_id, user_id, created_at, updated_at)
       SELECT $1, $2, now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM hr_people p
         WHERE p.org_id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL
       )`,
      [orgId, FIXTURE_USER_ID],
    );

    log(`  ${label}: ensuring primary hr_employment row...`);
    await sql.unsafe(
      `INSERT INTO hr_employments (org_id, person_id, employee_number, lifecycle_status, is_primary, joining_date, created_at, updated_at)
       SELECT $1, p.id, $3, 'ACTIVE', true, CURRENT_DATE - INTERVAL '1 year', now(), now()
       FROM hr_people p
       WHERE p.org_id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM hr_employments e
           WHERE e.org_id = $1 AND e.person_id = p.id AND e.is_primary = true AND e.deleted_at IS NULL
         )
       LIMIT 1
       ON CONFLICT DO NOTHING`,
      [orgId, FIXTURE_USER_ID, empNumber],
    );
  }

  log("verifying fixture completeness...");
  const [check] = await sql.unsafe(
    `SELECT
       (SELECT COUNT(*)::int FROM organization_members
        WHERE user_id = $1 AND (org_id = $2 OR org_id = $3) AND status = 'ACTIVE') AS memberships,
       (SELECT COUNT(*)::int FROM hr_people
        WHERE user_id = $1 AND (org_id = $2 OR org_id = $3) AND deleted_at IS NULL) AS people,
       (SELECT COUNT(*)::int
        FROM hr_employments e
        INNER JOIN hr_people p ON p.org_id = e.org_id AND p.id = e.person_id
        WHERE p.user_id = $1
          AND (e.org_id = $2 OR e.org_id = $3)
          AND e.is_primary = true
          AND e.deleted_at IS NULL) AS employments`,
    [FIXTURE_USER_ID, LARGE_ORG, SMALL_ORG],
  );

  if (check.memberships < 2 || check.people < 2 || check.employments < 2) {
    console.error(JSON.stringify({ ok: false, ...check }));
    process.exit(1);
  }

  log(JSON.stringify({ ok: true, userId: FIXTURE_USER_ID, ...check }));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => sql.end());
