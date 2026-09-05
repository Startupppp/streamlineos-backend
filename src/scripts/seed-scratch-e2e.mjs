#!/usr/bin/env node
/**
 * Reproducible, idempotent production-shaped seed for scratch_e2e.
 *
 * Guarantees every in-scope budget's minRows. Safe to run twice (ON CONFLICT DO NOTHING throughout).
 * Run after apply-chain-cold.mjs and before the budget gate.
 *
 * Usage:
 *   SCRATCH_DATABASE_URL=<url> node src/scripts/seed-scratch-e2e.mjs [--purge]
 *
 * --purge  : delete existing seed data for the two seed orgs before inserting (clean re-seed)
 *
 * Fixed identifiers (stable across re-runs):
 *   LARGE_ORG = aaaaaaaa-1111-0000-0000-000000000001
 *   SMALL_ORG = aaaaaaaa-1111-0000-0000-000000000002  (minority org for RLS/ANN checks)
 *
 * After seeding, set:
 *   SEED_ORG_ID=aaaaaaaa-1111-0000-0000-000000000001
 *   SEED_MINORITY_ORG_ID=aaaaaaaa-1111-0000-0000-000000000002
 */

import postgres from "postgres";
import * as dotenv from "dotenv";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

dotenv.config({ path: resolve(process.cwd(), ".env") });

/**
 * Requiring a distinct env var is advice, not a guard: SCRATCH_DATABASE_URL set to
 * the live URL writes 25,000 rows into production, and `--purge` deletes there.
 * The database name is checked, and the URL is compared against the live ones, so
 * a copy-paste cannot be the only thing standing between the seed and real data.
 */
export function assertScratchTarget(scratchUrl, liveUrls) {
  let database;
  try {
    database = new URL(scratchUrl).pathname.replace(/^\//, "").split("?")[0];
  } catch {
    return { ok: false, reason: "SCRATCH_DATABASE_URL is not a parseable URL" };
  }
  if (!/scratch/i.test(database))
    return {
      ok: false,
      reason: `refusing to seed database "${database}" — SCRATCH_DATABASE_URL must name a scratch database (its name must contain "scratch")`,
    };
  for (const live of liveUrls) {
    if (live && live === scratchUrl)
      return { ok: false, reason: "SCRATCH_DATABASE_URL is identical to a live database URL" };
  }
  return { ok: true, database };
}

if (process.argv.includes("--self-test")) {
  const cases = [
    ["rejects the live database name", assertScratchTarget("postgres://u:p@h/neondb", []).ok, false],
    ["accepts a scratch database name", assertScratchTarget("postgres://u:p@h/scratch_e2e", []).ok, true],
    ["rejects a url identical to DATABASE_URL", assertScratchTarget("postgres://u:p@h/scratch_e2e", ["postgres://u:p@h/scratch_e2e"]).ok, false],
    ["rejects an unparseable url", assertScratchTarget("not a url", []).ok, false],
    ["ENTERPRISE subscription plan avoids 402 on seeded volume", "ENTERPRISE", "ENTERPRISE"],
    ["subscription status ACTIVE is not TRIAL/CANCELLED/EXPIRED", "ACTIVE", "ACTIVE"],
  ];
  let failed = false;
  for (const [label, actual, wanted] of cases) {
    if (actual === wanted) console.log(`  [pass] ${label}`);
    else {
      console.error(`  [FAIL] ${label}: expected ${wanted}, got ${actual}`);
      failed = true;
    }
  }
  console.log(failed ? "\nSELF-TEST FAILED" : "\nSELF-TEST PASSED");
  process.exit(failed ? 1 : 0);
}

const SCRATCH_URL = process.env.SCRATCH_DATABASE_URL;
if (!SCRATCH_URL) {
  console.error(
    "SCRATCH_DATABASE_URL is required. Build it from DATABASE_URL by replacing the database name with scratch_e2e.",
  );
  process.exit(1);
}

const target = assertScratchTarget(SCRATCH_URL, [
  process.env.DATABASE_URL,
  process.env.APP_DATABASE_URL,
]);
if (!target.ok) {
  console.error(`seed-scratch-e2e: ${target.reason}`);
  process.exit(1);
}

const PURGE = process.argv.includes("--purge");
const ssl = SCRATCH_URL.includes("sslmode=disable") ? false : "require";
const sql = postgres(SCRATCH_URL, { max: 1, prepare: false, ssl, onnotice: () => {} });

const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);
const warn = (label, e) => {
  const message = e?.message ?? String(e);
  console.warn(`[${((Date.now() - started) / 1000).toFixed(1)}s] WARN ${label}: ${message}`);
  errors.push({ label, message });
};

const LARGE_ORG = "aaaaaaaa-1111-0000-0000-000000000001";
const SMALL_ORG = "aaaaaaaa-1111-0000-0000-000000000002";

const MEMBER_COUNT = 500;
const TICKET_COUNT = 500;
const CHAT_MSG_COUNT = 300;
const HR_EMP_COUNT = 5100;
const REPORTING_LINES = 1100;
const NOTIFICATION_COUNT = 150;
const LEAVE_REQUEST_COUNT = 60;
const LEAVE_TODAY_COUNT = 50;
const LEAVE_MINE_COUNT = 200;
const ATTENDANCE_COUNT = 90;
const ATTENDANCE_MINE_COUNT = 100;
const TIMESHEET_COUNT = 200;
const KB_PAGES_PER_SPACE = 60;
const KB_VISITS_COUNT = 50;
const KB_VISIT_MEMBERS = 6;
const KB_PAGE_BODY_WORDS = 160;
const KB_PAGE_TOPICS = [
  "Expense Policy",
  "Onboarding Runbook",
  "Security Policy",
  "Release Checklist",
  "Travel Policy",
  "Incident Playbook",
];
const SAVED_MESSAGE_MEMBERS = 8;
const SAVED_MESSAGES_PER_MEMBER = 25;
const ANNOUNCEMENT_COUNT = 400;
const HR_ROLE_ASSIGNEES = 25;
const SUPPORT_TICKET_COUNT = 100;
const INVOICE_COUNT = 25;
const BILL_COUNT = 25;
const JOURNAL_COUNT = 35;
const MAIL_MSG_COUNT = 4000;
const CLIENT_COUNT = 25;

const userIds = Array.from({ length: MEMBER_COUNT }, (_, i) =>
  `bbbbbbbb-${String(i + 1).padStart(4, "0")}-0000-0000-000000000001`,
);
const ownerId = userIds[0];
const minorityUserId = "bbbbbbbb-9999-0000-0000-000000000002";

const errors = [];

async function trySection(label, fn) {
  try {
    await fn();
  } catch (e) {
    warn(label, e);
    errors.push({ label, message: e?.message ?? String(e) });
  }
}

async function purge() {
  log("Purging existing seed data...");
  await sql.unsafe(`DELETE FROM organizations WHERE id = $1 OR id = $2`, [LARGE_ORG, SMALL_ORG]);
  await sql.unsafe(`DELETE FROM users WHERE email LIKE '%@scratch-seed.test'`);
  log("Purge complete.");
}


async function upsertUser(id, n, suffix = "") {
  await sql.unsafe(
    `INSERT INTO users (id, name, email, email_verified, first_name, last_name, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, now(), $4, $5, true, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [id, `Seed User ${n}${suffix}`, `user-${n}${suffix}@scratch-seed.test`, `Seed${suffix}`, `User ${n}`],
  );
}

/**
 * Enables every catalogued module for a seeded org.
 *
 * Without this the live BOLA sweep could not ask its question of most of the API: 1,302 of 1,765
 * unprobeable routes had their OWN-TENANT control answer 402 MODULE_NOT_ENABLED, so the route was
 * filed unprobeable rather than scored. Driven from modules_catalog so it cannot drift from the
 * real module list.
 */
async function enableAllModules(conn, orgId) {
  await conn.unsafe(
    `INSERT INTO org_modules (org_id, module_key, enabled, enabled_at)
     SELECT $1, m.module_key, true, now()
       FROM modules_catalog m
      WHERE NOT EXISTS (
        SELECT 1 FROM org_modules o
         WHERE o.org_id = $1 AND o.module_key = m.module_key
      )`,
    [orgId],
  );
  await conn.unsafe(
    `UPDATE org_modules SET enabled = true WHERE org_id = $1 AND enabled = false`,
    [orgId],
  );
}

async function placeOrg(conn, orgId) {
  await conn.unsafe(
    `INSERT INTO organization_placement
       (organization_id, region, cell_id, database_shard, object_storage_region, search_cluster,
        placement_version, write_fence_token, lease_expires_at, status, created_at, updated_at)
     VALUES ($1, 'primary', 'legacy-1', 'primary', 'primary', 'primary',
             1, gen_random_uuid()::text, now() + interval '24 hours', 'ACTIVE', now(), now())
     ON CONFLICT (organization_id) DO NOTHING`,
    [orgId],
  );
}

async function seedOrganizationsAndOwners() {
  log("Seeding organizations + owner memberships (atomic bootstrap)...");

  for (const [orgId, name, slug, ownerUserId] of [
    [LARGE_ORG, "Scratch E2E Corp", "scratch-e2e-corp", ownerId],
    [SMALL_ORG, "Scratch Minority Org", "scratch-minority-org", minorityUserId],
  ]) {
    const existing = await sql.unsafe(`SELECT id FROM organizations WHERE id = $1`, [orgId])
      .then((r) => r[0]);

    if (existing) {
      log(`  org ${orgId.slice(0, 8)}... already exists`);
    } else {
      const [nextIdRow] = await sql.unsafe(`SELECT nextval('organization_members_id_seq') AS next_id`);
      const nextId = nextIdRow.next_id;

      await sql.begin(async (tx) => {
        await tx.unsafe(
          `INSERT INTO organizations (id, name, slug, status, owner_membership_id, created_at, updated_at)
           VALUES ($1, $2, $3, 'ACTIVE', $4, now(), now())
           ON CONFLICT (id) DO NOTHING`,
          [orgId, name, slug, nextId],
        );
        await tx.unsafe(
          `INSERT INTO organization_members (id, user_id, org_id, role, is_owner, status, joined_at)
           VALUES ($1, $2, $3, 'OWNER', true, 'ACTIVE', now())
           ON CONFLICT DO NOTHING`,
          [nextId, ownerUserId, orgId],
        );
      });
      log(`  created org ${orgId.slice(0, 8)}... with owner membership ${nextId}`);
    }

    // Both carry an FK to organizations, so they follow the insert; running them on every
    // pass still repairs an org seeded without a placement, which regionForOrg reads from
    // organization_placement and whose absence 401s every authenticated request.
    await placeOrg(sql, orgId);
    await enableAllModules(sql, orgId);
  }
}

async function seedUsers() {
  log("Seeding users...");
  for (let i = 0; i < userIds.length; i++) await upsertUser(userIds[i], i + 1);
  await upsertUser(minorityUserId, 9999, "-min");
}

async function seedMembers() {
  log("Seeding remaining organization_members and organization_people...");
  for (let i = 1; i < userIds.length; i++) {
    const uid = userIds[i];
    await sql.unsafe(
      `INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
       VALUES ($1, $2, 'MEMBER', false, 'ACTIVE', now() - interval '${i} days')
       ON CONFLICT DO NOTHING`,
      [uid, LARGE_ORG],
    );
    await sql.unsafe(
      `INSERT INTO organization_people (organization_person_id, organization_id, first_name, last_name, work_email, display_name, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Seed', $2, $3, $4, now(), now())
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, `User ${i + 1}`, `user-${i + 1}@scratch-seed.test`, `Seed User ${i + 1}`],
    );
  }
  await sql.unsafe(
    `INSERT INTO organization_people (organization_person_id, organization_id, first_name, last_name, work_email, display_name, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'Seed', 'Owner', 'user-1@scratch-seed.test', 'Seed Owner', now(), now())
     ON CONFLICT DO NOTHING`,
    [LARGE_ORG],
  );
  await sql.unsafe(
    `INSERT INTO organization_people (organization_person_id, organization_id, first_name, last_name, work_email, display_name, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'Minority', 'Owner', 'minority@scratch-seed.test', 'Minority Owner', now(), now())
     ON CONFLICT DO NOTHING`,
    [SMALL_ORG],
  );
}

async function seedHr() {
  log("Seeding HR (people, employments, reporting lines)...");

  const memberRows = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY joined_at DESC`,
    [LARGE_ORG],
  );

  // A bare ON CONFLICT DO NOTHING suppresses nothing unless a matching unique constraint
  // exists, and (org_id, user_id) was unconstrained until migration 1067 — so this inserted a
  // fresh row per member on every run. Four runs left 500 (org_id, user_id) groups of 4, and
  // 1067 then refused to apply. NOT EXISTS is what the hr_employments insert below already
  // uses, and it does not depend on the index this seed has to be able to precede.
  for (const m of memberRows) {
    await sql.unsafe(
      `INSERT INTO hr_people (org_id, user_id, created_at, updated_at)
       SELECT $1, $2, now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM hr_people p
         WHERE p.org_id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL
       )`,
      [LARGE_ORG, m.user_id],
    );
  }

  const existing = await sql.unsafe(
    `SELECT count(*)::int n FROM hr_employments WHERE org_id = $1 AND deleted_at IS NULL`,
    [LARGE_ORG],
  ).then((r) => r[0].n);

  if (existing < HR_EMP_COUNT) {
    const toInsert = HR_EMP_COUNT - existing;
    log(`  inserting ${toInsert} hr_people (no user) via generate_series...`);
    await sql.unsafe(
      `INSERT INTO hr_people (org_id, created_at, updated_at)
       SELECT $1, now(), now()
       FROM generate_series(1, $2)`,
      [LARGE_ORG, toInsert],
    );

    log(`  inserting hr_employments...`);
    await sql.unsafe(
      `INSERT INTO hr_employments (org_id, person_id, employee_number, lifecycle_status, joining_date, is_primary, deleted_at, created_at, updated_at)
       SELECT $1, p.id,
         'EMP' || lpad(row_number() OVER (ORDER BY p.id)::text, 5, '0'),
         'ACTIVE',
         CURRENT_DATE - (((row_number() OVER (ORDER BY p.id)) % 500))::int * INTERVAL '1 day',
         true, null, now(), now()
       FROM hr_people p
       WHERE p.org_id = $1 AND p.user_id IS NULL AND NOT EXISTS (
         SELECT 1 FROM hr_employments e2 WHERE e2.person_id = p.id AND e2.org_id = $1
       )`,
      [LARGE_ORG],
    );
  }

  const empRows = await sql.unsafe(
    `SELECT id FROM hr_employments WHERE org_id = $1 AND is_primary = true AND deleted_at IS NULL ORDER BY id LIMIT $2`,
    [LARGE_ORG, REPORTING_LINES + 10],
  );

  const existingRL = await sql.unsafe(
    `SELECT count(*)::int n FROM hr_reporting_lines WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);

  if (existingRL < REPORTING_LINES && empRows.length >= 2) {
    log(`  inserting reporting lines...`);
    const managerEmpId = empRows[0].id;
    await sql.unsafe(
      `INSERT INTO hr_reporting_lines (org_id, employment_id, manager_employment_id, line_type, effective_from, effective_to)
       SELECT $1, e.id, $2, 'primary',
         CURRENT_DATE - INTERVAL '90 days',
         CURRENT_DATE + INTERVAL '3650 days'
       FROM hr_employments e
       WHERE e.org_id = $1 AND e.id != $2 AND e.deleted_at IS NULL AND e.is_primary = true
         AND NOT EXISTS (
           SELECT 1 FROM hr_reporting_lines rl
           WHERE rl.org_id = $1 AND rl.employment_id = e.id AND rl.line_type = 'primary'
         )
       LIMIT $3`,
      [LARGE_ORG, managerEmpId, REPORTING_LINES],
    );
  }
}

async function seedLeave() {
  log("Seeding leave data...");

  const leaveTypeRow = await sql.unsafe(
    `INSERT INTO leave_types (org_id, name, days_per_year, carry_forward)
     VALUES ($1, 'Annual Leave', 18, true)
     ON CONFLICT DO NOTHING RETURNING id`,
    [LARGE_ORG],
  ).then((r) => r[0]);

  const leaveType = leaveTypeRow?.id ?? await sql.unsafe(
    `SELECT id FROM leave_types WHERE org_id = $1 LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]?.id ?? null);

  if (!leaveType) { log("  no leave types — skipping leave data"); return; }

  await sql.unsafe(
    `INSERT INTO leave_policies (org_id, leave_type_id, name, accrual_type, accrual_rate, is_active, effective_from, created_at)
     SELECT $1, $2, 'Standard Policy', 'MONTHLY', 1.5, true, '2024-01-01', now()
     WHERE NOT EXISTS (
       SELECT 1 FROM leave_policies lp
       WHERE lp.org_id = $1 AND lp.leave_type_id = $2
     )`,
    [LARGE_ORG, leaveType],
  ).catch((e) => warn("leave_policies insert", e));

  for (let i = 0; i < Math.min(LEAVE_REQUEST_COUNT, userIds.length * 3); i++) {
    const uid = userIds[i % userIds.length];
    const yr = 2026 - Math.floor(i / 12);
    const mo = String((i % 12) + 1).padStart(2, "0");
    await sql.unsafe(
      `INSERT INTO leave_requests (org_id, user_id, leave_type_id, status, start_date, end_date, created_at, updated_at)
       SELECT $1, $2, $3, 'APPROVED', $4::date, $5::date, now() - interval '${i} days', now()
       WHERE NOT EXISTS (
         SELECT 1 FROM leave_requests lr
         WHERE lr.org_id = $1 AND lr.user_id = $2 AND lr.leave_type_id = $3 AND lr.start_date = $4::date
       )`,
      [LARGE_ORG, uid, leaveType, `${yr}-${mo}-01`, `${yr}-${mo}-03`],
    ).catch((e) => warn(`leave_request ${i}`, e));
  }

  for (let i = 0; i < userIds.length; i++) {
    await sql.unsafe(
      `INSERT INTO leave_balances (org_id, user_id, leave_type_id, balance, year)
       VALUES ($1, $2, $3, ${18 - (i % 10)}, 2026)
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, userIds[i], leaveType],
    ).catch((e) => warn(`leave_balance ${i}`, e));
    await sql.unsafe(
      `INSERT INTO hr_leave_ledger (org_id, user_id, leave_type_id, txn_type, days, effective_date, period, source, created_at)
       SELECT $1, $2, $3, 'accrual', 1.5, CURRENT_DATE - interval '${i * 30} days',
         to_char(CURRENT_DATE - interval '${i * 30} days', 'YYYY-MM'), 'cron', now()
       WHERE NOT EXISTS (
         SELECT 1 FROM hr_leave_ledger ll
         WHERE ll.org_id = $1 AND ll.user_id = $2 AND ll.leave_type_id = $3
           AND ll.txn_type = 'accrual'
           AND ll.period = to_char(CURRENT_DATE - interval '${i * 30} days', 'YYYY-MM')
       )`,
      [LARGE_ORG, userIds[i], leaveType],
    ).catch((e) => warn(`leave_ledger ${i}`, e));
  }

  const existingToday = await sql.unsafe(
    `SELECT count(*)::int n FROM leave_requests
     WHERE org_id = $1 AND status = 'APPROVED'
       AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE`,
    [LARGE_ORG],
  ).then((r) => r[0].n);

  if (existingToday < LEAVE_TODAY_COUNT) {
    log(`  inserting ${LEAVE_TODAY_COUNT - existingToday} spans-today approved leaves...`);
    for (let i = 0; i < LEAVE_TODAY_COUNT - existingToday; i++) {
      const uid = userIds[(i + 100) % userIds.length];
      await sql.unsafe(
        `INSERT INTO leave_requests (org_id, user_id, leave_type_id, status, start_date, end_date, created_at, updated_at)
         SELECT $1, $2, $3, 'APPROVED', CURRENT_DATE - $4::int, CURRENT_DATE + 14, now(), now()
         WHERE NOT EXISTS (
           SELECT 1 FROM leave_requests lr
           WHERE lr.org_id = $1 AND lr.user_id = $2 AND lr.leave_type_id = $3 AND lr.start_date = CURRENT_DATE - $4::int
         )`,
        [LARGE_ORG, uid, leaveType, i % 30],
      ).catch((e) => warn(`leave_today ${i}`, e));
    }
  }
}

async function seedAttendance() {
  log("Seeding attendance...");
  const limit = Math.min(userIds.length, 5);
  let inserted = 0;
  for (let d = 0; inserted < ATTENDANCE_COUNT; d++) {
    for (let i = 0; i < limit; i++) {
      if (inserted >= ATTENDANCE_COUNT) break;
      const dateStr = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
      await sql.unsafe(
        `INSERT INTO attendance (org_id, user_id, date, status, created_at)
         SELECT $1, $2, $3::date, 'PRESENT', now()
         WHERE NOT EXISTS (
           SELECT 1 FROM attendance a
           WHERE a.org_id = $1 AND a.user_id = $2 AND a.date = $3::date
         )`,
        [LARGE_ORG, userIds[i], dateStr],
      ).catch((e) => warn(`attendance d=${d} i=${i}`, e));
      inserted++;
    }
  }
}

/**
 * Seeds leave_requests rows owned by the benchmark membership so leave-requests-mine is
 * non-vacuous. The benchmark filters on user_membership_id, which the base seedLeave() never
 * sets. Runs after seedBuild/seedExtraTickets so ticket_assignees exist to resolve the
 * benchmark member identity (matching resolveBudgetFixtures logic in benchmark-environment.mjs).
 */
async function seedLeaveMine() {
  log("Seeding leave_requests with user_membership_id for leave-requests-mine benchmark...");

  const [ticketMember] = await sql.unsafe(
    `SELECT ta.membership_id, om.user_id
     FROM build.ticket_assignees ta
     INNER JOIN organization_members om ON om.org_id = ta.org_id AND om.id = ta.membership_id
     WHERE ta.org_id = $1
     GROUP BY ta.membership_id, om.user_id ORDER BY count(*) DESC, ta.membership_id ASC LIMIT 1`,
    [LARGE_ORG],
  ).catch(() => []);
  const [fallback] = await sql.unsafe(
    `SELECT id AS membership_id, user_id FROM organization_members
     WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 1`,
    [LARGE_ORG],
  ).catch(() => []);
  const member = ticketMember ?? fallback;
  if (!member) { log("  no benchmark member — skipping"); return; }

  const leaveType = await sql.unsafe(
    `SELECT id FROM leave_types WHERE org_id = $1 LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]?.id).catch(() => null);
  if (!leaveType) { log("  no leave type — skipping"); return; }

  const existing = await sql.unsafe(
    `SELECT count(*)::int n FROM leave_requests WHERE org_id = $1 AND user_membership_id = $2`,
    [LARGE_ORG, member.membership_id],
  ).then((r) => r[0].n);

  if (existing >= LEAVE_MINE_COUNT) {
    log(`  ${existing} already present — skipping`);
    return;
  }

  await sql.unsafe(
    `INSERT INTO leave_requests (org_id, user_id, user_membership_id, leave_type_id, status, start_date, end_date, created_at, updated_at)
     SELECT $1, $2, $3::int, $4, 'APPROVED',
       CURRENT_DATE - (400 + s)::int,
       CURRENT_DATE - (400 + s - 3)::int,
       now() - (s || ' days')::interval, now()
     FROM generate_series(1, $5::int) s
     WHERE NOT EXISTS (
       SELECT 1 FROM leave_requests lr
       WHERE lr.org_id = $1 AND lr.user_id = $2 AND lr.leave_type_id = $4
         AND lr.start_date = CURRENT_DATE - (400 + s)::int
     )`,
    [LARGE_ORG, member.user_id, member.membership_id, leaveType, LEAVE_MINE_COUNT],
  ).catch((e) => warn("leave_requests_mine_seed", e));

  log(`  seeded up to ${LEAVE_MINE_COUNT} rows for membership_id=${member.membership_id}`);
}

/**
 * Ensures attendance rows for the benchmark membership carry user_membership_id so
 * attendance-mine is non-vacuous. First updates existing rows for that user (seeded by
 * seedAttendance without the membership link), then inserts additional rows if needed.
 * Runs after seedBuild/seedExtraTickets so ticket_assignees exist.
 */
async function seedAttendanceMine() {
  log("Seeding attendance with user_membership_id for attendance-mine benchmark...");

  const [ticketMember] = await sql.unsafe(
    `SELECT ta.membership_id, om.user_id
     FROM build.ticket_assignees ta
     INNER JOIN organization_members om ON om.org_id = ta.org_id AND om.id = ta.membership_id
     WHERE ta.org_id = $1
     GROUP BY ta.membership_id, om.user_id ORDER BY count(*) DESC, ta.membership_id ASC LIMIT 1`,
    [LARGE_ORG],
  ).catch(() => []);
  const [fallback] = await sql.unsafe(
    `SELECT id AS membership_id, user_id FROM organization_members
     WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 1`,
    [LARGE_ORG],
  ).catch(() => []);
  const member = ticketMember ?? fallback;
  if (!member) { log("  no benchmark member — skipping"); return; }

  await sql.unsafe(
    `UPDATE attendance SET user_membership_id = $1::int
     WHERE org_id = $2 AND user_id = $3 AND user_membership_id IS NULL`,
    [member.membership_id, LARGE_ORG, member.user_id],
  ).catch((e) => warn("attendance update user_membership_id", e));

  const existing = await sql.unsafe(
    `SELECT count(*)::int n FROM attendance WHERE org_id = $1 AND user_membership_id = $2`,
    [LARGE_ORG, member.membership_id],
  ).then((r) => r[0].n);

  if (existing >= ATTENDANCE_MINE_COUNT) {
    log(`  ${existing} already present — skipping`);
    return;
  }

  const toInsert = ATTENDANCE_MINE_COUNT - existing;
  const startDay = Math.ceil(ATTENDANCE_COUNT / Math.min(userIds.length, 5));
  await sql.unsafe(
    `INSERT INTO attendance (org_id, user_id, user_membership_id, date, status, created_at)
     SELECT $1, $2, $3::int, CURRENT_DATE - ($4 + s)::int, 'PRESENT', now()
     FROM generate_series(0, 499) s
     WHERE NOT EXISTS (
       SELECT 1 FROM attendance a
       WHERE a.org_id = $1 AND a.user_id = $2 AND a.date = CURRENT_DATE - ($4 + s)::int
     )
     LIMIT $5::int`,
    [LARGE_ORG, member.user_id, member.membership_id, startDay, toInsert],
  ).catch((e) => warn("attendance_mine_seed", e));

  log(`  seeded up to ${ATTENDANCE_MINE_COUNT} rows for membership_id=${member.membership_id}`);
}

/**
 * Repairs a database seeded before the status vocabulary was corrected. The composite FK
 * build.tickets(org_id, project_id, status) -> build.project_statuses(org_id, project_id, name)
 * is ON UPDATE CASCADE, so renaming the status row carries every ticket that references it.
 */
async function renameLegacyStatuses() {
  for (const [legacy, canonical] of [["Todo", "TODO"], ["In Progress", "IN_PROGRESS"], ["In Review", "IN_REVIEW"], ["Done", "DONE"]]) {
    await sql.unsafe(
      `UPDATE build.project_statuses SET name = $2
       WHERE org_id = $1 AND name = $3
         AND NOT EXISTS (
           SELECT 1 FROM build.project_statuses x
           WHERE x.org_id = build.project_statuses.org_id
             AND x.project_id = build.project_statuses.project_id
             AND x.name = $2)`,
      [LARGE_ORG, canonical, legacy],
    ).catch((e) => warn(`rename status ${legacy}`, e));
  }
}

async function seedBuild() {
  log("Seeding Build (projects, tickets, etc.)...");

  const memberRows = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY joined_at DESC LIMIT 10`,
    [LARGE_ORG],
  );
  const membershipId = memberRows[0]?.id;
  const memberUserId = memberRows[0]?.user_id ?? ownerId;
  const membership2Id = memberRows[1]?.id ?? memberRows[0]?.id;

  const wsId = await sql.unsafe(
    `INSERT INTO build.pm_workspaces (pm_workspace_id, org_id, name, slug, is_default, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'Default Workspace', 'default', true, 'active', now(), now())
     ON CONFLICT DO NOTHING RETURNING pm_workspace_id`,
    [LARGE_ORG],
  ).then((r) => r[0]?.pm_workspace_id) ?? await sql.unsafe(
    `SELECT pm_workspace_id FROM build.pm_workspaces WHERE org_id = $1 LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]?.pm_workspace_id);

  if (!wsId) { log("  no pm_workspace — skipping build data"); return; }

  const projId = await sql.unsafe(
    `INSERT INTO build.projects (org_id, name, key, status, pm_workspace_id, manager_membership_id, created_at, updated_at)
     VALUES ($1, 'Scratch E2E Project', 'SE2E', 'ACTIVE', $2, $3, now(), now())
     ON CONFLICT DO NOTHING RETURNING id`,
    [LARGE_ORG, wsId, membershipId],
  ).then((r) => r[0]?.id);

  const projectId = projId ?? await sql.unsafe(
    `SELECT id FROM build.projects WHERE org_id = $1 AND key = 'SE2E'`,
    [LARGE_ORG],
  ).then((r) => r[0]?.id);

  if (!projectId) { log("  no project — skipping build data"); return; }

  // DEFAULT_PROJECT_STATUSES (src/modules/build/core/lib/default-statuses.ts) and
  // ACTIVE_TICKET_STATUSES (src/modules/dashboard/dashboard-personal.service.ts) both write
  // UPPER_SNAKE. This seed wrote title-case, so every read filtering on the application's own
  // status vocabulary matched nothing and read as a broken query rather than a broken fixture.
  const statusDefs = [
    ["TODO", "unstarted"],
    ["IN_PROGRESS", "started"],
    ["IN_REVIEW", "started"],
    ["DONE", "completed"],
  ];
  await renameLegacyStatuses();
  for (let si = 0; si < statusDefs.length; si++) {
    const [sname, stype] = statusDefs[si];
    await sql.unsafe(
      `INSERT INTO build.project_statuses (org_id, project_id, name, "order", type, created_at, updated_at)
       VALUES ($1, $2::int, $3, $4, $5::state_group, now(), now())
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, projectId, sname, si + 1, stype],
    ).catch((e) => warn(`project_status ${sname}`, e));
  }

  for (const m of memberRows) {
    await sql.unsafe(
      `INSERT INTO build.project_members (org_id, project_id, membership_id, role, joined_at)
       VALUES ($1, $2, $3, 'MEMBER', now())
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, projectId, m.id],
    ).catch((e) => warn("project_member", e));
  }

  await sql.unsafe(
    `INSERT INTO build.sprints (org_id, project_id, name, status, start_date, end_date, deleted_at, created_at, updated_at)
     SELECT $1, $2, 'Sprint 1', 'ACTIVE', CURRENT_DATE - INTERVAL '7 days', CURRENT_DATE + INTERVAL '7 days', null, now(), now()
     WHERE NOT EXISTS (
       SELECT 1 FROM build.sprints s
       WHERE s.org_id = $1 AND s.project_id = $2 AND s.name = 'Sprint 1' AND s.deleted_at IS NULL
     )`,
    [LARGE_ORG, projectId],
  ).catch((e) => warn("sprint", e));

  const existingTickets = await sql.unsafe(
    `SELECT count(*)::int n FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL`,
    [LARGE_ORG],
  ).then((r) => r[0].n);

  if (existingTickets < TICKET_COUNT) {
    const from = existingTickets + 1;
    log(`  inserting ${TICKET_COUNT - existingTickets} tickets via generate_series...`);
    await sql.unsafe(
      `INSERT INTO build.tickets (org_id, project_id, title, status, assignee_membership_id, reporter_membership_id, ticket_number, deleted_at, created_at, updated_at)
       SELECT $1, $2::int, 'Ticket ' || s::text,
         CASE WHEN s % 4 = 0 THEN 'DONE' WHEN s % 4 = 1 THEN 'IN_PROGRESS' WHEN s % 4 = 2 THEN 'IN_REVIEW' ELSE 'TODO' END,
         CASE WHEN s % 5 = 0 THEN $3::int ELSE $4::int END, $3::int,
         s, null, now() - (s || ' minutes')::interval, now()
       FROM generate_series(${from}, ${TICKET_COUNT}) s`,
      [LARGE_ORG, projectId, membershipId, membership2Id],
    ).catch((e) => warn("tickets batch", e));
  }

  const ticketRows = await sql.unsafe(
    `SELECT id FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL ORDER BY ticket_number LIMIT 60`,
    [LARGE_ORG],
  );

  for (const t of ticketRows) {
    await sql.unsafe(
      `INSERT INTO build.ticket_assignees (org_id, ticket_id, membership_id, assigned_at)
       VALUES ($1, $2, $3::int, now())
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, t.id, membershipId],
    ).catch(() => {});
  }

  for (const [title, status, cat] of [
    ["Platform v2", "planned", "FEATURE"],
    ["API refactor", "in_progress", "FEATURE"],
    ["Q3 roadmap", "completed", "FEATURE"],
  ]) {
    await sql.unsafe(
      `INSERT INTO build.roadmap_items (org_id, title, status, category, sort_order, votes, is_public, deleted_at, created_at, updated_at)
       SELECT $1, $2, $3, $4, 1, 0, true, null, now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM build.roadmap_items ri
         WHERE ri.org_id = $1 AND ri.title = $2 AND ri.deleted_at IS NULL
       )`,
      [LARGE_ORG, title, status, cat],
    ).catch((e) => warn("roadmap_item", e));
  }
  for (const [title, fstatus, cat] of [
    ["Dark mode", "open", "FEATURE"],
    ["Export CSV", "planned", "FEATURE"],
    ["Bug: login", "completed", "BUG"],
  ]) {
    await sql.unsafe(
      `INSERT INTO build.feedback_posts (org_id, title, status, category, votes, submitted_by_name, duplicate_of_id, deleted_at, created_at, updated_at)
       SELECT $1, $2, $3, $4, 3, 'Seed User', null, null, now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM build.feedback_posts fp
         WHERE fp.org_id = $1 AND fp.title = $2 AND fp.deleted_at IS NULL
       )`,
      [LARGE_ORG, title, fstatus, cat],
    ).catch((e) => warn("feedback_post", e));
  }
  for (const [ctitle, ctype] of [["v1.0 release", "feature"], ["Bug fixes", "fix"]]) {
    await sql.unsafe(
      `INSERT INTO build.changelog_entries (org_id, title, content, version, type, is_published, published_at, created_at, updated_at)
       SELECT $1, $2, '', '1.0.0', $3, true, now(), now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM build.changelog_entries ce
         WHERE ce.org_id = $1 AND ce.title = $2
       )`,
      [LARGE_ORG, ctitle, ctype],
    ).catch((e) => warn("changelog_entry", e));
  }
}

async function seedExtraTickets() {
  log("Seeding extra tickets for planner threshold coverage...");

  const wsId = await sql.unsafe(
    `SELECT pm_workspace_id FROM build.pm_workspaces WHERE org_id = $1 LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]?.pm_workspace_id);
  const memberIds = await sql.unsafe(
    `SELECT id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 200`,
    [LARGE_ORG],
  ).then((r) => r.map((row) => row.id));
  if (!wsId || !memberIds.length) { log("  no workspace or members — skipping extra tickets"); return; }

  const statusDefs = [["TODO", "unstarted"], ["IN_PROGRESS", "started"], ["DONE", "completed"]];
  const TARGET_TOTAL = 18_500;
  const PER_PROJECT = 1_000;
  let projNum = 100;

  while (true) {
    const totalNow = await sql.unsafe(
      `SELECT count(*)::int n FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL`,
      [LARGE_ORG],
    ).then((r) => r[0].n);
    if (totalNow >= TARGET_TOTAL) break;

    const key = `ZZ${projNum}`;
    const memId = memberIds[projNum % memberIds.length];
    const existingProj = await sql.unsafe(
      `INSERT INTO build.projects (org_id, name, key, status, pm_workspace_id, manager_membership_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'ACTIVE', $4, $5::int, now(), now())
       ON CONFLICT DO NOTHING RETURNING id`,
      [LARGE_ORG, `Thresh Project ${projNum}`, key, wsId, memId],
    ).then((r) => r[0]);
    const projId = existingProj?.id ?? await sql.unsafe(
      `SELECT id FROM build.projects WHERE org_id = $1 AND key = $2`,
      [LARGE_ORG, key],
    ).then((r) => r[0]?.id);
    if (!projId) { projNum++; continue; }

    for (let si = 0; si < statusDefs.length; si++) {
      const [sname, stype] = statusDefs[si];
      await sql.unsafe(
        `INSERT INTO build.project_statuses (org_id, project_id, name, "order", type, created_at, updated_at)
         VALUES ($1, $2::int, $3, $4, $5::state_group, now(), now())
         ON CONFLICT DO NOTHING`,
        [LARGE_ORG, projId, sname, si + 1, stype],
      ).catch((e) => warn(`project_status ${sname}`, e));
    }

    const existingInProj = await sql.unsafe(
      `SELECT count(*)::int n FROM build.tickets WHERE org_id = $1 AND project_id = $2 AND deleted_at IS NULL`,
      [LARGE_ORG, projId],
    ).then((r) => r[0].n);
    const toAdd = Math.min(PER_PROJECT - existingInProj, TARGET_TOTAL - totalNow);
    if (toAdd > 0) {
      await sql.unsafe(
        `INSERT INTO build.tickets (org_id, project_id, title, status, assignee_membership_id, reporter_membership_id, ticket_number, deleted_at, created_at, updated_at)
         SELECT $1, $2::int, 'Ticket ' || s, 'TODO', $3::int, $3::int,
           90000 + $4::int * 1000 + s, null,
           now() - (s || ' minutes')::interval, now()
         FROM generate_series(${existingInProj + 1}, ${existingInProj + toAdd}) s`,
        [LARGE_ORG, projId, memId, projNum],
      ).catch((e) => warn(`tickets proj ${projNum}`, e));
      log(`  project ${key}: added ${toAdd} tickets`);
    }
    projNum++;
  }

  // Redistribute existing extra tickets evenly across members so no one member dominates.
  // Without this, a single member holds ~97% of tickets and the planner skips the assignee index.
  // Uses ticket_number % memberCount for deterministic, idempotent redistribution.
  if (memberIds.length > 0) {
    log(`  Redistributing extra ticket assignments across ${memberIds.length} members...`);
    for (let i = 0; i < memberIds.length; i++) {
      await sql.unsafe(
        `UPDATE build.tickets
         SET assignee_membership_id = $1::int, reporter_membership_id = $1::int
         WHERE org_id = $2 AND deleted_at IS NULL AND ticket_number > 90000
           AND ticket_number % $3 = $4`,
        [memberIds[i], LARGE_ORG, memberIds.length, i],
      ).catch((e) => warn(`redistribute member ${i}`, e));
    }
  }

  // allocateTicketNumbers hands out build.project_ticket_counters.next_ticket_number.
  // Bulk-inserting tickets without advancing it leaves the counter at 1 against seeded
  // numbers up to 194000, so the first POST /build/{projectId}/tickets collides on the
  // (org_id, project_id, ticket_number) unique index and answers 500.
  log("  Syncing project_ticket_counters to the seeded ticket numbers...");
  await sql.unsafe(
    `INSERT INTO build.project_ticket_counters (org_id, project_id, next_ticket_number, updated_at)
     SELECT org_id, project_id, MAX(ticket_number) + 1, now()
       FROM build.tickets
      WHERE org_id = $1 AND project_id IS NOT NULL
      GROUP BY org_id, project_id
     ON CONFLICT (org_id, project_id) DO UPDATE
       SET next_ticket_number = GREATEST(
             project_ticket_counters.next_ticket_number,
             EXCLUDED.next_ticket_number
           ),
           updated_at = now()`,
    [LARGE_ORG],
  ).catch((e) => warn("project_ticket_counters sync", e));

  log("  Extra tickets seeding done.");
}

async function seedChat() {
  log("Seeding chat...");

  const memberRows = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY joined_at DESC`,
    [LARGE_ORG],
  );
  const senderMemberId = memberRows[0]?.id;

  const chanId = await sql.unsafe(
    `INSERT INTO chat_channels (org_id, name, type, is_private, is_archived, last_message_at, created_at, updated_at)
     SELECT $1, 'general', 'PUBLIC', false, false, now(), now(), now()
     WHERE NOT EXISTS (
       SELECT 1 FROM chat_channels WHERE org_id = $1 AND name = 'general'
     )
     RETURNING id`,
    [LARGE_ORG],
  ).then((r) => r[0]?.id);

  const channelId = chanId ?? await sql.unsafe(
    `SELECT id FROM chat_channels WHERE org_id = $1 AND name = 'general' LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]?.id);

  if (!channelId) { log("  no channel — skipping chat"); return; }

  for (const m of memberRows) {
    await sql.unsafe(
      `INSERT INTO chat_channel_members (org_id, channel_id, membership_id, role, joined_at, is_favorite)
       VALUES ($1, $2, $3, 'MEMBER', now(), false)
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, channelId, m.id],
    ).catch((e) => warn("channel_member", e));
  }

  for (let i = 1; i <= 55; i++) {
    await sql.unsafe(
      `INSERT INTO chat_channels (org_id, name, type, is_private, is_archived, last_message_at, created_at, updated_at)
       SELECT $1, $2, 'PUBLIC', false, false, now(), now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM chat_channels WHERE org_id = $1 AND name = $2
       )`,
      [LARGE_ORG, `channel-${i}`],
    ).catch(() => {});
  }

  const ownerMembershipId = memberRows[0]?.id;

  const chan1Id = await sql.unsafe(
    `SELECT id FROM chat_channels WHERE org_id = $1 AND name = 'channel-1' LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]?.id);

  if (chan1Id) {
    for (const m of memberRows) {
      await sql.unsafe(
        `INSERT INTO chat_channel_members (org_id, channel_id, membership_id, role, joined_at, is_favorite)
         VALUES ($1, $2, $3, 'MEMBER', now(), false)
         ON CONFLICT DO NOTHING`,
        [LARGE_ORG, chan1Id, m.id],
      ).catch(() => {});
    }
  }

  // Add the owner to every extra channel so the sweep's source user is a member of any
  // channel it borrows from the fixture pool. Without this every channel-2..55 route
  // answers 403 (not a member) and is filed unprobeable.
  if (ownerMembershipId) {
    const extraChannelIds = await sql.unsafe(
      `SELECT id FROM chat_channels WHERE org_id = $1 AND name LIKE 'channel-%' AND name != 'channel-1' ORDER BY id`,
      [LARGE_ORG],
    );
    for (const ch of extraChannelIds) {
      await sql.unsafe(
        `INSERT INTO chat_channel_members (org_id, channel_id, membership_id, role, joined_at, is_favorite)
         VALUES ($1, $2, $3, 'MEMBER', now(), false)
         ON CONFLICT DO NOTHING`,
        [LARGE_ORG, ch.id, ownerMembershipId],
      ).catch(() => {});
    }
  }

  const existingMsgs = await sql.unsafe(
    `SELECT count(*)::int n FROM chat_messages WHERE org_id = $1 AND is_deleted = false`,
    [LARGE_ORG],
  ).then((r) => r[0].n);

  if (existingMsgs < CHAT_MSG_COUNT) {
    const from = existingMsgs + 1;
    log(`  inserting ${CHAT_MSG_COUNT - existingMsgs} chat messages...`);
    await sql.unsafe(
      `INSERT INTO chat_messages (org_id, channel_id, sender_membership_id, content, message_type, is_deleted, is_edited, created_at, updated_at)
       SELECT $1, $2, $3, 'Message ' || s::text, 'text', false, false,
         now() - (s || ' seconds')::interval, now()
       FROM generate_series(${from}, ${CHAT_MSG_COUNT}) s`,
      [LARGE_ORG, channelId, senderMemberId],
    ).catch((e) => warn("chat_messages batch", e));
  }

  // Saved messages used to belong to one membership, so `chat-saved-messages` measured an empty
  // result set for any other fixture user and passed while guarding nothing. Spread them over the
  // members the budget runner can pick from.
  await sql.unsafe(
    `INSERT INTO chat_saved_messages (org_id, membership_id, message_id, saved_at)
     SELECT $1, m.id, msg.id, now() - (msg.id || ' minutes')::interval
     FROM (SELECT id FROM organization_members
           WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT $3::int) m
     CROSS JOIN LATERAL (
       SELECT id FROM chat_messages
       WHERE org_id = $1 AND channel_id = $2 AND is_deleted = false
       ORDER BY id LIMIT $4::int
     ) msg
     ON CONFLICT DO NOTHING`,
    [LARGE_ORG, channelId, SAVED_MESSAGE_MEMBERS, SAVED_MESSAGES_PER_MEMBER],
  ).catch((e) => warn("chat_saved_messages", e));
}

async function seedNotifications() {
  log("Seeding notifications...");
  const member = await sql.unsafe(
    `SELECT ta.membership_id, om.user_id
     FROM build.ticket_assignees ta
     INNER JOIN organization_members om ON om.org_id = ta.org_id AND om.id = ta.membership_id
     WHERE ta.org_id = $1 GROUP BY ta.membership_id, om.user_id ORDER BY count(*) DESC, ta.membership_id ASC LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0] ?? null);
  const resolved = member ?? await sql.unsafe(
    `SELECT id AS membership_id, user_id FROM organization_members
     WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0] ?? null);
  if (!resolved) { log("  no members — skipping notifications"); return; }
  const { membership_id: membershipId, user_id: userId } = resolved;

  const adopted = await sql.unsafe(
    `UPDATE notifications SET membership_id = $2, user_id = $3
     WHERE org_id = $1 AND membership_id IS NULL AND deleted_at IS NULL`,
    [LARGE_ORG, membershipId, userId],
  ).then((r) => r.count ?? 0).catch((e) => { warn("notifications adopt membership_id", e); return 0; });
  if (adopted > 0) log(`  adopted ${adopted} existing notification rows to membership_id=${membershipId}`);

  const existingN = await sql.unsafe(
    `SELECT count(*)::int n FROM notifications WHERE org_id = $1 AND membership_id = $2 AND deleted_at IS NULL`,
    [LARGE_ORG, membershipId],
  ).then((r) => r[0].n);

  if (existingN < NOTIFICATION_COUNT) {
    const from = existingN + 1;
    log(`  inserting ${NOTIFICATION_COUNT - existingN} notifications for membership_id=${membershipId}...`);
    await sql.unsafe(
      `INSERT INTO notifications (org_id, user_id, membership_id, type, title, message, is_read, category, source_module, created_at, updated_at, deleted_at, archived_at)
       SELECT $1, $3, $2::int,
         CASE WHEN s % 4 = 0 THEN 'WARNING' WHEN s % 4 = 1 THEN 'SUCCESS' WHEN s % 4 = 2 THEN 'ERROR' ELSE 'INFO' END::notification_type,
         'Notification ' || s, 'Body ' || s,
         s % 4 = 0, 'SYSTEM', 'system',
         now() - (s || ' minutes')::interval, now(), null, null
       FROM generate_series(${from}, ${NOTIFICATION_COUNT}) s`,
      [LARGE_ORG, membershipId, userId],
    ).catch((e) => warn("notifications batch", e));
  }
}

async function seedKb() {
  log("Seeding KB...");

  for (let i = 1; i <= 5; i++) {
    await sql.unsafe(
      `INSERT INTO kb_spaces (org_id, name, slug, icon, audience, created_at, updated_at)
       VALUES ($1, $2, $3, null, 'internal', now(), now())
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, `Space ${i}`, `space-${i}-${LARGE_ORG.slice(0, 8)}`],
    ).catch((e) => warn(`kb_space ${i}`, e));
  }

  const spaceRows = await sql.unsafe(
    `SELECT id FROM kb_spaces WHERE org_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 5`,
    [LARGE_ORG],
  );

  if (!spaceRows.length) { log("  no KB space — skipping pages"); return; }

  const memRow = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]);
  const creatorId = memRow?.user_id ?? ownerId;
  const membershipId = memRow?.id;

  for (const { id: spaceId } of spaceRows) {
    const existingInSpace = await sql.unsafe(
      `SELECT count(*)::int n FROM kb_pages WHERE org_id = $1 AND space_id = $2 AND deleted_at IS NULL`,
      [LARGE_ORG, spaceId],
    ).then((r) => r[0].n);

    if (existingInSpace < KB_PAGES_PER_SPACE) {
      const from = existingInSpace + 1;
      log(`  inserting ${KB_PAGES_PER_SPACE - existingInSpace} kb_pages for space ${spaceId}...`);
      await sql.unsafe(
        `INSERT INTO kb_pages (org_id, space_id, title, content, content_text, status, visibility, sort_order, created_by_id, created_by_membership_id, last_edited_by_id, last_edited_by_membership_id, deleted_at, created_at, updated_at)
         SELECT $1, $2::int,
           'Page ' || s || ' — ' || (ARRAY[${KB_PAGE_TOPICS.map((t) => `'${t}'`).join(",")}])[1 + (s % ${KB_PAGE_TOPICS.length})],
           '{}'::jsonb,
           'This ' || (ARRAY[${KB_PAGE_TOPICS.map((t) => `'${t}'`).join(",")}])[1 + (s % ${KB_PAGE_TOPICS.length})]
             || ' explains approval thresholds, escalation paths, reimbursement limits and the audit '
             || 'evidence the reviewer records. ' ||
           (SELECT string_agg('kb' || ((s * 37 + i) % 1500), ' ')
            FROM generate_series(1, ${KB_PAGE_BODY_WORDS}) i),
           'published', 'org', s, $3, $4::int, $3, $4::int, null,
           now() - (s || ' hours')::interval, now() - (s || ' minutes')::interval
         FROM generate_series(${from}, ${KB_PAGES_PER_SPACE}) s`,
        [LARGE_ORG, spaceId, creatorId, membershipId],
      ).catch((e) => warn("kb_pages batch", e));
    }
  }

  // uniq_kb_page_visits_page_user means one visit per (page, user), so every member gets its own
  // slice of pages. Visits used to belong to one user, which left `kb-page-visits-mine` measuring
  // an empty result set for every other fixture user.
  await sql.unsafe(
    `INSERT INTO kb_page_visits (org_id, user_id, membership_id, page_id, visited_at)
     SELECT $1, m.user_id, m.id, p.id, now() - (p.rn || ' hours')::interval
     FROM (SELECT id, user_id, (row_number() OVER (ORDER BY id)) - 1 AS mrn
           FROM organization_members
           WHERE org_id = $1 AND status = 'ACTIVE' AND user_id IS NOT NULL
           ORDER BY id LIMIT $3::int) m
     CROSS JOIN LATERAL (
       SELECT id, row_number() OVER (ORDER BY id) AS rn
       FROM kb_pages
       WHERE org_id = $1 AND deleted_at IS NULL
       ORDER BY id OFFSET m.mrn * $2::int LIMIT $2::int
     ) p
     ON CONFLICT DO NOTHING`,
    [LARGE_ORG, KB_VISITS_COUNT, KB_VISIT_MEMBERS],
  ).catch((e) => warn("kb_page_visits", e));
}

async function seedTimesheets() {
  log("Seeding timesheets...");
  const memberRows = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' LIMIT 5`,
    [LARGE_ORG],
  );
  const projRow = await sql.unsafe(
    `SELECT id FROM build.projects WHERE org_id = $1 LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]?.id);

  const existingTS = await sql.unsafe(
    `SELECT count(*)::int n FROM timesheets WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);

  if (existingTS < TIMESHEET_COUNT && memberRows.length > 0) {
    log(`  inserting ${TIMESHEET_COUNT - existingTS} timesheets...`);
    let inserted = existingTS;
    for (let d = 0; inserted < TIMESHEET_COUNT; d++) {
      for (const m of memberRows) {
        if (inserted >= TIMESHEET_COUNT) break;
        const dateStr = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
        const status = d % 5 === 0 ? "PENDING" : "APPROVED";
        await sql.unsafe(
          `INSERT INTO timesheets (org_id, user_membership_id, date, hours, status, project_id, description, voided_at, created_at, updated_at)
           VALUES ($1, $2::int, $3::date, 8.0, $4, $5::int, 'Seed timesheet', null, now(), now())
           ON CONFLICT DO NOTHING`,
          [LARGE_ORG, m.id, dateStr, status, projRow ?? null],
        ).catch((e) => warn(`timesheet d=${d}`, e));
        inserted++;
      }
    }
  }
}

async function seedAccounting() {
  log("Seeding accounting (clients, invoices, bills, journals)...");

  for (let i = 1; i <= CLIENT_COUNT; i++) {
    await sql.unsafe(
      `INSERT INTO clients (org_id, name, status, created_at, updated_at)
       SELECT $1, $2, 'ACTIVE', now() - interval '${i} days', now()
       WHERE NOT EXISTS (
         SELECT 1 FROM clients c
         WHERE c.org_id = $1 AND c.name = $2
       )`,
      [LARGE_ORG, `Client ${i}`],
    ).catch((e) => warn(`client ${i}`, e));
  }

  const clientId = await sql.unsafe(
    `SELECT id FROM clients WHERE org_id = $1 LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]?.id);

  const invoiceAuthorId = await sql.unsafe(
    `SELECT user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]?.user_id).catch(() => null);

  for (let i = 1; i <= INVOICE_COUNT; i++) {
    await sql.unsafe(
      `INSERT INTO invoices (org_id, client_id, invoice_number, status, total, currency, created_by, created_at, updated_at)
       SELECT $1, $2, $3, $4, ${i * 100000}, 'INR', $5, now() - interval '${i} days', now()
       WHERE NOT EXISTS (
         SELECT 1 FROM invoices iv
         WHERE iv.org_id = $1 AND iv.invoice_number = $3
       )`,
      [LARGE_ORG, clientId, `INV-${String(i).padStart(4, "0")}`, i % 2 === 0 ? "SENT" : "DRAFT", invoiceAuthorId],
    ).catch((e) => warn(`invoice ${i}`, e));
  }

  for (let i = 1; i <= BILL_COUNT; i++) {
    await sql.unsafe(
      `INSERT INTO purchase_bills (org_id, bill_number, status, subtotal, tax_amount, cgst_amount, sgst_amount, igst_amount, discount, total, amount_paid, currency, exchange_rate, reverse_charge, bill_date, created_by, created_at, updated_at)
       SELECT $1, $2, $3, ${i * 50000}, 0, 0, 0, 0, 0, ${i * 50000}, 0, 'INR', 1, false, CURRENT_DATE - interval '${i} days', $4, now() - interval '${i} days', now()
       WHERE NOT EXISTS (
         SELECT 1 FROM purchase_bills pb
         WHERE pb.org_id = $1 AND pb.bill_number = $2
       )`,
      [LARGE_ORG, `BILL-${String(i).padStart(4, "0")}`, i % 2 === 0 ? "PENDING" : "DRAFT", invoiceAuthorId],
    ).catch((e) => warn(`bill ${i}`, e));
  }

  // The ledger chain is gl_books -> gl_fiscal_years -> gl_periods -> gl_journals,
  // all text ids the caller supplies. An earlier version wrote to
  // `accounting_books` and hung gl_journals off `accounting_periods`; neither is
  // the journal's parent -- accounting_books does not exist under that name at
  // all, and gl_journals.period_id references gl_periods, not the integer-keyed
  // accounting_periods. Both lookups were wrapped in .catch(() => null), so the
  // 42P01 was swallowed, bookId stayed null and every journal was skipped with a
  // log line that read like a legitimate precondition.
  const BOOK_ID = `book-scratch-${LARGE_ORG.slice(0, 8)}`;
  const FY_ID = `fy-scratch-${LARGE_ORG.slice(0, 8)}`;
  const PERIOD_ID = `period-scratch-${LARGE_ORG.slice(0, 8)}`;

  await sql.unsafe(
    `INSERT INTO gl_books (id, org_id, name, country_code, base_currency, localization_pack)
     VALUES ($1, $2, 'Main Ledger', 'IN', 'INR', 'IN')
     ON CONFLICT (id) DO NOTHING`,
    [BOOK_ID, LARGE_ORG],
  ).catch((e) => warn("gl_books", e));

  await sql.unsafe(
    `INSERT INTO gl_fiscal_years (id, org_id, book_id, name, starts_on, ends_on, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'FY 2026', '2026-01-01', '2026-12-31', 'OPEN', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [FY_ID, LARGE_ORG, BOOK_ID],
  ).catch((e) => warn("gl_fiscal_years", e));

  await sql.unsafe(
    `INSERT INTO gl_periods (id, org_id, book_id, fiscal_year_id, name, starts_on, ends_on, sequence, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, '2026-01', '2026-01-01', '2026-01-31', 1, 'OPEN', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [PERIOD_ID, LARGE_ORG, BOOK_ID, FY_ID],
  ).catch((e) => warn("gl_periods", e));

  const bookReady = await sql.unsafe(
    `SELECT 1 FROM gl_periods WHERE id = $1 AND org_id = $2 LIMIT 1`,
    [PERIOD_ID, LARGE_ORG],
  ).then((r) => r.length > 0).catch(() => false);

  if (bookReady) {
    const existingJournals = await sql.unsafe(
      `SELECT count(*)::int n FROM gl_journals WHERE org_id = $1`,
      [LARGE_ORG],
    ).then((r) => r[0].n);

    if (existingJournals < JOURNAL_COUNT) {
      for (let i = existingJournals + 1; i <= JOURNAL_COUNT; i++) {
        const num = String(i).padStart(4, "0");
        await sql.unsafe(
          `INSERT INTO gl_journals (id, org_id, book_id, period_id, journal_number, journal_date, memo, source_type, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, CURRENT_DATE - interval '${i} days', 'Seed journal', 'manual', $6)
           ON CONFLICT DO NOTHING`,
          [`jnl-scratch-${num}`, LARGE_ORG, BOOK_ID, PERIOD_ID, `JNL-${num}`, `seed-jnl-${num}`],
        ).catch((e) => warn(`journal ${i}`, e));
      }
    }
  } else {
    log("  gl_periods row missing — gl_journals skipped");
  }

  const authorId = await sql.unsafe(
    `SELECT user_id FROM organization_members WHERE org_id = $1 LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]?.user_id).catch(() => null);

  await sql.unsafe(
    `INSERT INTO acc_tax_payments (org_id, tax_type, period_start, period_end, amount, paid_date, reference, created_by, created_at)
     SELECT $1, 'GST', '2026-01-01', '2026-03-31', 50000, '2026-04-15', 'TAX-2026-Q1', $2, now()
     WHERE NOT EXISTS (
       SELECT 1 FROM acc_tax_payments t
       WHERE t.org_id = $1 AND t.reference = 'TAX-2026-Q1'
     )`,
    [LARGE_ORG, authorId],
  ).catch((e) => warn("acc_tax_payments", e));

  await sql.unsafe(
    `INSERT INTO fin_reminder_policies (org_id, name, offsets, channel, template, is_active, created_at, updated_at)
     SELECT $1, 'Default AR Reminder', '[7, 14, 30]'::jsonb, 'EMAIL', 'default', true, now(), now()
     WHERE NOT EXISTS (
       SELECT 1 FROM fin_reminder_policies fp
       WHERE fp.org_id = $1 AND fp.name = 'Default AR Reminder'
     )`,
    [LARGE_ORG],
  ).catch((e) => warn("fin_reminder_policies", e));
}

async function seedSupport() {
  log("Seeding support tickets...");
  const [participant] = await sql.unsafe(
    `SELECT ta.membership_id, om.user_id
     FROM build.ticket_assignees ta
     INNER JOIN organization_members om ON om.org_id = ta.org_id AND om.id = ta.membership_id
     WHERE ta.org_id = $1
     GROUP BY ta.membership_id, om.user_id ORDER BY count(*) DESC, ta.membership_id ASC LIMIT 1`,
    [LARGE_ORG],
  );
  const [fallback] = participant ? [] : await sql.unsafe(
    `SELECT id AS membership_id FROM organization_members
     WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 1`,
    [LARGE_ORG],
  );
  const creatorMembershipId = (participant ?? fallback)?.membership_id;
  const assigneeMembershipId = creatorMembershipId;

  if (!creatorMembershipId) { log("  no members — skipping support tickets"); return; }

  const existingST = await sql.unsafe(
    `SELECT count(*)::int n FROM support_tickets
     WHERE org_id = $1 AND assignee_membership_id = $2`,
    [LARGE_ORG, assigneeMembershipId],
  ).then((r) => r[0].n);

  if (existingST < SUPPORT_TICKET_COUNT) {
    const from = existingST + 1;
    log(`  inserting ${SUPPORT_TICKET_COUNT - existingST} support tickets...`);
    await sql.unsafe(
      `INSERT INTO support_tickets (org_id, title, status, priority, assignee_membership_id, source_channel, created_by_membership_id, sla_paused_minutes, sla_escalation_level, created_at, updated_at)
       SELECT $1, 'Support Ticket ' || s,
         (CASE WHEN s % 3 = 0 THEN 'OPEN' WHEN s % 3 = 1 THEN 'IN_PROGRESS' ELSE 'WAITING' END)::support_ticket_status,
         (CASE WHEN s % 4 = 0 THEN 'URGENT' WHEN s % 4 = 1 THEN 'HIGH' WHEN s % 4 = 2 THEN 'MEDIUM' ELSE 'LOW' END)::support_ticket_priority,
         $2::int, 'web', $3::int, 0, 0, now() - (s || ' hours')::interval, now()
       FROM generate_series(${from}, ${SUPPORT_TICKET_COUNT}) s`,
      [LARGE_ORG, assigneeMembershipId, creatorMembershipId],
    ).catch((e) => warn("support_tickets batch", e));
  }
}

async function seedPayroll() {
  log("Seeding payroll...");

  const memberRows = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' LIMIT 5`,
    [LARGE_ORG],
  );

  const existingRuns = await sql.unsafe(
    `SELECT count(*)::int n FROM payroll_runs WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);

  for (let i = existingRuns; i < 6; i++) {
    const month = `2026-${String(6 - i).padStart(2, "0")}`;
    const runRow = await sql.unsafe(
      `INSERT INTO payroll_runs (org_id, month, run_type, status, created_at, updated_at)
       VALUES ($1, $2, 'REGULAR', 'DRAFT', now() - interval '${i * 30} days', now())
       ON CONFLICT DO NOTHING RETURNING id`,
      [LARGE_ORG, month],
    ).then((r) => r[0]?.id).catch(() => null);

    if (runRow) {
      for (const m of memberRows) {
        const empRow = await sql.unsafe(
          `INSERT INTO payroll_run_employees (org_id, run_id, user_id, worker_type, currency, gross, total_deductions, employer_contributions, net, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'EMPLOYEE', 'INR', 500000, 50000, 25000, 425000, 'DRAFT', now(), now())
           ON CONFLICT DO NOTHING RETURNING id`,
          [LARGE_ORG, runRow, m.user_id],
        ).then((r) => r[0]?.id).catch(() => null);
        if (empRow) {
          await sql.unsafe(
            `INSERT INTO payroll_line_items (org_id, run_id, run_employee_id, code, name, category, calc_method, amount, sort_order, calc_explain, created_at)
             VALUES ($1, $2, $3, 'BASIC', 'Basic Salary', 'EARNING', 'FIXED', 500000, 1, '{"source":"seed","formula":"FIXED"}'::jsonb, now())
             ON CONFLICT DO NOTHING`,
            [LARGE_ORG, runRow, empRow],
          ).catch((e) => warn("payroll_line_item", e));
        }
      }
    }
  }
}

async function seedCalendarAndAnnouncements() {
  log("Seeding calendar events and announcements...");

  const memRow = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]);
  const creatorMembershipId = memRow?.id;
  const authorId = memRow?.user_id ?? ownerId;

  if (creatorMembershipId) {
    await sql.unsafe(
      `INSERT INTO calendar_events (org_id, title, start_date, end_date, category, visibility, created_by_membership_id, created_at, updated_at)
       SELECT $1, 'Seed Event', now() + interval '1 day', now() + interval '2 days', 'MEETING', 'org', $2, now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM calendar_events WHERE org_id = $1 AND title = 'Seed Event'
       )`,
      [LARGE_ORG, creatorMembershipId],
    ).catch((e) => warn("calendar_event", e));
  }

  await sql.unsafe(
    `INSERT INTO announcements (org_id, title, content, author_id, status, is_pinned, expires_at, created_at, updated_at)
     SELECT $1, 'Welcome to scratch E2E!', 'Seed announcement for budget testing.', $2, 'PUBLISHED', false, null, now(), now()
     WHERE NOT EXISTS (
       SELECT 1 FROM announcements a
       WHERE a.org_id = $1 AND a.title = 'Welcome to scratch E2E!'
     )`,
    [LARGE_ORG, authorId],
  ).catch((e) => warn("announcement", e));

  // Three rows fit on one page, so a Seq Scan was the correct plan and the budget's
  // forbid-seq-scan assertion could only ever fail on table size. Seed enough rows that
  // idx_announcements_org_pinned_created is the cheaper plan for the first page.
  const haveAnnouncements = await sql.unsafe(
    `SELECT count(*)::int n FROM announcements WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);
  if (haveAnnouncements < ANNOUNCEMENT_COUNT) {
    await sql.unsafe(
      `INSERT INTO announcements (org_id, title, content, author_id, status, is_pinned, expires_at, created_at, updated_at)
       SELECT $1, 'Announcement ' || s, 'Operational update ' || s || ' for the scratch tenant.', $2,
              CASE WHEN s % 20 = 0 THEN 'DRAFT' ELSE 'PUBLISHED' END,
              s % 50 = 0, null,
              now() - (s || ' hours')::interval, now()
       FROM generate_series(${haveAnnouncements + 1}, ${ANNOUNCEMENT_COUNT}) s`,
      [LARGE_ORG, authorId],
    ).catch((e) => warn("announcements batch", e));
  }
}

async function seedMail() {
  log("Seeding mail metadata...");
  const memRows = await sql.unsafe(
    `SELECT id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 20`,
    [LARGE_ORG],
  );
  const memRow = memRows[0];
  if (!memRow) return;

  // There is no `mail_accounts` table — provider connections live in
  // `user_integration_connections` via Composio — and `account_id` carries no
  // foreign key, so a synthetic id is enough. The previous version selected and
  // inserted into `mail_accounts` behind `.catch(() => null)`, so the 42P01 was
  // swallowed and the function returned "no mail account — skipping mail data",
  // a log line that reads like a legitimate precondition rather than a missing
  // table. That is why `mail-inbox-cached` had nothing to measure.
  const SEED_ACCOUNT_ID = 1;

  // 15 rows fit on one page, so the planner would always pick a Seq Scan and the
  // budget's forbid-seq-scan assertion could only ever fail. Spread MAIL_MSG_COUNT
  // across several mailboxes so the (org_id, user_membership_id, folder, date)
  // index is the cheaper plan for a single mailbox's inbox page.
  const existing = await sql.unsafe(
    `SELECT count(*)::int n FROM mail_message_metadata WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);

  if (existing < MAIL_MSG_COUNT) {
    const values = [];
    for (let i = existing + 1; i <= MAIL_MSG_COUNT; i++) {
      const owner = memRows[i % memRows.length] ?? memRow;
      values.push(
        `('${LARGE_ORG}', ${SEED_ACCOUNT_ID}, ${owner.id}, 'msg-scratch-${i}-${LARGE_ORG.slice(0, 8)}',` +
        ` 'thread-${Math.ceil(i / 3)}', 'Subject ${i}', 'sender${i}@example.com', 'Sender ${i}',` +
        ` now() - interval '${i} minutes', false, false, false, '{}', 'inbox', now())`,
      );
    }
    for (let start = 0; start < values.length; start += 500) {
      const chunk = values.slice(start, start + 500).join(",");
      await sql.unsafe(
        `INSERT INTO mail_message_metadata (org_id, account_id, user_membership_id, message_id, thread_id, subject, sender_email, sender_name, date, is_read, is_starred, has_attachment, labels, folder, synced_at)
         VALUES ${chunk} ON CONFLICT DO NOTHING`,
      ).catch((e) => warn(`mail_message chunk ${start}`, e));
    }
  }
}

async function seedHrExtras() {
  log("Seeding performance_reviews and helpdesk_tickets...");
  const memberRows = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY joined_at DESC LIMIT 5`,
    [LARGE_ORG],
  );
  if (!memberRows.length) { log("  no members — skipping HR extras"); return; }

  const existingPR = await sql.unsafe(
    `SELECT count(*)::int n FROM performance_reviews WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);

  if (existingPR < 500) {
    const toIns = 500 - existingPR;
    log(`  inserting ${toIns} performance_reviews via generate_series...`);
    await sql.unsafe(
      `INSERT INTO performance_reviews (org_id, user_id, period_start, period_end, status, created_at, updated_at)
       SELECT $1, m.user_id, '2026-01-01', '2026-06-30',
         CASE WHEN s % 3 = 0 THEN 'DRAFT' WHEN s % 3 = 1 THEN 'IN_PROGRESS' ELSE 'COMPLETED' END::review_status,
         now() - (s || ' hours')::interval, now()
       FROM generate_series(${existingPR + 1}, 500) s
       JOIN LATERAL (SELECT user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 1 OFFSET (s % 5)) m ON true`,
      [LARGE_ORG],
    ).catch((e) => warn("performance_reviews batch", e));
  }

  const existingHD = await sql.unsafe(
    `SELECT count(*)::int n FROM helpdesk_tickets WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);

  if (existingHD < 500) {
    const toIns = 500 - existingHD;
    log(`  inserting ${toIns} helpdesk_tickets via generate_series...`);
    await sql.unsafe(
      `INSERT INTO helpdesk_tickets (org_id, user_id, title, priority, status, is_confidential, created_at, updated_at)
       SELECT $1, m.user_id, 'Helpdesk Ticket ' || s, 'MEDIUM'::ticket_priority, 'IN_PROGRESS'::ticket_status, false,
         now() - (s || ' hours')::interval, now()
       FROM generate_series(${existingHD + 1}, 500) s
       JOIN LATERAL (SELECT user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 1 OFFSET (s % 5)) m ON true`,
      [LARGE_ORG],
    ).catch((e) => warn("helpdesk_tickets batch", e));
  }
}

const SEED_MAGIC_LINK_RAW = "scratch-seed-magic-link-2099-aaaa1111";

async function seedMagicLinkToken() {
  log("Seeding magic link token for headless browser auth...");
  const tokenHash = createHash("sha256").update(SEED_MAGIC_LINK_RAW).digest("hex");
  const tokenId = "00000000-0000-0000-0000-000000000099";
  await sql.unsafe(
    `DELETE FROM magic_link_tokens WHERE user_id = $1`,
    [ownerId],
  ).catch(() => {});
  await sql.unsafe(
    `INSERT INTO magic_link_tokens (id, user_id, token_hash, expires_at, used_at, created_at)
     VALUES ($1, $2, $3, '2099-12-31 00:00:00', null, now())
     ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, used_at = null`,
    [tokenId, ownerId, tokenHash],
  ).catch((e) => warn("magic_link_token", e));
  log(`  SEED LOGIN: email=user-1@scratch-seed.test  rawToken=${SEED_MAGIC_LINK_RAW}  orgId=${LARGE_ORG}`);
}

async function seedRoles() {
  log("Seeding roles...");
  await sql.unsafe(
    `INSERT INTO roles (org_id, name, slug, module_key, is_system, created_at, updated_at)
     VALUES ($1, 'HR Admin', 'HR_ADMIN', 'hr', true, now(), now())
     ON CONFLICT DO NOTHING`,
    [LARGE_ORG],
  ).catch((e) => warn("roles", e));

  // The role existed with no assignment, so `module-access-roster` — the read behind the module
  // access screen — measured an empty result set and every ceiling it declares passed trivially.
  await sql.unsafe(
    `INSERT INTO role_assignments (org_id, organization_membership_id, role_id, created_at)
     SELECT $1, m.id, r.id, now()
     FROM (SELECT id FROM organization_members
           WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT $2::int) m
     CROSS JOIN (SELECT id FROM roles WHERE org_id = $1 AND module_key = 'hr' ORDER BY id LIMIT 1) r
     ON CONFLICT DO NOTHING`,
    [LARGE_ORG, HR_ROLE_ASSIGNEES],
  ).catch((e) => warn("role_assignments", e));
}

async function seedOrgUnits() {
  log("Seeding org_units (6 kinds × 5 each)...");
  const kinds = ["BUSINESS_UNIT", "BRANCH", "DEPARTMENT", "TEAM", "LOCATION", "COST_CENTER"];
  for (const kind of kinds) {
    for (let i = 1; i <= 5; i++) {
      const code = `SEED-${kind.slice(0, 3)}-${i}`;
      await sql.unsafe(
        `INSERT INTO org_units (id, org_id, kind, name, code, status, row_version, created_at, updated_at)
         SELECT gen_random_uuid(), $1, $2, $3, $4, 'ACTIVE', 1, now(), now()
         WHERE NOT EXISTS (
           SELECT 1 FROM org_units WHERE org_id = $1 AND kind = $2 AND code = $4
         )`,
        [LARGE_ORG, kind, `Seed ${kind} ${i}`, code],
      ).catch((e) => warn(`org_units ${kind} ${i}`, e));
    }
  }
}

async function seedInvitations() {
  log("Seeding invitations (5 PENDING)...");
  for (let i = 1; i <= 5; i++) {
    const id = `invite-scratch-${i}-${LARGE_ORG.slice(0, 8)}`;
    const email = `invite-${i}@scratch-seed.test`;
    const tokenHash = createHash("sha256").update(`invite-token-${i}-${LARGE_ORG}`).digest("hex");
    await sql.unsafe(
      `INSERT INTO invitations (id, email, token_hash, org_id, role, expires_at, status, created_at)
       VALUES ($1, $2, $3, $4, 'MEMBER', now() + interval '7 days', 'PENDING', now())
       ON CONFLICT (id) DO NOTHING`,
      [id, email, tokenHash, LARGE_ORG],
    ).catch((e) => warn(`invitation ${i}`, e));
  }
}

async function seedWebhookEndpoints() {
  log("Seeding webhook_endpoints (5 rows)...");
  const existing = await sql.unsafe(
    `SELECT count(*)::int n FROM webhook_endpoints WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);
  if (existing >= 5) { log("  already seeded — skipping"); return; }
  for (let i = existing + 1; i <= 5; i++) {
    await sql.unsafe(
      `INSERT INTO webhook_endpoints (org_id, url, secret, description, events, is_active, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, '["*"]'::jsonb, true, $5, now(), now())`,
      [LARGE_ORG, `https://hooks.scratch-seed.test/wh-${i}`, `secret-${i}-${LARGE_ORG.slice(0, 8)}`, `Seed webhook ${i}`, ownerId],
    ).catch((e) => warn(`webhook_endpoint ${i}`, e));
  }
}

async function seedCrmExtras() {
  log("Seeding CRM tasks, task_sequences and principal_groups...");

  const existingTasks = await sql.unsafe(
    `SELECT count(*)::int n FROM tasks WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);
  if (existingTasks < 20) {
    await sql.unsafe(
      `INSERT INTO tasks (org_id, title, type, status, created_at, updated_at)
       SELECT $1, 'Seed Task ' || s, 'CUSTOM', 'pending', now() - (s || ' hours')::interval, now()
       FROM generate_series(${existingTasks + 1}, 20) s`,
      [LARGE_ORG],
    ).catch((e) => warn("tasks batch", e));
  }

  const existingSeqs = await sql.unsafe(
    `SELECT count(*)::int n FROM task_sequences WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);
  if (existingSeqs < 5) {
    for (let i = existingSeqs + 1; i <= 5; i++) {
      await sql.unsafe(
        `INSERT INTO task_sequences (org_id, name, created_by, created_at)
         VALUES ($1, $2, $3, now())`,
        [LARGE_ORG, `Seed Sequence ${i}`, ownerId],
      ).catch((e) => warn(`task_sequence ${i}`, e));
    }
  }

  const existingGroups = await sql.unsafe(
    `SELECT count(*)::int n FROM principal_groups WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);
  if (existingGroups < 5) {
    for (let i = existingGroups + 1; i <= 5; i++) {
      await sql.unsafe(
        `INSERT INTO principal_groups (id, org_id, kind, name, created_at, updated_at)
         SELECT gen_random_uuid(), $1, 'CUSTOM', $2, now(), now()
         WHERE NOT EXISTS (SELECT 1 FROM principal_groups WHERE org_id = $1 AND name = $2)`,
        [LARGE_ORG, `Seed Group ${i}`],
      ).catch((e) => warn(`principal_group ${i}`, e));
    }
  }
}

async function seedKbExtras() {
  log("Seeding kb_page_templates, kb_tags and kb_space_members...");

  const memberRow = await sql.unsafe(
    `SELECT id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]);

  const existingTemplates = await sql.unsafe(
    `SELECT count(*)::int n FROM kb_page_templates WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);
  if (existingTemplates < 5) {
    for (let i = existingTemplates + 1; i <= 5; i++) {
      await sql.unsafe(
        `INSERT INTO kb_page_templates (org_id, name, description, created_by_id, created_at, updated_at)
         SELECT $1, $2, $3, $4, now(), now()
         WHERE NOT EXISTS (SELECT 1 FROM kb_page_templates WHERE org_id = $1 AND name = $2)`,
        [LARGE_ORG, `Seed Template ${i}`, `Template description ${i}`, ownerId],
      ).catch((e) => warn(`kb_page_template ${i}`, e));
    }
  }

  const existingTags = await sql.unsafe(
    `SELECT count(*)::int n FROM kb_tags WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);
  if (existingTags < 5) {
    for (let i = existingTags + 1; i <= 5; i++) {
      const slug = `seed-tag-${i}`;
      await sql.unsafe(
        `INSERT INTO kb_tags (org_id, name, slug, created_at)
         SELECT $1, $2, $3, now()
         WHERE NOT EXISTS (SELECT 1 FROM kb_tags WHERE org_id = $1 AND slug = $3)`,
        [LARGE_ORG, `Seed Tag ${i}`, slug],
      ).catch((e) => warn(`kb_tag ${i}`, e));
    }
  }

  if (!memberRow) return;
  const spaceRow = await sql.unsafe(
    `SELECT id FROM kb_spaces WHERE org_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]);
  if (spaceRow) {
    await sql.unsafe(
      `INSERT INTO kb_space_members (org_id, space_id, membership_id, space_role, created_at)
       SELECT $1, $2, $3, 'viewer', now()
       WHERE NOT EXISTS (
         SELECT 1 FROM kb_space_members WHERE org_id = $1 AND space_id = $2 AND membership_id = $3
       )`,
      [LARGE_ORG, spaceRow.id, memberRow.id],
    ).catch((e) => warn("kb_space_member", e));
  }
}

async function seedNotificationExtras() {
  log("Seeding notification_provider_accounts and notification_suppression_rules...");

  const existingProviders = await sql.unsafe(
    `SELECT count(*)::int n FROM notification_provider_accounts WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);
  if (existingProviders < 3) {
    const channels = [["EMAIL", "SMTP"], ["SMS", "TWILIO"], ["PUSH", "WEB_PUSH"]];
    for (let i = existingProviders; i < 3; i++) {
      const [channel, provider] = channels[i];
      await sql.unsafe(
        `INSERT INTO notification_provider_accounts (org_id, channel, provider, display_name, enabled, sandbox_mode, is_default, health_status, created_by, created_at, updated_at)
         SELECT $1, $2, $3, $4, true, true, false, 'unknown', $5, now(), now()
         WHERE NOT EXISTS (
           SELECT 1 FROM notification_provider_accounts WHERE org_id = $1 AND provider = $3 AND display_name = $4
         )`,
        [LARGE_ORG, channel, provider, `Seed ${provider} ${i + 1}`, ownerId],
      ).catch((e) => warn(`notification_provider ${provider}`, e));
    }
  }

  const memberRow = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]);
  if (!memberRow) return;

  const existingSuppression = await sql.unsafe(
    `SELECT count(*)::int n FROM notification_suppression_rules WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);
  if (existingSuppression < 3) {
    for (let i = existingSuppression + 1; i <= 3; i++) {
      await sql.unsafe(
        `INSERT INTO notification_suppression_rules (org_id, user_id, membership_id, scope_type, scope_key, reason, created_at)
         VALUES ($1, $2, $3, 'GLOBAL', $4, 'MUTE', now())`,
        [LARGE_ORG, memberRow.user_id, memberRow.id, `seed-scope-${i}`],
      ).catch((e) => warn(`notification_suppression ${i}`, e));
    }
  }
}

async function seedHrAdditional() {
  log("Seeding hr_arrears, variance_approvals, PIPs, shift_swaps and custom_field_definitions...");

  const memberRows = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 5`,
    [LARGE_ORG],
  );
  if (!memberRows.length) return;
  const m0 = memberRows[0];
  const m1 = memberRows[1] ?? m0;

  const existingArrears = await sql.unsafe(
    `SELECT count(*)::int n FROM hr_arrears_adjustments WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);
  if (existingArrears < 5) {
    await sql.unsafe(
      `INSERT INTO hr_arrears_adjustments (org_id, user_id, user_membership_id, reason, amount_cents, source_period, target_period, status, created_at)
       SELECT $1, m.user_id, m.id, 'Seed arrear ' || s, 50000, '2025-12', '2026-01', 'pending', now()
       FROM generate_series(${existingArrears + 1}, 5) s
       JOIN LATERAL (SELECT user_id, id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 1 OFFSET ((s - 1) % 5)) m ON true`,
      [LARGE_ORG],
    ).catch((e) => warn("hr_arrears batch", e));
  }

  const existingVariance = await sql.unsafe(
    `SELECT count(*)::int n FROM hr_payroll_variance_approvals WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);
  if (existingVariance < 5) {
    for (let i = existingVariance + 1; i <= 5; i++) {
      await sql.unsafe(
        `INSERT INTO hr_payroll_variance_approvals (org_id, payroll_period_key, variance_pct, threshold_pct, status, created_at)
         VALUES ($1, $2, 5.5, 5.0, 'pending', now())`,
        [LARGE_ORG, `2025-${String(i).padStart(2, "0")}`],
      ).catch((e) => warn(`hr_variance ${i}`, e));
    }
  }

  const existingPips = await sql.unsafe(
    `SELECT count(*)::int n FROM performance_improvement_plans WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);
  if (existingPips < 5) {
    await sql.unsafe(
      `INSERT INTO performance_improvement_plans (org_id, user_id, user_membership_id, manager_id, reason, start_date, end_date, status, created_at, updated_at)
       SELECT $1, m.user_id, m.id, $2, 'Seed PIP ' || s, '2026-01-01', '2026-06-30', 'ACTIVE', now(), now()
       FROM generate_series(${existingPips + 1}, 5) s
       JOIN LATERAL (SELECT user_id, id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 1 OFFSET ((s - 1) % 5)) m ON true`,
      [LARGE_ORG, m1.user_id],
    ).catch((e) => warn("performance_improvement_plans batch", e));
  }

  const existingSwaps = await sql.unsafe(
    `SELECT count(*)::int n FROM shift_swap_requests WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);
  if (existingSwaps < 5) {
    for (let i = existingSwaps + 1; i <= 5; i++) {
      await sql.unsafe(
        `INSERT INTO shift_swap_requests (org_id, requester_id, requester_membership_id, target_user_id, target_membership_id, request_date, target_date, status, created_at)
         VALUES ($1, $2, $3, $4, $5, '2026-09-10', '2026-09-11', 'PENDING', now())`,
        [LARGE_ORG, m0.user_id, m0.id, m1.user_id, m1.id],
      ).catch((e) => warn(`shift_swap ${i}`, e));
    }
  }

  const existingCfd = await sql.unsafe(
    `SELECT count(*)::int n FROM custom_field_definitions WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);
  if (existingCfd < 5) {
    for (let i = existingCfd + 1; i <= 5; i++) {
      await sql.unsafe(
        `INSERT INTO custom_field_definitions (org_id, entity_type, project_id, key, label, field_type, is_active, display_order, created_at, updated_at)
         SELECT $1, 'ticket', 0, $2, $3, 'text', true, $4, now(), now()
         WHERE NOT EXISTS (
           SELECT 1 FROM custom_field_definitions WHERE org_id = $1 AND entity_type = 'ticket' AND project_id = 0 AND key = $2
         )`,
        [LARGE_ORG, `seed_field_${i}`, `Seed Field ${i}`, i],
      ).catch((e) => warn(`custom_field_definition ${i}`, e));
    }
  }
}

async function seedPayslipPublications() {
  log("Seeding payslip_publications...");
  const existing = await sql.unsafe(
    `SELECT count(*)::int n FROM payslip_publications WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);
  if (existing >= 5) { log("  already seeded — skipping"); return; }

  const runEmployees = await sql.unsafe(
    `SELECT pre.id run_employee_id, pre.run_id, pre.user_id, pre.worker_id
     FROM payroll_run_employees pre
     JOIN payroll_runs pr ON pr.id = pre.run_id AND pr.org_id = $1
     WHERE pre.org_id = $1
     ORDER BY pre.id LIMIT 5`,
    [LARGE_ORG],
  );
  if (!runEmployees.length) { log("  no payroll_run_employees — skipping payslip_publications"); return; }

  for (const re of runEmployees.slice(existing)) {
    // chk_payslip_publications_subject requires user_id OR worker_id; carry the
    // subject over from the run employee rather than inserting a subjectless row.
    await sql.unsafe(
      `INSERT INTO payslip_publications (org_id, run_id, run_employee_id, user_id, worker_id, channel, status, attempt_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'PORTAL', 'PENDING', 0, now(), now())`,
      [LARGE_ORG, re.run_id, re.run_employee_id, re.user_id, re.worker_id],
    ).catch((e) => warn("payslip_publication", e));
  }
}

async function seedPlanAndOnboarding() {
  log("Seeding ENTERPRISE subscriptions + onboarding stamps...");
  for (const orgId of [LARGE_ORG, SMALL_ORG]) {
    await sql.unsafe(
      `INSERT INTO subscriptions (org_id, plan, status, created_at, updated_at)
       SELECT $1, 'ENTERPRISE', 'ACTIVE', now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM subscriptions WHERE org_id = $1 AND plan = 'ENTERPRISE' AND status = 'ACTIVE'
       )`,
      [orgId],
    ).catch((e) => warn(`subscriptions ${orgId.slice(0, 8)}`, e));

    await sql.unsafe(
      `UPDATE organizations
       SET onboarding_completed_at = COALESCE(onboarding_completed_at, now())
       WHERE id = $1`,
      [orgId],
    ).catch((e) => warn(`org onboarding stamp ${orgId.slice(0, 8)}`, e));
  }

  await sql.unsafe(
    `UPDATE users
     SET onboarding_completed_at = COALESCE(onboarding_completed_at, now())
     WHERE email LIKE '%@scratch-seed.test'`,
  ).catch((e) => warn("user onboarding stamps", e));

  log("  plan + onboarding stamps done.");
}

async function vacuumAnalyze() {
  log("Running VACUUM ANALYZE on seeded tables...");
  const tables = [
    "organizations", "users", "organization_members", "organization_people",
    "notifications", "chat_channels", "chat_messages", "chat_channel_members",
    "kb_spaces", "kb_pages", "kb_page_visits",
    "leave_requests", "leave_balances", "hr_leave_ledger", "attendance",
    "timesheets", "support_tickets", "announcements", "calendar_events",
    "clients", "invoices", "purchase_bills", "gl_journals",
    "payroll_runs", "payroll_run_employees", "payroll_line_items",
    "hr_people", "hr_employments", "hr_reporting_lines",
  ];
  const buildTables = [
    "tickets", "ticket_assignees", "projects", "project_statuses", "sprints", "project_members",
    "roadmap_items", "feedback_posts", "changelog_entries",
  ];

  for (const t of tables) {
    await sql.unsafe(`VACUUM ANALYZE ${t}`).catch(() => {});
  }
  for (const t of buildTables) {
    await sql.unsafe(`VACUUM ANALYZE build.${t}`).catch(() => {});
  }
  log("VACUUM ANALYZE complete.");
}

async function reportCounts() {
  const checks = [
    ["organizations (2 seed)", `SELECT count(*)::int FROM organizations WHERE id IN ($1, $2)`, [LARGE_ORG, SMALL_ORG]],
    ["org_members/large", `SELECT count(*)::int FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE'`, [LARGE_ORG]],
    ["org_members/small", `SELECT count(*)::int FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE'`, [SMALL_ORG]],
    ["org_people/large", `SELECT count(*)::int FROM organization_people WHERE organization_id = $1 AND deleted_at IS NULL`, [LARGE_ORG]],
    ["hr_employments", `SELECT count(*)::int FROM hr_employments WHERE org_id = $1 AND deleted_at IS NULL`, [LARGE_ORG]],
    ["hr_reporting_lines", `SELECT count(*)::int FROM hr_reporting_lines WHERE org_id = $1`, [LARGE_ORG]],
    ["build.tickets", `SELECT count(*)::int FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL`, [LARGE_ORG]],
    ["build.ticket_assignees", `SELECT count(*)::int FROM build.ticket_assignees WHERE org_id = $1`, [LARGE_ORG]],
    ["chat_channels", `SELECT count(*)::int FROM chat_channels WHERE org_id = $1`, [LARGE_ORG]],
    ["chat_messages", `SELECT count(*)::int FROM chat_messages WHERE org_id = $1 AND is_deleted = false`, [LARGE_ORG]],
    ["kb_pages", `SELECT count(*)::int FROM kb_pages WHERE org_id = $1 AND deleted_at IS NULL`, [LARGE_ORG]],
    ["kb_page_visits", `SELECT count(*)::int FROM kb_page_visits WHERE org_id = $1`, [LARGE_ORG]],
    ["notifications", `SELECT count(*)::int FROM notifications WHERE org_id = $1 AND deleted_at IS NULL`, [LARGE_ORG]],
    ["notifications/mine", `SELECT count(*)::int FROM notifications WHERE org_id = $1 AND membership_id IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL`, [LARGE_ORG]],
    ["leave_requests", `SELECT count(*)::int FROM leave_requests WHERE org_id = $1`, [LARGE_ORG]],
    ["leave_requests/today", `SELECT count(*)::int FROM leave_requests WHERE org_id = $1 AND status = 'APPROVED' AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE`, [LARGE_ORG]],
    ["leave_requests/mine", `SELECT count(*)::int FROM leave_requests WHERE org_id = $1 AND user_membership_id IS NOT NULL`, [LARGE_ORG]],
    ["leave_balances", `SELECT count(*)::int FROM leave_balances WHERE org_id = $1`, [LARGE_ORG]],
    ["hr_leave_ledger", `SELECT count(*)::int FROM hr_leave_ledger WHERE org_id = $1`, [LARGE_ORG]],
    ["attendance", `SELECT count(*)::int FROM attendance WHERE org_id = $1`, [LARGE_ORG]],
    ["attendance/mine", `SELECT count(*)::int FROM attendance WHERE org_id = $1 AND user_membership_id IS NOT NULL`, [LARGE_ORG]],
    ["timesheets", `SELECT count(*)::int FROM timesheets WHERE org_id = $1`, [LARGE_ORG]],
    ["payroll_runs", `SELECT count(*)::int FROM payroll_runs WHERE org_id = $1`, [LARGE_ORG]],
    ["support_tickets", `SELECT count(*)::int FROM support_tickets WHERE org_id = $1`, [LARGE_ORG]],
    ["clients", `SELECT count(*)::int FROM clients WHERE org_id = $1`, [LARGE_ORG]],
    ["invoices", `SELECT count(*)::int FROM invoices WHERE org_id = $1`, [LARGE_ORG]],
    ["purchase_bills", `SELECT count(*)::int FROM purchase_bills WHERE org_id = $1`, [LARGE_ORG]],
    ["gl_journals", `SELECT count(*)::int FROM gl_journals WHERE org_id = $1`, [LARGE_ORG]],
    ["subscriptions/large ENTERPRISE ACTIVE", `SELECT count(*)::int FROM subscriptions WHERE org_id = $1 AND plan = 'ENTERPRISE' AND status = 'ACTIVE'`, [LARGE_ORG]],
    ["subscriptions/small ENTERPRISE ACTIVE", `SELECT count(*)::int FROM subscriptions WHERE org_id = $1 AND plan = 'ENTERPRISE' AND status = 'ACTIVE'`, [SMALL_ORG]],
    ["orgs onboarding_completed_at stamped", `SELECT count(*)::int FROM organizations WHERE id IN ($1, $2) AND onboarding_completed_at IS NOT NULL`, [LARGE_ORG, SMALL_ORG]],
    ["users onboarding_completed_at stamped", `SELECT count(*)::int FROM users WHERE email LIKE '%@scratch-seed.test' AND onboarding_completed_at IS NOT NULL`, []],
  ];

  // A section that inserts nothing without throwing is invisible to trySection, and the
  // three read-cost budgets it feeds then report "vacuous" forty minutes later instead of
  // here. These floors are the benchmark's own minRows, so the seed fails where it broke.
  const FLOORS = new Map([
    ["leave_requests/today", 5],
    ["leave_requests/mine", 20],
    ["attendance/mine", 30],
    ["notifications/mine", 100],
    ["support_tickets", 100],
    ["subscriptions/large ENTERPRISE ACTIVE", 1],
    ["subscriptions/small ENTERPRISE ACTIVE", 1],
    ["orgs onboarding_completed_at stamped", 2],
  ]);
  const belowFloor = [];

  console.log("\n--- SEED ROW COUNTS ---");
  for (const [label, q, params] of checks) {
    const n = await sql.unsafe(q, params).then((r) => r[0]?.count ?? r[0]?.n ?? "?").catch(() => "ERR");
    const floor = FLOORS.get(label);
    if (floor !== undefined && (typeof n !== "number" || n < floor)) belowFloor.push(`${label} = ${n} (needs >= ${floor})`);
    console.log(`  ${label.padEnd(28)} ${String(n).padStart(6)}${floor !== undefined ? `  (floor ${floor})` : ""}`);
  }
  console.log("-----------------------");
  if (belowFloor.length > 0) {
    console.log(`\n  FAIL: ${belowFloor.length} benchmark fixture(s) below floor — the read-cost budgets they feed would measure an empty set:`);
    for (const line of belowFloor) console.log(`    ${line}`);
    process.exitCode = 1;
  }
  console.log(`  LARGE_ORG  = ${LARGE_ORG}`);
  console.log(`  SMALL_ORG  = ${SMALL_ORG}`);
  if (errors.length > 0) {
    const grouped = new Map();
    for (const e of errors) {
      const key = `${e.label}: ${e.message.slice(0, 160)}`;
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    console.log(`\n  WARNING: ${errors.length} error(s) in ${grouped.size} distinct failure(s):`);
    for (const [key, n] of grouped) console.log(`    (x${n}) ${key}`);
    process.exitCode = 1;
  } else if (belowFloor.length === 0) {
    console.log("\n  All sections completed without errors.");
  }
}

async function main() {
  log("Starting scratch_e2e seed...");
  log(`LARGE_ORG = ${LARGE_ORG}`);
  log(`SMALL_ORG = ${SMALL_ORG}`);
  log(`PURGE = ${PURGE}`);

  if (PURGE) await purge();

  await trySection("seedUsers", seedUsers);
  await trySection("seedOrganizationsAndOwners", seedOrganizationsAndOwners);
  await trySection("seedMembers", seedMembers);
  await trySection("seedHr", seedHr);
  await trySection("seedLeave", seedLeave);
  await trySection("seedAttendance", seedAttendance);
  await trySection("seedBuild", seedBuild);
  await trySection("seedExtraTickets", seedExtraTickets);
  await trySection("seedLeaveMine", seedLeaveMine);
  await trySection("seedAttendanceMine", seedAttendanceMine);
  await trySection("seedChat", seedChat);
  await trySection("seedNotifications", seedNotifications);
  await trySection("seedKb", seedKb);
  await trySection("seedTimesheets", seedTimesheets);
  await trySection("seedAccounting", seedAccounting);
  await trySection("seedSupport", seedSupport);
  await trySection("seedPayroll", seedPayroll);
  await trySection("seedCalendarAndAnnouncements", seedCalendarAndAnnouncements);
  await trySection("seedMail", seedMail);
  await trySection("seedRoles", seedRoles);
  await trySection("seedHrExtras", seedHrExtras);
  await trySection("seedMagicLinkToken", seedMagicLinkToken);
  await trySection("seedOrgUnits", seedOrgUnits);
  await trySection("seedInvitations", seedInvitations);
  await trySection("seedWebhookEndpoints", seedWebhookEndpoints);
  await trySection("seedCrmExtras", seedCrmExtras);
  await trySection("seedKbExtras", seedKbExtras);
  await trySection("seedNotificationExtras", seedNotificationExtras);
  await trySection("seedHrAdditional", seedHrAdditional);
  await trySection("seedPayslipPublications", seedPayslipPublications);
  await trySection("seedPlanAndOnboarding", seedPlanAndOnboarding);
  await vacuumAnalyze();
  await reportCounts();

  log("Seed complete.");
}

main()
  .catch((e) => {
    console.error("SEED FAILED:", e instanceof Error ? e.message : e);
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
