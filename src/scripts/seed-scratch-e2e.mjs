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

dotenv.config({ path: resolve(process.cwd(), ".env") });

const SCRATCH_URL = process.env.SCRATCH_DATABASE_URL;
if (!SCRATCH_URL) {
  console.error(
    "SCRATCH_DATABASE_URL is required. Build it from DATABASE_URL by replacing the database name with scratch_e2e.",
  );
  process.exit(1);
}

const PURGE = process.argv.includes("--purge");
const ssl = SCRATCH_URL.includes("sslmode=disable") ? false : "require";
const sql = postgres(SCRATCH_URL, { max: 1, prepare: false, ssl, onnotice: () => {} });

const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);
const warn = (label, e) =>
  console.warn(`[${((Date.now() - started) / 1000).toFixed(1)}s] WARN ${label}: ${e?.message ?? e}`);

const LARGE_ORG = "aaaaaaaa-1111-0000-0000-000000000001";
const SMALL_ORG = "aaaaaaaa-1111-0000-0000-000000000002";

const MEMBER_COUNT = 30;
const TICKET_COUNT = 500;
const CHAT_MSG_COUNT = 300;
const HR_EMP_COUNT = 5100;
const REPORTING_LINES = 1100;
const NOTIFICATION_COUNT = 150;
const LEAVE_REQUEST_COUNT = 60;
const ATTENDANCE_COUNT = 90;
const TIMESHEET_COUNT = 200;
const KB_PAGES_COUNT = 60;
const KB_VISITS_COUNT = 50;
const SUPPORT_TICKET_COUNT = 60;
const INVOICE_COUNT = 25;
const BILL_COUNT = 25;
const JOURNAL_COUNT = 35;
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
    `INSERT INTO users (id, name, email, first_name, last_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [id, `Seed User ${n}${suffix}`, `user-${n}${suffix}@scratch-seed.test`, `Seed${suffix}`, `User ${n}`],
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
    if (existing) { log(`  org ${orgId.slice(0, 8)}... already exists`); continue; }

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

  for (const m of memberRows) {
    await sql.unsafe(
      `INSERT INTO hr_people (org_id, user_id, created_at, updated_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT DO NOTHING`,
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
       LIMIT $3
       ON CONFLICT DO NOTHING`,
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
     VALUES ($1, $2, 'Standard Policy', 'MONTHLY', 1.5, true, '2024-01-01', now())
     ON CONFLICT DO NOTHING`,
    [LARGE_ORG, leaveType],
  ).catch((e) => warn("leave_policies insert", e));

  for (let i = 0; i < Math.min(LEAVE_REQUEST_COUNT, userIds.length * 3); i++) {
    const uid = userIds[i % userIds.length];
    const yr = 2026 - Math.floor(i / 12);
    const mo = String((i % 12) + 1).padStart(2, "0");
    await sql.unsafe(
      `INSERT INTO leave_requests (org_id, user_id, leave_type_id, status, start_date, end_date, created_at, updated_at)
       VALUES ($1, $2, $3, 'APPROVED', $4::date, $5::date, now() - interval '${i} days', now())
       ON CONFLICT DO NOTHING`,
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
       VALUES ($1, $2, $3, 'accrual', 1.5, CURRENT_DATE - interval '${i * 30} days',
         to_char(CURRENT_DATE - interval '${i * 30} days', 'YYYY-MM'), 'cron', now())
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, userIds[i], leaveType],
    ).catch((e) => warn(`leave_ledger ${i}`, e));
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
         VALUES ($1, $2, $3::date, 'PRESENT', now())
         ON CONFLICT DO NOTHING`,
        [LARGE_ORG, userIds[i], dateStr],
      ).catch((e) => warn(`attendance d=${d} i=${i}`, e));
      inserted++;
    }
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

  const statusDefs = [
    ["Todo", "unstarted"],
    ["In Progress", "started"],
    ["In Review", "started"],
    ["Done", "completed"],
  ];
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
     VALUES ($1, $2, 'Sprint 1', 'ACTIVE', CURRENT_DATE - INTERVAL '7 days', CURRENT_DATE + INTERVAL '7 days', null, now(), now())
     ON CONFLICT DO NOTHING`,
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
         CASE WHEN s % 4 = 0 THEN 'Done' WHEN s % 4 = 1 THEN 'In Progress' WHEN s % 4 = 2 THEN 'In Review' ELSE 'Todo' END,
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
       VALUES ($1, $2, $3, $4, 1, 0, true, null, now(), now())
       ON CONFLICT DO NOTHING`,
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
       VALUES ($1, $2, $3, $4, 3, 'Seed User', null, null, now(), now())
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, title, fstatus, cat],
    ).catch((e) => warn("feedback_post", e));
  }
  for (const [ctitle, ctype] of [["v1.0 release", "feature"], ["Bug fixes", "fix"]]) {
    await sql.unsafe(
      `INSERT INTO build.changelog_entries (org_id, title, content, version, type, is_published, published_at, created_at, updated_at)
       VALUES ($1, $2, '', '1.0.0', $3, true, now(), now(), now())
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, ctitle, ctype],
    ).catch((e) => warn("changelog_entry", e));
  }
}

async function seedChat() {
  log("Seeding chat...");

  const memberRows = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY joined_at DESC LIMIT 10`,
    [LARGE_ORG],
  );
  const senderMemberId = memberRows[0]?.id;
  const senderUserId = memberRows[0]?.user_id ?? ownerId;

  const chanId = await sql.unsafe(
    `INSERT INTO chat_channels (org_id, name, type, is_private, is_archived, last_message_at, created_at, updated_at)
     VALUES ($1, 'general', 'PUBLIC', false, false, now(), now(), now())
     ON CONFLICT DO NOTHING RETURNING id`,
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
       VALUES ($1, $2, 'PUBLIC', false, false, now(), now(), now())
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, `channel-${i}`],
    ).catch(() => {});
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

  const msgRows = await sql.unsafe(
    `SELECT id FROM chat_messages WHERE org_id = $1 AND channel_id = $2 AND is_deleted = false LIMIT 5`,
    [LARGE_ORG, channelId],
  );
  for (const msg of msgRows) {
    await sql.unsafe(
      `INSERT INTO chat_saved_messages (org_id, user_id, membership_id, message_id, saved_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, senderUserId, senderMemberId, msg.id],
    ).catch((e) => warn("saved_message", e));
  }
}

async function seedNotifications() {
  log("Seeding notifications...");
  const userRow = await sql.unsafe(
    `SELECT user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]?.user_id);
  if (!userRow) { log("  no members — skipping notifications"); return; }

  const existingN = await sql.unsafe(
    `SELECT count(*)::int n FROM notifications WHERE org_id = $1 AND deleted_at IS NULL`,
    [LARGE_ORG],
  ).then((r) => r[0].n);

  if (existingN < NOTIFICATION_COUNT) {
    const from = existingN + 1;
    log(`  inserting ${NOTIFICATION_COUNT - existingN} notifications...`);
    await sql.unsafe(
      `INSERT INTO notifications (org_id, user_id, type, title, message, is_read, category, source_module, created_at, updated_at, deleted_at, archived_at)
       SELECT $1, $2,
         CASE WHEN s % 4 = 0 THEN 'WARNING' WHEN s % 4 = 1 THEN 'SUCCESS' WHEN s % 4 = 2 THEN 'ERROR' ELSE 'INFO' END::notification_type,
         'Notification ' || s, 'Body ' || s,
         s % 4 = 0, 'SYSTEM', 'system',
         now() - (s || ' minutes')::interval, now(), null, null
       FROM generate_series(${from}, ${NOTIFICATION_COUNT}) s`,
      [LARGE_ORG, userRow],
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

  const spaceId = await sql.unsafe(
    `SELECT id FROM kb_spaces WHERE org_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]?.id);

  if (!spaceId) { log("  no KB space — skipping pages"); return; }

  const memRow = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]);
  const creatorId = memRow?.user_id ?? ownerId;
  const membershipId = memRow?.id;

  const existingPages = await sql.unsafe(
    `SELECT count(*)::int n FROM kb_pages WHERE org_id = $1 AND deleted_at IS NULL`,
    [LARGE_ORG],
  ).then((r) => r[0].n);

  if (existingPages < KB_PAGES_COUNT) {
    const from = existingPages + 1;
    log(`  inserting ${KB_PAGES_COUNT - existingPages} kb_pages...`);
    await sql.unsafe(
      `INSERT INTO kb_pages (org_id, space_id, title, content, status, visibility, sort_order, created_by_id, created_by_membership_id, last_edited_by_id, last_edited_by_membership_id, deleted_at, created_at, updated_at)
       SELECT $1, $2::int, 'Page ' || s, '{}'::jsonb, 'published', 'org', s, $3, $4::int, $3, $4::int, null,
         now() - (s || ' hours')::interval, now() - (s || ' minutes')::interval
       FROM generate_series(${from}, ${KB_PAGES_COUNT}) s`,
      [LARGE_ORG, spaceId, creatorId, membershipId],
    ).catch((e) => warn("kb_pages batch", e));
  }

  await sql.unsafe(
    `INSERT INTO kb_page_visits (org_id, user_id, membership_id, page_id, visited_at)
     SELECT $1, $2, $3, p.id, now() - (row_number() OVER () || ' hours')::interval
     FROM kb_pages p
     WHERE p.org_id = $1 AND p.deleted_at IS NULL
     LIMIT $4
     ON CONFLICT DO NOTHING`,
    [LARGE_ORG, creatorId, membershipId, KB_VISITS_COUNT],
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
       VALUES ($1, $2, 'ACTIVE', now() - interval '${i} days', now())
       ON CONFLICT DO NOTHING`,
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
       VALUES ($1, $2, $3, $4, ${i * 100000}, 'INR', $5, now() - interval '${i} days', now())
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, clientId, `INV-${String(i).padStart(4, "0")}`, i % 2 === 0 ? "SENT" : "DRAFT", invoiceAuthorId],
    ).catch((e) => warn(`invoice ${i}`, e));
  }

  for (let i = 1; i <= BILL_COUNT; i++) {
    await sql.unsafe(
      `INSERT INTO purchase_bills (org_id, bill_number, status, subtotal, tax_amount, cgst_amount, sgst_amount, igst_amount, discount, total, amount_paid, currency, exchange_rate, reverse_charge, bill_date, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, ${i * 50000}, 0, 0, 0, 0, 0, ${i * 50000}, 0, 'INR', 1, false, CURRENT_DATE - interval '${i} days', $4, now() - interval '${i} days', now())
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, `BILL-${String(i).padStart(4, "0")}`, i % 2 === 0 ? "PENDING" : "DRAFT", invoiceAuthorId],
    ).catch((e) => warn(`bill ${i}`, e));
  }

  const existingPeriod = await sql.unsafe(
    `SELECT id FROM accounting_periods WHERE org_id = $1 LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]?.id).catch(() => null);

  const periodId = existingPeriod ?? await sql.unsafe(
    `INSERT INTO accounting_periods (org_id, name, start_date, end_date, status, created_at, updated_at)
     VALUES ($1, 'FY 2026 Q1', '2026-01-01', '2026-03-31', 'OPEN', now(), now())
     ON CONFLICT DO NOTHING RETURNING id`,
    [LARGE_ORG],
  ).then((r) => r[0]?.id).catch(() => null);

  const existingBook = await sql.unsafe(
    `SELECT id FROM accounting_books WHERE org_id = $1 LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]?.id).catch(() => null);

  const bookId = existingBook ?? await sql.unsafe(
    `INSERT INTO accounting_books (org_id, name, currency, created_at, updated_at)
     VALUES ($1, 'Main Ledger', 'INR', now(), now())
     ON CONFLICT DO NOTHING RETURNING id`,
    [LARGE_ORG],
  ).then((r) => r[0]?.id).catch(() => null);

  if (bookId && periodId) {
    const existingJournals = await sql.unsafe(
      `SELECT count(*)::int n FROM gl_journals WHERE org_id = $1`,
      [LARGE_ORG],
    ).then((r) => r[0].n);

    if (existingJournals < JOURNAL_COUNT) {
      for (let i = existingJournals + 1; i <= JOURNAL_COUNT; i++) {
        await sql.unsafe(
          `INSERT INTO gl_journals (org_id, book_id, period_id, journal_number, journal_date, memo, source_type)
           VALUES ($1, $2, $3, $4, CURRENT_DATE - interval '${i} days', 'Seed journal', 'MANUAL')
           ON CONFLICT DO NOTHING`,
          [LARGE_ORG, bookId, periodId, `JNL-${String(i).padStart(4, "0")}`],
        ).catch((e) => warn(`journal ${i}`, e));
      }
    }
  } else {
    log("  no accounting book or period — gl_journals skipped");
  }

  const authorId = await sql.unsafe(
    `SELECT user_id FROM organization_members WHERE org_id = $1 LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]?.user_id).catch(() => null);

  await sql.unsafe(
    `INSERT INTO acc_tax_payments (org_id, tax_type, period_start, period_end, amount, paid_date, reference, created_by, created_at)
     VALUES ($1, 'GST', '2026-01-01', '2026-03-31', 50000, '2026-04-15', 'TAX-2026-Q1', $2, now())
     ON CONFLICT DO NOTHING`,
    [LARGE_ORG, authorId],
  ).catch((e) => warn("acc_tax_payments", e));

  await sql.unsafe(
    `INSERT INTO fin_reminder_policies (org_id, name, offsets, channel, template, is_active, created_at, updated_at)
     VALUES ($1, 'Default AR Reminder', '[7, 14, 30]'::jsonb, 'EMAIL', 'default', true, now(), now())
     ON CONFLICT DO NOTHING`,
    [LARGE_ORG],
  ).catch((e) => warn("fin_reminder_policies", e));
}

async function seedSupport() {
  log("Seeding support tickets...");
  const memberRows = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' LIMIT 3`,
    [LARGE_ORG],
  );
  const assigneeMembershipId = memberRows[0]?.id ?? null;
  const creatorMembershipId = memberRows[0]?.id;

  if (!creatorMembershipId) { log("  no members — skipping support tickets"); return; }

  const existingST = await sql.unsafe(
    `SELECT count(*)::int n FROM support_tickets WHERE org_id = $1`,
    [LARGE_ORG],
  ).then((r) => r[0].n);

  if (existingST < SUPPORT_TICKET_COUNT) {
    const from = existingST + 1;
    log(`  inserting ${SUPPORT_TICKET_COUNT - existingST} support tickets...`);
    await sql.unsafe(
      `INSERT INTO support_tickets (org_id, title, status, priority, assignee_membership_id, source_channel, created_by_membership_id, sla_paused_minutes, sla_escalation_level, created_at, updated_at)
       SELECT $1, 'Support Ticket ' || s,
         (CASE WHEN s % 3 = 0 THEN 'OPEN' WHEN s % 3 = 1 THEN 'IN_PROGRESS' ELSE 'WAITING' END)::support_ticket_status,
         (CASE WHEN s % 4 = 0 THEN 'URGENT' WHEN s % 4 = 1 THEN 'HIGH' WHEN s % 4 = 2 THEN 'MEDIUM' ELSE 'LOW' END)::support_ticket_priority,
         $2::int, 'web'::support_source_channel, $3::int, 0, 0, now() - (s || ' hours')::interval, now()
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
            `INSERT INTO payroll_line_items (org_id, run_id, run_employee_id, code, name, category, calc_method, amount, sort_order, created_at)
             VALUES ($1, $2, $3, 'BASIC', 'Basic Salary', 'EARNING', 'FIXED', 500000, 1, now())
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
       VALUES ($1, 'Seed Event', now() + interval '1 day', now() + interval '2 days', 'MEETING', 'org', $2, now(), now())
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, creatorMembershipId],
    ).catch((e) => warn("calendar_event", e));
  }

  await sql.unsafe(
    `INSERT INTO announcements (org_id, title, content, author_id, status, is_pinned, expires_at, created_at, updated_at)
     VALUES ($1, 'Welcome to scratch E2E!', 'Seed announcement for budget testing.', $2, 'PUBLISHED', false, null, now(), now())
     ON CONFLICT DO NOTHING`,
    [LARGE_ORG, authorId],
  ).catch((e) => warn("announcement", e));
}

async function seedMail() {
  log("Seeding mail metadata...");
  const memRow = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' LIMIT 1`,
    [LARGE_ORG],
  ).then((r) => r[0]);
  if (!memRow) return;

  const existingAcc = await sql.unsafe(
    `SELECT id FROM mail_accounts WHERE org_id = $1 AND user_id = $2 LIMIT 1`,
    [LARGE_ORG, memRow.user_id],
  ).then((r) => r[0]?.id).catch(() => null);

  const newAcc = existingAcc ?? await sql.unsafe(
    `INSERT INTO mail_accounts (org_id, user_id, provider, email, status, created_at, updated_at)
     VALUES ($1, $2, 'GMAIL', 'seed@scratch-seed.test', 'ACTIVE', now(), now())
     ON CONFLICT DO NOTHING RETURNING id`,
    [LARGE_ORG, memRow.user_id],
  ).then((r) => r[0]?.id).catch(() => null);

  if (!newAcc) { log("  no mail account — skipping mail data"); return; }

  for (let i = 1; i <= 15; i++) {
    await sql.unsafe(
      `INSERT INTO mail_message_metadata (org_id, account_id, user_id, message_id, thread_id, subject, sender_email, sender_name, date, is_read, is_starred, has_attachment, labels, folder, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '${i} hours', false, false, false, '{}', 'inbox', now())
       ON CONFLICT DO NOTHING`,
      [LARGE_ORG, newAcc, memRow.user_id,
        `msg-scratch-${i}-${LARGE_ORG.slice(0, 8)}`,
        `thread-${Math.ceil(i / 3)}`,
        `Subject ${i}`, `sender${i}@example.com`, `Sender ${i}`,
      ],
    ).catch((e) => warn(`mail_message ${i}`, e));
  }
}

async function seedRoles() {
  log("Seeding roles...");
  await sql.unsafe(
    `INSERT INTO roles (org_id, name, slug, module_key, is_system, created_at, updated_at)
     VALUES ($1, 'HR Admin', 'HR_ADMIN', 'hr', true, now(), now())
     ON CONFLICT DO NOTHING`,
    [LARGE_ORG],
  ).catch((e) => warn("roles", e));
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
    "tickets", "ticket_assignees", "projects", "sprints", "project_members",
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
    ["leave_requests", `SELECT count(*)::int FROM leave_requests WHERE org_id = $1`, [LARGE_ORG]],
    ["leave_balances", `SELECT count(*)::int FROM leave_balances WHERE org_id = $1`, [LARGE_ORG]],
    ["hr_leave_ledger", `SELECT count(*)::int FROM hr_leave_ledger WHERE org_id = $1`, [LARGE_ORG]],
    ["attendance", `SELECT count(*)::int FROM attendance WHERE org_id = $1`, [LARGE_ORG]],
    ["timesheets", `SELECT count(*)::int FROM timesheets WHERE org_id = $1`, [LARGE_ORG]],
    ["payroll_runs", `SELECT count(*)::int FROM payroll_runs WHERE org_id = $1`, [LARGE_ORG]],
    ["support_tickets", `SELECT count(*)::int FROM support_tickets WHERE org_id = $1`, [LARGE_ORG]],
    ["clients", `SELECT count(*)::int FROM clients WHERE org_id = $1`, [LARGE_ORG]],
    ["invoices", `SELECT count(*)::int FROM invoices WHERE org_id = $1`, [LARGE_ORG]],
    ["purchase_bills", `SELECT count(*)::int FROM purchase_bills WHERE org_id = $1`, [LARGE_ORG]],
    ["gl_journals", `SELECT count(*)::int FROM gl_journals WHERE org_id = $1`, [LARGE_ORG]],
  ];

  console.log("\n--- SEED ROW COUNTS ---");
  for (const [label, q, params] of checks) {
    const n = await sql.unsafe(q, params).then((r) => r[0]?.count ?? r[0]?.n ?? "?").catch(() => "ERR");
    console.log(`  ${label.padEnd(28)} ${String(n).padStart(6)}`);
  }
  console.log("-----------------------");
  console.log(`  LARGE_ORG  = ${LARGE_ORG}`);
  console.log(`  SMALL_ORG  = ${SMALL_ORG}`);
  if (errors.length > 0) {
    console.log(`\n  WARNING: ${errors.length} section(s) had errors:`);
    for (const e of errors) console.log(`    [${e.label}] ${e.message.slice(0, 120)}`);
  } else {
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
