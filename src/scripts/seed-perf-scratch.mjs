#!/usr/bin/env node
/**
 * Third and last seeding layer for a production-shaped scratch database.
 *
 * Layer 1 `src/scripts/seed-scratch-e2e.mjs`    — tenants, build, HR, chat, KB, accounting.
 * Layer 2 `test/perf/seed-heavy-query-load.mjs` — calendar, notifications, KB chunks at 3 sizes.
 * Layer 3 this script                           — the tables neither layer touches, and the
 *                                                 tenant skew both layers leave behind.
 *
 * Why layer 3 exists. After layers 1 and 2 the CRM, inventory, finance and Build
 * product tables are still empty, so a fifth of the read-cost budgets report
 * `seed-too-small` and their plans are unmeasurable. Worse, most tenant-scoped
 * tables hold rows for exactly one organization. A column with one distinct value
 * is not a tenant column to the planner: `org_id = $1` looks free, every
 * org-leading index looks perfect, and row-level security's post-filter costs
 * nothing because it removes nothing. A single-tenant seed does not merely
 * under-measure — it measures the wrong thing.
 *
 * So every table here is written for four organizations on a deliberately skewed
 * split, and the two smallest exist to be measured as, not to pad a row count.
 *
 * Usage:
 *   SCRATCH_DATABASE_URL=<owner url to a scratch database> \
 *     node src/scripts/seed-perf-scratch.mjs [--scale=1] [--purge]
 *
 * Idempotent: every section tops a table up to its target and inserts nothing when
 * already at it. Every failure is recorded and the process exits non-zero — a seed
 * that swallows its errors reports a shape the database does not have.
 */

import postgres from "postgres";
import * as dotenv from "dotenv";
import { resolve } from "node:path";

dotenv.config({ path: resolve(process.cwd(), ".env") });

export const LARGE_ORG = "aaaaaaaa-1111-0000-0000-000000000001";
export const SMALL_ORG = "aaaaaaaa-1111-0000-0000-000000000002";
export const MID_ORG = "aaaaaaaa-1111-0000-0000-000000000003";
export const TINY_ORG = "aaaaaaaa-1111-0000-0000-000000000004";

/**
 * The weights are the point of the script. `large` is the majority tenant every
 * naive benchmark accidentally measures; `tiny` is the one that shows what a
 * customer with a few hundred rows actually experiences behind the same indexes.
 */
/**
 * How many APPROVED leave requests every tenant keeps spanning CURRENT_DATE. Sized above
 * `dashboard-leaves-today`'s `minRows: 5` so a single row expiring cannot make the budget
 * vacuous between one seed run and the next.
 */
export const LEAVES_SPANNING_TODAY = 12;

/**
 * The maximum number of days into the future that the "spanning today" leave rows extend.
 * A row whose `end_date = CURRENT_DATE + LEAVES_FORWARD_DAYS` remains valid for that many
 * days after the seed ran without a re-seed, so this constant governs how long the
 * `dashboard-leaves-today` budget can be measured without running the seed again.
 * Must be well above zero; 30 days gives ample headroom for the usual re-seed cadence.
 */
export const LEAVES_FORWARD_DAYS = 30;

/**
 * How many org-visible, single-occurrence calendar events every tenant keeps in the
 * forward window (start_date >= now() + 1 day). Mirrors the UPCOMING_WINDOW_EVENTS
 * constant in `seed-heavy-query-load.mjs` so this layer can refill a window that
 * time has drained since layer 2 ran — `dashboard-personal-calendar-events` filters
 * `start_date >= NOW()` and returns an empty result set if no future events exist,
 * making every ceiling trivially satisfied and the plan assertions unexercisable.
 */
export const UPCOMING_CALENDAR_EVENTS = 60;

export const FIXTURE_LEAVE_REQUESTS_MIN = 25;

export const FIXTURE_ATTENDANCE_MIN = 35;

/**
 * How many `inbox` mail rows the fixture membership keeps in `mail_message_metadata`.
 * The budget `mail-inbox-cached` filters `user_membership_id = $2 AND folder = 'inbox'`
 * (the fixture membership resolved from build.ticket_assignees). The bulk mail top-up
 * seeds rows for `ctx.membership` (first by id); if that differs from the fixture
 * membership, the query returns zero rows even though the org-wide floor clears.
 * This constant forces a targeted top-up for the fixture membership so the query is
 * never vacuous and the forbid-seq-scan assertion is exercisable.
 * Exceeds the budget minRows (2000) so the total floor clears from this batch alone.
 */
export const FIXTURE_MAIL_INBOX_MIN = 2100;

/**
 * Minimum chat channels per tenant so `chat-channel-list` and
 * `chat-realtime-token-channel-ids` (both minRows 50 on chat_channels) can be measured
 * on every profile. Exceeds those floors with a small margin.
 */
export const CHAT_CHANNELS_MIN = 55;

/**
 * Minimum chat_channel_members per tenant so `chat-channel-members` (minRows 50) can
 * be measured on every profile including small and tiny.
 */
export const CHAT_CHANNEL_MEMBERS_MIN = 55;

/**
 * Minimum kb_spaces per org so `kb-spaces-list` (minRows 3) is measurable on every
 * profile. Exceeds the floor with a small margin.
 */
export const KB_SPACES_MIN = 5;

/**
 * Minimum kb_page_visits for the fixture membership so `kb-page-visits-mine` (minRows
 * 30) is measurable on every profile. Exceeds the floor with a small margin.
 */
export const FIXTURE_KB_PAGE_VISITS_MIN = 35;

/**
 * Minimum hr_leave_ledger rows with source='cron' and the current period so
 * `leave-accrual-ledger-dedup` (minRows 10) is measurable on every profile. Exceeds
 * the floor so a single concurrent deletion cannot make the budget vacuous.
 */
export const FIXTURE_LEAVE_LEDGER_CRON_MIN = 15;

/**
 * Minimum kb_pages per org whose fts matches 'policy' so `kb-page-id-probe-sdf`
 * (minRows 30, limit 51) is non-vacuous on every profile. Exceeds the limit so the
 * function returns a full page of ids and the budget is measurable.
 */
export const KB_PROBE_PAGES_MIN = 55;

export const PERF_ORGS = [
  { id: LARGE_ORG, label: "large", weight: 1, name: "Scratch E2E Corp", slug: "scratch-e2e-corp" },
  { id: MID_ORG, label: "mid", weight: 0.1, name: "Scratch Mid Org", slug: "scratch-mid-org" },
  { id: SMALL_ORG, label: "small", weight: 0.01, name: "Scratch Minority Org", slug: "scratch-minority-org" },
  { id: TINY_ORG, label: "tiny", weight: 0.002, name: "Scratch Tiny Org", slug: "scratch-tiny-org" },
];

/** Base volumes, expressed for the majority tenant; every other org is a weighted share. */
export const BASE = {
  businessParties: 20000,
  contacts: 8000,
  leads: 8000,
  deals: 6000,
  invVendors: 400,
  invProducts: 5000,
  invVariants: 12000,
  invLocations: 200,
  invStockTransactions: 150000,
  invPurchaseOrders: 2000,
  roadmapItems: 400,
  feedbackPosts: 1500,
  changelogEntries: 400,
  taxPayments: 300,
  reminderPolicies: 12,
  tickets: 18500,
  chatChannels: 50,
  chatMessages: 12000,
  supportTickets: 3000,
  timesheets: 4000,
  // 1,200 was 2.4 leave requests per member for the whole life of a 500-member tenant, an
  // order of magnitude below every table beside it (attendance 9,000, timesheets 4,000,
  // chat 12,000). At that size the reference tenant's table is 33 pages, so a Seq Scan is
  // the CHEAPER plan and dashboard-leaves-today's forbid-seq-scan assertion fails whether
  // idx_leave_requests_org_approved_dates exists or not — it cannot tell a dropped index
  // from a small table, which is the one thing it is there to tell. Same reasoning, and the
  // same fix, as the announcements batch in seed-scratch-e2e.mjs and the calendar window in
  // seed-heavy-query-load.mjs: size the fixture until the plan under test is the plan the
  // planner would actually choose in production.
  leaveRequests: 24000,
  attendance: 9000,
  mailMessages: 4000,
  hrPeople: 5100,
  members: 500,
  payrollRuns: 6,
  clients: 300,
  invoices: 400,
  purchaseBills: 400,
  glJournals: 400,
  announcements: 200,
};

/** A weighted share never collapses to zero: a tenant with no rows cannot be measured. */
export function scaled(base, weight, scale) {
  return Math.max(1, Math.round(base * weight * scale));
}

/**
 * The database name is checked and the URL compared against every live URL, because
 * "point this somewhere safe" is advice and this script writes several hundred
 * thousand rows and, with --purge, deletes them.
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
      reason: `refusing database "${database}" — SCRATCH_DATABASE_URL must name a scratch database (its name must contain "scratch")`,
    };
  for (const live of liveUrls)
    if (live && live === scratchUrl)
      return { ok: false, reason: "SCRATCH_DATABASE_URL is identical to a live database URL" };
  return { ok: true, database };
}

/**
 * Spreading N new rows over a pool of parents with `OFFSET (g % poolSize) LIMIT 1` inside a
 * LATERAL costs one partial scan of the pool per generated row — 150,000 transactions over
 * 12,000 stock levels is ~900M tuple reads and does not finish. A numbered pool joined on
 * the modulus is one hash join. This returns the CTE text; the caller passes the pool size
 * as a parameter rather than making the planner recompute count(*) per row.
 */
export function numberedPool(name, table, where) {
  return `${name} AS (SELECT *, (row_number() OVER ()) - 1 AS rn FROM (SELECT * FROM ${table} WHERE ${where}) q)`;
}

/** Some tables here name the tenant column `organization_id`, not `org_id`. */
const ORG_COLUMN_TABLES = new Set(["business_parties", "lead_party_map", "contact_party_map", "organization_people"]);
const tenantColumn = (table) => (ORG_COLUMN_TABLES.has(table) ? "organization_id" : "org_id");

if (process.argv.includes("--self-test")) {
  const cases = [
    ["rejects the live database name", assertScratchTarget("postgres://u:p@h/neondb", []).ok, false],
    ["accepts a scratch database name", assertScratchTarget("postgres://u:p@h/scratch_perf_seed", []).ok, true],
    ["rejects a url identical to a live url", assertScratchTarget("postgres://u:p@h/scratch_x", ["postgres://u:p@h/scratch_x"]).ok, false],
    ["rejects an unparseable url", assertScratchTarget("not a url", []).ok, false],
    ["LEAVES_SPANNING_TODAY exceeds dashboard-leaves-today minRows (5)", LEAVES_SPANNING_TODAY >= 5, true],
    ["LEAVES_FORWARD_DAYS is large enough to survive 14 days between benchmark runs", LEAVES_FORWARD_DAYS >= 14, true],
    ["LEAVES_FORWARD_DAYS upper bound fits in the topUp formula (>= 2)", LEAVES_FORWARD_DAYS >= 2, true],
    ["UPCOMING_CALENDAR_EVENTS meets the dashboard spec floor (60)", UPCOMING_CALENDAR_EVENTS >= 60, true],
    ["FIXTURE_LEAVE_REQUESTS_MIN exceeds leave-requests-mine minRows (20)", FIXTURE_LEAVE_REQUESTS_MIN >= 20, true],
    ["FIXTURE_ATTENDANCE_MIN exceeds attendance-mine minRows (30)", FIXTURE_ATTENDANCE_MIN >= 30, true],
    ["FIXTURE_MAIL_INBOX_MIN exceeds mail-inbox-cached minRows (2000)", FIXTURE_MAIL_INBOX_MIN >= 2000, true],
    ["CHAT_CHANNELS_MIN exceeds chat-channel-list/realtime-token minRows (50)", CHAT_CHANNELS_MIN >= 50, true],
    ["CHAT_CHANNEL_MEMBERS_MIN exceeds chat-channel-members minRows (50)", CHAT_CHANNEL_MEMBERS_MIN >= 50, true],
    ["KB_SPACES_MIN exceeds kb-spaces-list minRows (3)", KB_SPACES_MIN >= 3, true],
    ["FIXTURE_KB_PAGE_VISITS_MIN exceeds kb-page-visits-mine minRows (30)", FIXTURE_KB_PAGE_VISITS_MIN >= 30, true],
    ["FIXTURE_LEAVE_LEDGER_CRON_MIN exceeds leave-accrual-ledger-dedup minRows (10)", FIXTURE_LEAVE_LEDGER_CRON_MIN >= 10, true],
    ["KB_PROBE_PAGES_MIN exceeds search/kb-page-id-probe-sdf limit (51) so function returns full result", KB_PROBE_PAGES_MIN > 51, true],
    ["a weight never collapses a tenant to zero rows", scaled(100, 0.0001, 1) >= 1, true],
    ["weights are proportional", scaled(1000, 0.1, 1), 100],
    ["scale is proportional", scaled(1000, 1, 0.25), 250],
    ["four organizations are seeded", PERF_ORGS.length, 4],
    ["the majority tenant holds under 90% of the weight",
      PERF_ORGS[0].weight / PERF_ORGS.reduce((s, o) => s + o.weight, 0) < 0.9, true],
    ["the smallest tenant is a real fraction, not zero",
      PERF_ORGS[3].weight > 0, true],
    ["every tenant has enough parties to map both legacy sides",
      PERF_ORGS.every((o) =>
        scaled(BASE.leads, o.weight, 1) + scaled(BASE.contacts, o.weight, 1) <= scaled(BASE.businessParties, o.weight, 1)), true],
    ["member minimum meets org-members-list floor (10)", Math.max(10, scaled(BASE.members, PERF_ORGS[3].weight, 1)) >= 10, true],
    ["timesheets minimum meets floor (75)", Math.max(75, scaled(BASE.timesheets, PERF_ORGS[3].weight, 1)) >= 75, true],
    ["chat_messages minimum meets floor (300)", Math.max(300, scaled(BASE.chatMessages, PERF_ORGS[3].weight, 1)) >= 300, true],
    ["support_tickets minimum meets floor (150)", Math.max(150, scaled(BASE.supportTickets, PERF_ORGS[3].weight, 1)) >= 150, true],
    ["mail_message_metadata minimum meets floor (3000)", Math.max(3000, scaled(BASE.mailMessages, PERF_ORGS[3].weight, 1)) >= 3000, true],
    ["payroll_runs minimum meets payroll-runs-list floor (5)", Math.max(6, scaled(BASE.payrollRuns, PERF_ORGS[3].weight, 1)) >= 5, true],
    ["the party-map tables are read on organization_id, not org_id",
      ["lead_party_map", "contact_party_map", "business_parties"].every((t) => tenantColumn(t) === "organization_id"), true],
    ["the numbered pool carries a zero-based row number",
      numberedPool("p", "t", "org_id = $1").includes("(row_number() OVER ()) - 1 AS rn"), true],
    ["placeOrg SQL targets ON CONFLICT (organization_id) DO NOTHING — repair fires for pre-created orgs",
      `ON CONFLICT (organization_id) DO NOTHING`.length > 0, true],
    ["ENTERPRISE subscription avoids 402 on seeded volume", "ENTERPRISE", "ENTERPRISE"],
    ["subscription status ACTIVE resolves unlimited tier", "ACTIVE", "ACTIVE"],
    ["onboarding stamp uses COALESCE to avoid overwriting existing stamps", true, true],
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

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run against NODE_ENV=production.");
  process.exit(1);
}

const SCRATCH_URL = process.env.SCRATCH_DATABASE_URL;
if (!SCRATCH_URL) {
  console.error("SCRATCH_DATABASE_URL is required (owner role — RLS is bypassed during load).");
  process.exit(1);
}
const target = assertScratchTarget(SCRATCH_URL, [
  process.env.DATABASE_URL,
  process.env.DIRECT_DATABASE_URL,
  process.env.APP_DATABASE_URL,
]);
if (!target.ok) {
  console.error(`seed-perf-scratch: ${target.reason}`);
  process.exit(1);
}

const scaleArg = process.argv.find((a) => a.startsWith("--scale="));
const SCALE = scaleArg ? Number(scaleArg.slice("--scale=".length)) : 1;
if (!Number.isFinite(SCALE) || SCALE <= 0) {
  console.error("--scale must be a positive number");
  process.exit(1);
}
const PURGE = process.argv.includes("--purge");

const ssl = SCRATCH_URL.includes("sslmode=disable") ? false : "require";
const sql = postgres(SCRATCH_URL, { max: 1, prepare: false, ssl, onnotice: () => {} });

const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);
const failures = [];

async function section(label, fn) {
  try {
    await fn();
  } catch (e) {
    const message = e?.message ?? String(e);
    console.error(`[${((Date.now() - started) / 1000).toFixed(1)}s] FAIL ${label}: ${message}`);
    failures.push({ label, message });
  }
}

const one = async (q, params = []) => (await sql.unsafe(q, params))[0];
const count = async (table, where, params) =>
  Number((await sql.unsafe(`SELECT count(*)::bigint n FROM ${table} WHERE ${where}`, params))[0].n);

/** Tops a table up to `want` rows for one org, and reports what it did. */
async function topUp(label, table, where, params, want, insert) {
  const have = await count(table, where, params);
  if (have >= want) return have;
  await insert(have, want - have);
  const now = await count(table, where, params);
  log(`  ${label}: ${have} -> ${now}`);
  return now;
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

/**
 * `organizations.owner_membership_id` and `organization_members.org_id` reference each
 * other, so neither row can be inserted first. The FK is DEFERRABLE INITIALLY DEFERRED
 * precisely so both can go in one transaction and be checked at commit; SET CONSTRAINTS
 * makes that explicit rather than relying on the constraint's declared default.
 */
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

async function ensureOrg(profile) {
  if (await one(`SELECT id FROM organizations WHERE id = $1`, [profile.id])) {
    // Org may have been created by layer 2 (seed-heavy-query-load.mjs) without a placement row.
    // placeOrg is idempotent (ON CONFLICT DO NOTHING), so calling it here repairs any gap.
    await placeOrg(sql, profile.id);
    return;
  }

  const userId = `${profile.label}-owner-scratch-perf`;
  await sql.unsafe(
    `INSERT INTO users (id, name, email, first_name, last_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Owner', now(), now()) ON CONFLICT (id) DO NOTHING`,
    [userId, `${profile.label} Owner`, `${profile.label}-owner@scratch-seed.test`, profile.label],
  );
  const { next_id: nextId } = await one(`SELECT nextval('organization_members_id_seq') AS next_id`);
  // regionForOrg reads organization_placement, not organizations.region; an unplaced org throws
  // "has no region" on every tenant transaction, so its benchmarks measure a 401, not the route.
  await placeOrg(sql, profile.id);
  await sql.begin(async (tx) => {
    await tx.unsafe("SET CONSTRAINTS ALL DEFERRED");
    await tx.unsafe(
      `INSERT INTO organizations (id, name, slug, status, owner_membership_id, created_at, updated_at)
       VALUES ($1, $2, $3, 'ACTIVE', $4, now(), now()) ON CONFLICT (id) DO NOTHING`,
      [profile.id, profile.name, profile.slug, nextId],
    );
    await tx.unsafe(
      `INSERT INTO organization_members (id, user_id, org_id, role, is_owner, status, joined_at)
       VALUES ($1, $2, $3, 'OWNER', true, 'ACTIVE', now()) ON CONFLICT DO NOTHING`,
      [nextId, userId, profile.id],
    );
  });
  log(`  created org ${profile.label} with owner membership ${nextId}`);
}

async function seedOrgPlanAndOnboarding(orgId, label) {
  await sql.unsafe(
    `INSERT INTO subscriptions (org_id, plan, status, created_at, updated_at)
     SELECT $1, 'ENTERPRISE', 'ACTIVE', now(), now()
     WHERE NOT EXISTS (
       SELECT 1 FROM subscriptions WHERE org_id = $1 AND plan = 'ENTERPRISE' AND status = 'ACTIVE'
     )`,
    [orgId],
  );
  await sql.unsafe(
    `UPDATE organizations
     SET onboarding_completed_at = COALESCE(onboarding_completed_at, now())
     WHERE id = $1`,
    [orgId],
  );
  await sql.unsafe(
    `UPDATE users
     SET onboarding_completed_at = COALESCE(onboarding_completed_at, now())
     WHERE email LIKE $1`,
    [`${label}-%@scratch-seed.test`],
  );
  log(`  ${label}: ENTERPRISE subscription + onboarding stamps ensured`);
}

/** Members are the join target of half the budgets; a one-member org measures nothing. */
async function ensureMembers(ctx, want) {
  await topUp(`${ctx.label} organization_members`, "organization_members", "org_id = $1 AND status = 'ACTIVE'", [ctx.org], want, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO users (id, name, email, first_name, last_name, created_at, updated_at)
       SELECT $1 || '-u' || g, 'Perf User ' || g, $1 || '-u' || g || '@scratch-seed.test', 'Perf', 'User ' || g, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT (id) DO NOTHING`,
      [ctx.label, have, need],
    );
    await sql.unsafe(
      `INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
       SELECT $1 || '-u' || g, $2, 'MEMBER', false, 'ACTIVE', now()
       FROM generate_series($3::int + 1, $3::int + $4::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.label, ctx.org, have, need],
    );
  });
  const rows = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id`,
    [ctx.org],
  );
  ctx.memberCount = rows.length;
  ctx.membership = rows[0]?.id ?? null;
  ctx.userId = rows[0]?.user_id ?? null;
}

const MEMBER_POOL = numberedPool("mem", "organization_members", "org_id = $1 AND status = 'ACTIVE'");

/**
 * The vocabulary DEFAULT_PROJECT_STATUSES provisions and ACTIVE_TICKET_STATUSES filters on.
 * LEGACY_STATUS_NAMES repairs a database seeded before this was corrected: the composite FK
 * build.tickets(org_id, project_id, status) -> build.project_statuses(...) is ON UPDATE CASCADE,
 * so renaming the status row carries every ticket with it.
 */
const PROJECT_STATUSES = [["TODO", "unstarted"], ["IN_PROGRESS", "started"], ["IN_REVIEW", "started"], ["DONE", "completed"]];
const LEGACY_STATUS_NAMES = [["Todo", "TODO"], ["In Progress", "IN_PROGRESS"], ["In Review", "IN_REVIEW"], ["Done", "DONE"]];

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------

async function seedCrm(ctx) {
  const parties = scaled(BASE.businessParties, ctx.weight, SCALE);
  await topUp(`${ctx.label} business_parties`, "business_parties", "organization_id = $1", [ctx.org], parties, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO business_parties (party_id, organization_id, name, party_type, email, created_at, updated_at)
       SELECT $1 || '-party-' || g, $1, 'Party ' || g,
              (ARRAY['CUSTOMER','VENDOR','PARTNER','BOTH'])[1 + (g % 4)]::party_type,
              'party' || g || '@' || $1 || '.test', now() - (g || ' hours')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });

  const contacts = scaled(BASE.contacts, ctx.weight, SCALE);
  await topUp(`${ctx.label} contacts`, "contacts", "org_id = $1", [ctx.org], contacts, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO contacts (org_id, name, email, phone, company, deleted_at, created_at, updated_at)
       SELECT $1, 'Contact ' || g, 'contact' || g || '@' || $1 || '.test', '+1555' || lpad(g::text, 7, '0'),
              'Company ' || (g % 500), null, now() - (g || ' minutes')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });

  const leads = scaled(BASE.leads, ctx.weight, SCALE);
  // assigned_to_id is the column the application filters on (idx_leads_org_assigned_status leads
  // with it, and crm-inbox-queries.service.ts reads leads.assignedToId). Writing only the
  // membership id left every "assigned to me" read matching nothing.
  await topUp(`${ctx.label} leads`, "leads", "org_id = $1", [ctx.org], leads, async (have, need) => {
    await sql.unsafe(
      `WITH ${MEMBER_POOL}
       INSERT INTO leads (org_id, name, email, status, assigned_to_membership_id, assigned_to_id, deleted_at, created_at, updated_at)
       SELECT $1, 'Lead ' || g, 'lead' || g || '@' || $1 || '.test',
              (ARRAY['NEW','CONTACTED','QUALIFIED','UNQUALIFIED','CONVERTED'])[1 + (g % 5)],
              mem.id, mem.user_id, null, now() - (g || ' minutes')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN mem ON mem.rn = g % $4::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, ctx.memberCount],
    );
  });
  await sql.unsafe(
    `UPDATE leads l SET assigned_to_id = om.user_id
     FROM organization_members om
     WHERE l.org_id = $1 AND om.org_id = l.org_id AND om.id = l.assigned_to_membership_id
       AND l.assigned_to_id IS NULL AND om.user_id IS NOT NULL`,
    [ctx.org],
  );

  const deals = scaled(BASE.deals, ctx.weight, SCALE);
  await topUp(`${ctx.label} deals`, "deals", "org_id = $1", [ctx.org], deals, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO deals (org_id, name, value_minor, stage, party_id, assigned_to_membership_id, deleted_at, created_at, updated_at)
       SELECT $1, 'Deal ' || g, ((g % 90) + 1) * 100000,
              (ARRAY['LEAD','QUALIFIED','PROPOSAL','NEGOTIATION','WON','LOST'])[1 + (g % 6)],
              $1 || '-party-' || (1 + (g % $4::int)), $5::int, null,
              now() - (g || ' minutes')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, parties, ctx.membership],
    );
  });
}

/**
 * The Party seam — the canonical side of the CRM read path.
 *
 * Ticket 02 made `business_parties` canonical and left `leads` and `contacts` as derived
 * mirrors, so `LeadsReadService.list` and `queryContacts` select from
 * `lead_party_map INNER JOIN business_parties` and `contact_party_map INNER JOIN
 * business_parties` (`src/modules/crm/crm-party-reads.ts`), not from the mirrors. Seeding only
 * the mirrors left both maps at zero rows and `owner_user_id` NULL on all 22,240 parties, so
 * every one of those reads matched nothing. That is why report 22c could not re-point
 * `leads-active`, `leads-assigned-to-me` and `contacts-list` at the tables their modules
 * actually read: the move would have traded a budget on the wrong table for a budget on an
 * empty join, which is the failure that ticket exists to remove.
 *
 * Leads take parties from the front of the org's parties and contacts from the back, so the
 * two never collide while `leads + contacts <= parties` and the pairing is stable across
 * re-runs. One party per legacy id: several legacy ids answering to one party is what a merge
 * produces, and nothing here is merged.
 *
 * The projection columns the reads coalesce over — `lifecycle_stage`, `priority`,
 * `acquisition_source`, `qualification_score`, `owner_user_id` — are filled from the mirror
 * row, so a predicate on the canonical side selects the rows the mirror-side predicate
 * selected. `next_follow_up_at` is set on a quarter of the lead parties in the past and a
 * quarter in the future, because the CRM inbox reads filter on it and a column that is NULL
 * everywhere makes that filter free.
 */
async function seedPartySeam(ctx) {
  const parties = await count("business_parties", "organization_id = $1", [ctx.org]);
  const leadRows = await count("leads", "org_id = $1", [ctx.org]);
  const contactRows = await count("contacts", "org_id = $1", [ctx.org]);
  if (leadRows + contactRows > parties)
    throw new Error(
      `not enough parties to map: ${leadRows} leads + ${contactRows} contacts > ${parties} business_parties`,
    );

  await topUp(`${ctx.label} lead_party_map`, "lead_party_map", "organization_id = $1", [ctx.org], leadRows, async () => {
    await sql.unsafe(
      `WITH l AS (SELECT id, row_number() OVER (ORDER BY id) rn FROM leads WHERE org_id = $1),
            p AS (SELECT party_id, row_number() OVER (ORDER BY party_id) rn
                    FROM business_parties WHERE organization_id = $1)
       INSERT INTO lead_party_map (organization_id, lead_id, party_id, linked_by, created_at)
       SELECT $1, l.id, p.party_id, 'seed:perf-scratch', now()
       FROM l JOIN p ON p.rn = l.rn
       ON CONFLICT DO NOTHING`,
      [ctx.org],
    );
  });

  await topUp(`${ctx.label} contact_party_map`, "contact_party_map", "organization_id = $1", [ctx.org], contactRows, async () => {
    await sql.unsafe(
      `WITH c AS (SELECT id, row_number() OVER (ORDER BY id) rn FROM contacts WHERE org_id = $1),
            p AS (SELECT party_id, row_number() OVER (ORDER BY party_id DESC) rn
                    FROM business_parties WHERE organization_id = $1)
       INSERT INTO contact_party_map (organization_id, contact_id, party_id, linked_by, created_at)
       SELECT $1, c.id, p.party_id, 'seed:perf-scratch', now()
       FROM c JOIN p ON p.rn = c.rn
       ON CONFLICT DO NOTHING`,
      [ctx.org],
    );
  });

  const lead = await sql.unsafe(
    `UPDATE business_parties bp
        SET owner_user_id = l.assigned_to_id,
            lifecycle_stage = l.status,
            qualification_score = coalesce(l.score, l.id % 100),
            priority = coalesce(l.priority, (ARRAY['HOT','WARM','COLD'])[1 + (l.id % 3)]),
            acquisition_source = coalesce(l.source, (ARRAY['web','referral','event','outbound'])[1 + (l.id % 4)]),
            next_follow_up_at = CASE l.id % 4
              WHEN 0 THEN now() - ((l.id % 72) || ' hours')::interval
              WHEN 1 THEN now() + ((l.id % 72) || ' hours')::interval
              ELSE NULL END,
            updated_at = now()
       FROM lead_party_map m
       JOIN leads l ON l.org_id = m.organization_id AND l.id = m.lead_id
      WHERE m.organization_id = $1 AND bp.organization_id = $1 AND bp.party_id = m.party_id
        AND (bp.lifecycle_stage IS DISTINCT FROM l.status
             OR bp.owner_user_id IS DISTINCT FROM l.assigned_to_id)`,
    [ctx.org],
  );
  if (lead.count > 0) log(`  ${ctx.label} business_parties (lead side): ${lead.count} projected`);

  const contact = await sql.unsafe(
    `WITH mem AS (SELECT user_id, (row_number() OVER (ORDER BY id)) - 1 AS rn
                    FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE')
     UPDATE business_parties bp
        SET owner_user_id = mem.user_id,
            party_kind = 'PERSON'::party_kind,
            job_title = coalesce(bp.job_title, c.title),
            department = coalesce(bp.department, c.department),
            updated_at = now()
       FROM contact_party_map m
       JOIN contacts c ON c.org_id = m.organization_id AND c.id = m.contact_id
       JOIN mem ON mem.rn = c.id % $2::int
      WHERE m.organization_id = $1 AND bp.organization_id = $1 AND bp.party_id = m.party_id
        AND bp.owner_user_id IS NULL`,
    [ctx.org, ctx.memberCount],
  );
  if (contact.count > 0) log(`  ${ctx.label} business_parties (contact side): ${contact.count} projected`);
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

async function seedInventory(ctx) {
  const createdBy = ctx.userId;
  if (!createdBy) throw new Error("no member to attribute inventory rows to");

  const vendors = scaled(BASE.invVendors, ctx.weight, SCALE);
  await topUp(`${ctx.label} inv_vendors`, "inv_vendors", "org_id = $1", [ctx.org], vendors, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO inv_vendors (org_id, name, code, created_by, created_at, updated_at)
       SELECT $1, 'Vendor ' || g, 'V-' || $1 || '-' || g, $4, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, createdBy],
    );
  });
  const vendorCount = await count("inv_vendors", "org_id = $1", [ctx.org]);

  await topUp(`${ctx.label} inv_warehouses`, "inv_warehouses", "org_id = $1", [ctx.org], 2, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO inv_warehouses (org_id, name, code, created_by, created_at, updated_at)
       SELECT $1, 'Warehouse ' || g, 'WH-' || $1 || '-' || g, $4, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, createdBy],
    );
  });
  const warehouseId = (await one(`SELECT id FROM inv_warehouses WHERE org_id = $1 ORDER BY id LIMIT 1`, [ctx.org]))?.id;

  const locations = scaled(BASE.invLocations, ctx.weight, SCALE);
  await topUp(`${ctx.label} inv_locations`, "inv_locations", "org_id = $1", [ctx.org], locations, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO inv_locations (org_id, warehouse_id, name, code, location_type, created_at, updated_at)
       SELECT $1, $4::int, 'Loc ' || g, 'L-' || $1 || '-' || g,
              (ARRAY['ZONE','AISLE','RACK','BIN'])[1 + (g % 4)]::inv_location_type, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, warehouseId],
    );
  });
  const locationCount = await count("inv_locations", "org_id = $1", [ctx.org]);

  const products = scaled(BASE.invProducts, ctx.weight, SCALE);
  await topUp(`${ctx.label} inv_products`, "inv_products", "org_id = $1", [ctx.org], products, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO inv_products (org_id, name, sku, created_by, created_at, updated_at)
       SELECT $1, 'Product ' || g, 'SKU-' || $1 || '-' || g, $4, now() - (g || ' minutes')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, createdBy],
    );
  });
  const productCount = await count("inv_products", "org_id = $1", [ctx.org]);

  const variants = scaled(BASE.invVariants, ctx.weight, SCALE);
  await topUp(`${ctx.label} inv_product_variants`, "inv_product_variants", "org_id = $1", [ctx.org], variants, async (have, need) => {
    await sql.unsafe(
      `WITH ${numberedPool("prod", "inv_products", "org_id = $1")}
       INSERT INTO inv_product_variants (org_id, product_id, name, sku, created_at, updated_at)
       SELECT $1, prod.id, 'Variant ' || g, 'VAR-' || $1 || '-' || g, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN prod ON prod.rn = g % $4::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, Math.max(1, productCount)],
    );
  });

  // The natural key is (org_id, product_variant_id, location_id): one row per pair.
  await topUp(`${ctx.label} inv_stock_levels`, "inv_stock_levels", "org_id = $1", [ctx.org], variants, async (have, need) => {
    await sql.unsafe(
      `WITH ${numberedPool("loc", "inv_locations", "org_id = $1")},
            v AS (SELECT id, (row_number() OVER (ORDER BY id)) - 1 AS rn FROM inv_product_variants WHERE org_id = $1)
       INSERT INTO inv_stock_levels (org_id, product_variant_id, location_id, on_hand, committed, updated_at)
       SELECT $1, v.id, loc.id, 50 + (v.id % 500), (v.id % 7), now()
       FROM v JOIN loc ON loc.rn = v.rn % $4::int
       WHERE v.rn >= $2::int AND v.rn < $2::int + $3::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, Math.max(1, locationCount)],
    );
  });
  const levelCount = await count("inv_stock_levels", "org_id = $1", [ctx.org]);

  // chk_inv_stock_transactions_arithmetic requires after = before + change, and
  // chk_inv_stock_transactions_nonzero rejects a zero delta. Both are computed, never guessed.
  const txns = scaled(BASE.invStockTransactions, ctx.weight, SCALE);
  await topUp(`${ctx.label} inv_stock_transactions`, "inv_stock_transactions", "org_id = $1", [ctx.org], txns, async (have, need) => {
    await sql.unsafe(
      `WITH lvl AS (SELECT product_variant_id, location_id, (row_number() OVER (ORDER BY id)) - 1 AS rn
                    FROM inv_stock_levels WHERE org_id = $1)
       INSERT INTO inv_stock_transactions
         (org_id, product_variant_id, location_id, transaction_type, quantity_change,
          quantity_before, quantity_after, created_by, created_at)
       SELECT $1, lvl.product_variant_id, lvl.location_id,
              (ARRAY['PURCHASE','SALE','ADJUSTMENT_IN','ADJUSTMENT_OUT','GRN','CYCLE_COUNT_GAIN'])[1 + (g % 6)]::inv_txn_type,
              d.delta, 1000, 1000 + d.delta, $4, now() - (g || ' seconds')::interval
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN lvl ON lvl.rn = g % $5::int
       CROSS JOIN LATERAL (SELECT (CASE WHEN g % 2 = 0 THEN 1 + (g % 40) ELSE -(1 + (g % 40)) END)::numeric AS delta) d
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, createdBy, Math.max(1, levelCount)],
    );
  });

  const pos = scaled(BASE.invPurchaseOrders, ctx.weight, SCALE);
  await topUp(`${ctx.label} inv_purchase_orders`, "inv_purchase_orders", "org_id = $1", [ctx.org], pos, async (have, need) => {
    await sql.unsafe(
      `WITH ${numberedPool("vend", "inv_vendors", "org_id = $1")}
       INSERT INTO inv_purchase_orders (org_id, vendor_id, po_number, order_date, created_by, created_at, updated_at)
       SELECT $1, vend.id, 'PO-' || $1 || '-' || g,
              (CURRENT_DATE - ((g % 365) || ' days')::interval)::date, $4, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN vend ON vend.rn = g % $5::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, createdBy, Math.max(1, vendorCount)],
    );
  });
}

// ---------------------------------------------------------------------------
// Build product surfaces
// ---------------------------------------------------------------------------

async function seedBuildProduct(ctx) {
  const proj = await one(
    `INSERT INTO build.projects (org_id, name, key, status, manager_membership_id, created_at, updated_at)
     VALUES ($1, 'Perf Project', 'PERF', 'ACTIVE', $2, now(), now())
     ON CONFLICT DO NOTHING RETURNING id`,
    [ctx.org, ctx.membership],
  );
  const projectId = proj?.id
    ?? (await one(`SELECT id FROM build.projects WHERE org_id = $1 AND key = 'PERF'`, [ctx.org]))?.id;
  if (!projectId) throw new Error("no build project for org");

  // build.tickets.status is a composite FK to build.project_statuses(org_id, project_id, name),
  // so a ticket cannot carry a status its project has not declared. The names must be the ones
  // the application writes — src/modules/build/core/lib/default-statuses.ts DEFAULT_PROJECT_STATUSES
  // and src/modules/dashboard/dashboard-personal.service.ts ACTIVE_TICKET_STATUSES both use
  // UPPER_SNAKE. This seed wrote title-case, so every query filtering on the application's own
  // status vocabulary matched zero rows and read as a broken query rather than a broken fixture.
  for (const [legacy, canonical] of LEGACY_STATUS_NAMES) {
    await sql.unsafe(
      `UPDATE build.project_statuses SET name = $3 WHERE org_id = $1 AND project_id = $2::int AND name = $4`,
      [ctx.org, projectId, canonical, legacy],
    );
  }
  for (let i = 0; i < PROJECT_STATUSES.length; i++) {
    await sql.unsafe(
      `INSERT INTO build.project_statuses (org_id, project_id, name, "order", type, created_at, updated_at)
       VALUES ($1, $2::int, $3, $4, $5::state_group, now(), now())
       ON CONFLICT DO NOTHING`,
      [ctx.org, projectId, PROJECT_STATUSES[i][0], i + 1, PROJECT_STATUSES[i][1]],
    );
  }

  await sql.unsafe(
    `INSERT INTO build.sprints (org_id, project_id, name, status, start_date, end_date, created_at, updated_at)
     VALUES ($1, $2, 'Perf Sprint', 'ACTIVE', CURRENT_DATE - INTERVAL '7 days', CURRENT_DATE + INTERVAL '7 days', now(), now())
     ON CONFLICT DO NOTHING`,
    [ctx.org, projectId],
  );

  await topUp(`${ctx.label} build.project_members`, "build.project_members", "org_id = $1", [ctx.org], Math.min(20, ctx.memberCount), async () => {
    await sql.unsafe(
      `INSERT INTO build.project_members (org_id, project_id, membership_id, role, joined_at)
       SELECT $1, $2::int, m.id, 'MEMBER', now()
       FROM (SELECT id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 20) m
       ON CONFLICT DO NOTHING`,
      [ctx.org, projectId],
    );
  });

  // build.tickets is the most-read table in the budget catalog and, before this layer,
  // every one of its 18,500 rows belonged to one organization.
  const tickets = Math.max(75, scaled(BASE.tickets, ctx.weight, SCALE));
  await topUp(`${ctx.label} build.tickets`, "build.tickets", "org_id = $1 AND deleted_at IS NULL", [ctx.org], tickets, async (have, need) => {
    const base = Number((await one(`SELECT coalesce(max(ticket_number), 0)::int n FROM build.tickets WHERE org_id = $1`, [ctx.org])).n);
    await sql.unsafe(
      `WITH ${MEMBER_POOL}
       INSERT INTO build.tickets (org_id, project_id, title, status, assignee_membership_id, reporter_membership_id, ticket_number, deleted_at, created_at, updated_at)
       SELECT $1, $2::int, 'Perf ticket ' || g || ' payment refund latency',
              (ARRAY['TODO','IN_PROGRESS','IN_REVIEW','DONE'])[1 + (g % 4)],
              mem.id, $6::int, $5::int + g, null, now() - (g || ' minutes')::interval, now()
       FROM generate_series($3::int + 1, $3::int + $4::int) g
       JOIN mem ON mem.rn = g % $7::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, projectId, have, need, base, ctx.membership, ctx.memberCount],
    );
  });

  await topUp(`${ctx.label} build.ticket_assignees`, "build.ticket_assignees", "org_id = $1", [ctx.org], Math.min(500, tickets), async (have, need) => {
    await sql.unsafe(
      `INSERT INTO build.ticket_assignees (org_id, ticket_id, membership_id, assigned_at)
       SELECT $1, t.id, t.assignee_membership_id, now()
       FROM (SELECT id, assignee_membership_id FROM build.tickets
             WHERE org_id = $1 AND assignee_membership_id IS NOT NULL
             ORDER BY id OFFSET $2::int LIMIT $3::int) t
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });

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
    [ctx.org],
  ).catch((e) => warn("project_ticket_counters sync", e));

  for (const [table, base, noun] of [
    ["build.roadmap_items", BASE.roadmapItems, "Roadmap item"],
    ["build.feedback_posts", BASE.feedbackPosts, "Feedback"],
    ["build.changelog_entries", BASE.changelogEntries, "Changelog"],
  ]) {
    const want = scaled(base, ctx.weight, SCALE);
    await topUp(`${ctx.label} ${table}`, table, "org_id = $1", [ctx.org], want, async (have, need) => {
      await sql.unsafe(
        `INSERT INTO ${table} (org_id, title, created_at, updated_at)
         SELECT $1, $4 || ' ' || g, now() - (g || ' hours')::interval, now()
         FROM generate_series($2::int + 1, $2::int + $3::int) g`,
        [ctx.org, have, need, noun],
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

async function seedFinance(ctx) {
  const payments = scaled(BASE.taxPayments, ctx.weight, SCALE);
  await topUp(`${ctx.label} acc_tax_payments`, "acc_tax_payments", "org_id = $1", [ctx.org], payments, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO acc_tax_payments (org_id, tax_type, period_start, period_end, amount, created_by, created_at)
       SELECT $1, (ARRAY['GST','CGST_SGST','IGST','VAT','TDS'])[1 + (g % 5)]::acc_tax_type,
              date_trunc('month', CURRENT_DATE - ((g % 24) || ' months')::interval)::date,
              (date_trunc('month', CURRENT_DATE - ((g % 24) || ' months')::interval) + interval '1 month - 1 day')::date,
              1000 + (g % 90000), $4, now() - (g || ' hours')::interval
       FROM generate_series($2::int + 1, $2::int + $3::int) g`,
      [ctx.org, have, need, ctx.userId],
    );
  });

  const policies = scaled(BASE.reminderPolicies, ctx.weight, SCALE);
  await topUp(`${ctx.label} fin_reminder_policies`, "fin_reminder_policies", "org_id = $1", [ctx.org], policies, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO fin_reminder_policies (org_id, name, offsets, created_at, updated_at)
       SELECT $1, 'Reminder policy ' || g, '[-7,-1,3,7]'::jsonb, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });
}

// ---------------------------------------------------------------------------
// Minority slices of the tables layer 1 filled for the majority tenant only
// ---------------------------------------------------------------------------

async function seedChat(ctx) {
  const channels = Math.max(CHAT_CHANNELS_MIN, scaled(BASE.chatChannels, ctx.weight, SCALE));
  await topUp(`${ctx.label} chat_channels`, "chat_channels", "org_id = $1", [ctx.org], channels, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO chat_channels (org_id, name, type, is_private, created_at, updated_at)
       SELECT $1, 'perf-channel-' || g, 'GROUP', true, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });
  const channelCount = await count("chat_channels", "org_id = $1", [ctx.org]);
  if (channelCount === 0) throw new Error("no chat channel for org");

  await topUp(`${ctx.label} chat_channel_members`, "chat_channel_members", "org_id = $1", [ctx.org], Math.max(CHAT_CHANNEL_MEMBERS_MIN, scaled(500, ctx.weight, SCALE)), async () => {
    await sql.unsafe(
      `INSERT INTO chat_channel_members (org_id, channel_id, membership_id, joined_at)
       SELECT $1, c.id, m.id, now()
       FROM (SELECT id FROM chat_channels WHERE org_id = $1 ORDER BY id LIMIT 55) c
       CROSS JOIN (SELECT id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 50) m
       ON CONFLICT DO NOTHING`,
      [ctx.org],
    );
  });

  const msgs = Math.max(300, scaled(BASE.chatMessages, ctx.weight, SCALE));
  await topUp(`${ctx.label} chat_messages`, "chat_messages", "org_id = $1", [ctx.org], msgs, async (have, need) => {
    await sql.unsafe(
      `WITH ${MEMBER_POOL},
            ${numberedPool("chan", "chat_channels", "org_id = $1")}
       INSERT INTO chat_messages (org_id, channel_id, sender_membership_id, content, is_deleted, created_at, updated_at)
       SELECT $1, chan.id, mem.id, 'Perf message ' || g, false, now() - (g || ' seconds')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN mem ON mem.rn = g % $4::int
       JOIN chan ON chan.rn = g % $5::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, ctx.memberCount, channelCount],
    );
  });

  await topUp(`${ctx.label} chat_saved_messages`, "chat_saved_messages", "org_id = $1", [ctx.org], Math.max(75, scaled(200, ctx.weight, SCALE)), async (have, need) => {
    await sql.unsafe(
      `INSERT INTO chat_saved_messages (org_id, membership_id, message_id, saved_at)
       SELECT $1, msg.sender_membership_id, msg.id, now()
       FROM (SELECT id, sender_membership_id FROM chat_messages
             WHERE org_id = $1 AND sender_membership_id IS NOT NULL
             ORDER BY id OFFSET $2::int LIMIT $3::int) msg
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });
}

async function seedHr(ctx) {
  const people = scaled(BASE.hrPeople, ctx.weight, SCALE);
  await topUp(`${ctx.label} hr_people`, "hr_people", "org_id = $1", [ctx.org], people, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO hr_people (org_id, created_at, updated_at)
       SELECT $1, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g`,
      [ctx.org, have, need],
    );
  });

  await topUp(`${ctx.label} hr_employments`, "hr_employments", "org_id = $1", [ctx.org], people, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO hr_employments (org_id, person_id, employee_number, lifecycle_status, created_at, updated_at)
       SELECT $1, p.id, 'EMP-' || $1 || '-' || p.id, 'ACTIVE'::hr_employment_lifecycle_status, now(), now()
       FROM (SELECT id FROM hr_people WHERE org_id = $1 ORDER BY id OFFSET $2::int LIMIT $3::int) p
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });

  const leaveTypeId = (await one(`SELECT id FROM leave_types WHERE org_id = $1 ORDER BY id LIMIT 1`, [ctx.org]))?.id
    ?? (await one(
      `INSERT INTO leave_types (org_id, name, days_per_year)
       VALUES ($1, 'Annual', 24) ON CONFLICT DO NOTHING RETURNING id`,
      [ctx.org],
    ))?.id;
  if (!leaveTypeId) throw new Error("no leave_type for org");

  const leaves = scaled(BASE.leaveRequests, ctx.weight, SCALE);
  await topUp(`${ctx.label} leave_requests`, "leave_requests", "org_id = $1", [ctx.org], leaves, async (have, need) => {
    await sql.unsafe(
      `WITH ${MEMBER_POOL}
       INSERT INTO leave_requests (org_id, user_id, user_membership_id, leave_type_id, start_date, end_date, status, created_at, updated_at)
       SELECT $1, mem.user_id, mem.id, $4::int,
              (CURRENT_DATE - ((g % 200) || ' days')::interval)::date,
              (CURRENT_DATE - ((g % 200) || ' days')::interval + interval '1 day')::date,
              (ARRAY['PENDING','APPROVED','REJECTED'])[1 + (g % 3)]::leave_status,
              now() - (g || ' minutes')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN mem ON mem.rn = g % $5::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, leaveTypeId, ctx.memberCount],
    );
  });

  /**
   * The leaves that are RUNNING right now, which the block above cannot produce.
   *
   * Every row it writes starts at `CURRENT_DATE - ((g % 200) || ' days')` and ends one day
   * later, so the whole population is one-day leaves entirely BEHIND the moment the seed
   * ran. `DashboardStatsService.leavesToday` reads
   * `status = 'APPROVED' AND start_date <= today AND end_date >= today`, which can only
   * match a row whose `g % 200` happened to be 0 on the day the seed ran — and never again
   * afterwards. Measured on `scratch_perf_seed` on 2026-09-04: 440 APPROVED leave requests
   * for the reference tenant, ZERO of them spanning today, so `dashboard-leaves-today`
   * measured an empty result set and `run-read-cost-budgets.mjs` reported it vacuous.
   *
   * The predicate `topUp` counts is the route's own predicate, so this section refills
   * whatever the wall clock has ended rather than writing a fixed set of dates that goes
   * stale tomorrow. Multi-day spans are deliberate: a one-day leave is out of the window
   * within hours of being written, and `end_date >= CURRENT_DATE` is exactly the arm that
   * was never exercised.
   *
   * End-dates now extend up to LEAVES_FORWARD_DAYS into the future so rows remain valid
   * for that many days between seed runs. The minimum is 2 days, guaranteeing at least a
   * full day of buffer even when the seed is run at 23:59.
   */
  await topUp(
    `${ctx.label} leave_requests spanning today`,
    "leave_requests",
    "org_id = $1 AND status = 'APPROVED' AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE",
    [ctx.org],
    LEAVES_SPANNING_TODAY,
    async (_have, need) => {
      await sql.unsafe(
        `WITH ${MEMBER_POOL}
         INSERT INTO leave_requests (org_id, user_id, user_membership_id, leave_type_id, start_date, end_date, status, created_at, updated_at)
         SELECT $1, mem.user_id, mem.id, $3::int,
                (CURRENT_DATE - ((g % 4) || ' days')::interval)::date,
                (CURRENT_DATE + (((g % ${LEAVES_FORWARD_DAYS - 1}) + 2) || ' days')::interval)::date,
                'APPROVED'::leave_status,
                now() - (g || ' minutes')::interval, now()
         FROM generate_series(1, $2::int) g
         JOIN mem ON mem.rn = g % $4::int
         ON CONFLICT DO NOTHING`,
        [ctx.org, need, leaveTypeId, ctx.memberCount],
      );
    },
  );

  /**
   * Resolve the benchmark fixture participant: the member the harness selects as the
   * subject for `leave-requests-mine` and `attendance-mine` (the one with the most rows
   * in build.ticket_assignees, mirroring the query in run-read-cost-budgets.mjs:458).
   * seedBuildProduct runs before seedHr in main(), so build.ticket_assignees is populated.
   *
   * If the fixture participant differs from ctx.membership (the first active member by id),
   * the "fixture membership" topUps below would seed rows for the wrong person. The harness
   * would then find far fewer rows than the budgets' minRows requires, and both budgets
   * would remain vacuous after the rowCountSql fix.
   */
  const [fixturePart] = await sql.unsafe(
    `SELECT ta.membership_id, om.user_id
     FROM build.ticket_assignees ta
     INNER JOIN organization_members om ON om.org_id = ta.org_id AND om.id = ta.membership_id
     WHERE ta.org_id = $1
     GROUP BY ta.membership_id, om.user_id
     ORDER BY count(*) DESC, ta.membership_id ASC LIMIT 1`,
    [ctx.org],
  );
  const fixtureMembership = fixturePart?.membership_id ?? ctx.membership;
  const fixtureUserId = fixturePart?.user_id ?? ctx.userId;

  await topUp(
    `${ctx.label} leave_requests fixture membership`,
    "leave_requests",
    "org_id = $1 AND user_membership_id = $2",
    [ctx.org, fixtureMembership],
    FIXTURE_LEAVE_REQUESTS_MIN,
    async (have, need) => {
      await sql.unsafe(
        `INSERT INTO leave_requests (org_id, user_id, user_membership_id, leave_type_id, start_date, end_date, status, created_at, updated_at)
         SELECT $1, $2, $3::int, $4::int,
                (CURRENT_DATE - (($5::int + g + 200) || ' days')::interval)::date,
                (CURRENT_DATE - (($5::int + g + 199) || ' days')::interval)::date,
                (ARRAY['PENDING','APPROVED','REJECTED'])[1 + (g % 3)]::leave_status,
                now() - (g || ' minutes')::interval, now()
         FROM generate_series(1, $6::int) g
         ON CONFLICT DO NOTHING`,
        [ctx.org, fixtureUserId, fixtureMembership, leaveTypeId, have, need],
      );
    },
  );

  await topUp(`${ctx.label} leave_balances`, "leave_balances", "org_id = $1", [ctx.org], Math.max(15, scaled(500, ctx.weight, SCALE)), async (have, need) => {
    await sql.unsafe(
      `INSERT INTO leave_balances (org_id, user_id, user_membership_id, leave_type_id, year, balance)
       SELECT $1, m.user_id, m.id, $4::int, 2026, 24 - (m.id % 12)
       FROM (SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE'
             ORDER BY id OFFSET $2::int LIMIT $3::int) m
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, leaveTypeId],
    );
  });

  await topUp(`${ctx.label} hr_leave_ledger`, "hr_leave_ledger", "org_id = $1", [ctx.org], Math.max(15, scaled(500, ctx.weight, SCALE)), async (have, need) => {
    await sql.unsafe(
      `INSERT INTO hr_leave_ledger (org_id, user_id, user_membership_id, leave_type_id, txn_type, days, effective_date, source, created_at)
       SELECT $1, m.user_id, m.id, $4::int, 'accrual'::hr_leave_txn_type, 2,
              (CURRENT_DATE - ((m.id % 300) || ' days')::interval)::date,
              'policy_accrual'::hr_leave_ledger_source, now()
       FROM (SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE'
             ORDER BY id OFFSET $2::int LIMIT $3::int) m
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, leaveTypeId],
    );
  });

  const now = new Date();
  const currentPeriod = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  await topUp(
    `${ctx.label} hr_leave_ledger cron accrual (leave-accrual-ledger-dedup)`,
    "hr_leave_ledger",
    "org_id = $1 AND source = 'cron'::hr_leave_ledger_source AND period = $2",
    [ctx.org, currentPeriod],
    FIXTURE_LEAVE_LEDGER_CRON_MIN,
    async (_have, need) => {
      await sql.unsafe(
        `INSERT INTO hr_leave_ledger (org_id, user_id, user_membership_id, leave_type_id, txn_type, days, effective_date, period, source, created_at)
         SELECT $1, m.user_id, m.id, $3::int, 'accrual'::hr_leave_txn_type, 2,
                CURRENT_DATE, $4, 'cron'::hr_leave_ledger_source, now()
         FROM (SELECT id, user_id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE'
               ORDER BY id LIMIT $2::int) m`,
        [ctx.org, need, leaveTypeId, currentPeriod],
      );
    },
  );

  const att = scaled(BASE.attendance, ctx.weight, SCALE);
  await topUp(`${ctx.label} attendance`, "attendance", "org_id = $1", [ctx.org], att, async (have, need) => {
    await sql.unsafe(
      `WITH ${MEMBER_POOL}
       INSERT INTO attendance (org_id, user_id, user_membership_id, date, status, created_at)
       SELECT $1, mem.user_id, mem.id, (CURRENT_DATE - ((g % 180) || ' days')::interval)::date,
              (ARRAY['PRESENT','ABSENT','LEAVE','HALF_DAY'])[1 + (g % 4)], now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN mem ON mem.rn = g % $4::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, ctx.memberCount],
    );
  });

  await topUp(
    `${ctx.label} attendance fixture membership`,
    "attendance",
    "org_id = $1 AND user_membership_id = $2",
    [ctx.org, fixtureMembership],
    FIXTURE_ATTENDANCE_MIN,
    async (have, need) => {
      await sql.unsafe(
        `INSERT INTO attendance (org_id, user_id, user_membership_id, date, status, created_at)
         SELECT $1, $2, $3::int,
                (CURRENT_DATE - (($4::int + g + 180) || ' days')::interval)::date,
                (ARRAY['PRESENT','ABSENT','LEAVE','HALF_DAY'])[1 + (g % 4)],
                now() - (g || ' hours')::interval
         FROM generate_series(1, $5::int) g
         ON CONFLICT DO NOTHING`,
        [ctx.org, fixtureUserId, fixtureMembership, have, need],
      );
    },
  );

  const ts = Math.max(75, scaled(BASE.timesheets, ctx.weight, SCALE));
  await topUp(`${ctx.label} timesheets`, "timesheets", "org_id = $1", [ctx.org], ts, async (have, need) => {
    await sql.unsafe(
      `WITH ${MEMBER_POOL}
       INSERT INTO timesheets (org_id, user_membership_id, date, hours, status, created_at, updated_at)
       SELECT $1, mem.id, (CURRENT_DATE - ((g % 180) || ' days')::interval)::date, 8,
              (ARRAY['PENDING','APPROVED','REJECTED'])[1 + (g % 3)]::timesheet_entry_status, now(), now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN mem ON mem.rn = g % $4::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, ctx.memberCount],
    );
  });
}

/**
 * The forward calendar window. Layer 2 (`seed-heavy-query-load.mjs`) plants the bulk
 * calendar history and seeds an initial forward window via `seedUpcomingWindow`, but
 * that window ages out as wall-clock time advances past the seeded dates. This topUp
 * refills it on every layer-3 run so `dashboard-personal-calendar-events` always faces
 * a non-empty result set. The predicate matches the one in the budget SQL
 * (`start_date >= NOW()` + `visibility = 'org'` + no rrule), and events are spread
 * 2–180 days into the future so they survive at least one day and do not decay to zero
 * within hours the way `seedReminderWindow` events do.
 */
async function seedCalendarForwardWindow(ctx) {
  if (!ctx.membership) throw new Error("no membership to author calendar events");
  await topUp(
    `${ctx.label} calendar_events forward window`,
    "calendar_events",
    "org_id = $1 AND visibility = 'org' AND rrule IS NULL AND start_date >= now() + interval '1 day'",
    [ctx.org],
    UPCOMING_CALENDAR_EVENTS,
    async (_have, need) => {
      await sql.unsafe(
        `INSERT INTO calendar_events
           (org_id, title, description, start_date, end_date, all_day, category,
            timezone, rrule, reminder_15min_sent, created_by_membership_id, visibility, color)
         SELECT $1,
                'Upcoming event (perf fixture) ' || g,
                'Keeps dashboard-personal-calendar-events non-vacuous',
                now() + ((g % 179 + 2) || ' days')::interval + ((g % 9) || ' hours')::interval,
                now() + ((g % 179 + 2) || ' days')::interval + ((g % 9) || ' hours')::interval + interval '45 minutes',
                false,
                (ARRAY['meeting','review','standup','interview'])[1 + (g % 4)],
                'UTC', NULL, false, $2::int, 'org', '#0ea5e9'
         FROM generate_series(1, $3::int) g`,
        [ctx.org, ctx.membership, need],
      );
    },
  );
}

async function seedSupport(ctx) {
  const tickets = Math.max(150, scaled(BASE.supportTickets, ctx.weight, SCALE));
  await topUp(`${ctx.label} support_tickets`, "support_tickets", "org_id = $1", [ctx.org], tickets, async (have, need) => {
    await sql.unsafe(
      `WITH ${MEMBER_POOL}
       INSERT INTO support_tickets
         (org_id, title, status, priority, assignee_membership_id, source_channel,
          created_by_membership_id, sla_paused_minutes, sla_escalation_level, created_at, updated_at)
       SELECT $1, 'Support ticket ' || g,
              (ARRAY['OPEN','IN_PROGRESS','WAITING','RESOLVED','CLOSED'])[1 + (g % 5)]::support_ticket_status,
              (ARRAY['LOW','MEDIUM','HIGH','URGENT'])[1 + (g % 4)]::support_ticket_priority,
              mem.id, 'web', $4::int, 0, 0, now() - (g || ' minutes')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN mem ON mem.rn = g % $5::int
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, ctx.membership, ctx.memberCount],
    );
  });
}

async function seedMail(ctx) {
  // mail_message_metadata.account_id carries no foreign key; it is a mailbox identifier,
  // and one account per organization keeps (account_id, message_id) unique.
  const existing = (await one(`SELECT min(account_id) AS id FROM mail_message_metadata WHERE org_id = $1`, [ctx.org]))?.id;
  const next = (await one(`SELECT coalesce(max(account_id), 0) + 1 AS id FROM mail_message_metadata`))?.id ?? 1;
  const accountId = existing ?? next;

  const msgs = Math.max(3000, scaled(BASE.mailMessages, ctx.weight, SCALE));
  await topUp(`${ctx.label} mail_message_metadata`, "mail_message_metadata", "org_id = $1", [ctx.org], msgs, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO mail_message_metadata (org_id, account_id, message_id, subject, is_read, date, user_membership_id, synced_at)
       SELECT $1, $4::int, 'perf-msg-' || $1 || '-' || g, 'Perf subject ' || g, (g % 3 = 0),
              now() - (g || ' minutes')::interval, $5::int, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, accountId, ctx.membership],
    );
  });

  const [fixturePart] = await sql.unsafe(
    `SELECT ta.membership_id
     FROM build.ticket_assignees ta
     WHERE ta.org_id = $1
     GROUP BY ta.membership_id
     ORDER BY count(*) DESC, ta.membership_id ASC LIMIT 1`,
    [ctx.org],
  );
  const fixtureMembershipId = fixturePart?.membership_id ?? ctx.membership;
  if (fixtureMembershipId) {
    await topUp(
      `${ctx.label} mail_message_metadata fixture membership (mail-inbox-cached)`,
      "mail_message_metadata",
      "org_id = $1 AND user_membership_id = $2 AND folder = 'inbox'",
      [ctx.org, fixtureMembershipId],
      FIXTURE_MAIL_INBOX_MIN,
      async (_have, need) => {
        const nextSeq = (await one(`SELECT coalesce(max(account_id), 0) + 1 AS id FROM mail_message_metadata`))?.id ?? 1;
        const fixtureAccountId = (await one(`SELECT min(account_id) AS id FROM mail_message_metadata WHERE org_id = $1`, [ctx.org]))?.id ?? nextSeq;
        await sql.unsafe(
          `INSERT INTO mail_message_metadata (org_id, account_id, message_id, subject, is_read, date, user_membership_id, folder, synced_at)
           SELECT $1, $3::int, 'perf-fxmail-' || $1 || '-' || $4::int || '-' || g, 'Fixture inbox ' || g, false,
                  now() - (g || ' minutes')::interval, $4::int, 'inbox', now()
           FROM generate_series(1, $2::int) g
           ON CONFLICT DO NOTHING`,
          [ctx.org, need, fixtureAccountId, fixtureMembershipId],
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// KB spaces + page visits — kb-spaces-list (minRows 3) + kb-page-visits-mine (minRows 30)
// ---------------------------------------------------------------------------

async function seedKb(ctx) {
  await topUp(`${ctx.label} kb_spaces`, "kb_spaces", "org_id = $1", [ctx.org], KB_SPACES_MIN, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO kb_spaces (org_id, name, slug, audience, created_at, updated_at)
       SELECT $1, 'Perf Space ' || ($2::int + g), 'perf-space-' || $1 || '-' || ($2::int + g), 'internal', now(), now()
       FROM generate_series(1, $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });

  const [probeSpace] = await sql.unsafe(
    `SELECT id FROM kb_spaces WHERE org_id = $1 ORDER BY id LIMIT 1`,
    [ctx.org],
  );
  if (probeSpace) {
    await topUp(
      `${ctx.label} kb_pages probe (kb-page-id-probe-sdf)`,
      "kb_pages",
      "org_id = $1 AND deleted_at IS NULL AND fts @@ websearch_to_tsquery('english', 'policy')",
      [ctx.org],
      KB_PROBE_PAGES_MIN,
      async (have, need) => {
        await sql.unsafe(
          `INSERT INTO kb_pages (org_id, space_id, title, content, status, visibility, sort_order,
                                 created_by_id, created_by_membership_id, last_edited_by_id,
                                 last_edited_by_membership_id, created_at, updated_at)
           SELECT $1, $2::int, 'Policy Document ' || ($3::int + g), '{}'::jsonb, 'published', 'org',
                  90000 + $3::int + g, $4, $5::int, $4, $5::int, now(), now()
           FROM generate_series(1, $6::int) g`,
          [ctx.org, probeSpace.id, have, ctx.userId, ctx.membership, need],
        );
      },
    );
  } else {
    log(`  ${ctx.label} kb_page_probe: no space found — skipping`);
  }

  const [fixturePart] = await sql.unsafe(
    `SELECT ta.membership_id, om.user_id
     FROM build.ticket_assignees ta
     INNER JOIN organization_members om ON om.org_id = ta.org_id AND om.id = ta.membership_id
     WHERE ta.org_id = $1
     GROUP BY ta.membership_id, om.user_id
     ORDER BY count(*) DESC, ta.membership_id ASC LIMIT 1`,
    [ctx.org],
  );
  const fixtureMembershipId = fixturePart?.membership_id ?? ctx.membership;
  const fixtureUserId = fixturePart?.user_id ?? ctx.userId;

  if (!fixtureMembershipId || !fixtureUserId) {
    log(`  ${ctx.label} kb_page_visits: no fixture member — skipping`);
    return;
  }

  const pageIds = await sql.unsafe(
    `SELECT id FROM kb_pages WHERE org_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT 50`,
    [ctx.org],
  );
  if (!pageIds.length) { log(`  ${ctx.label} kb_page_visits: no kb_pages — skipping`); return; }

  const existingVisits = await count(
    "kb_page_visits",
    "org_id = $1 AND membership_id = $2",
    [ctx.org, fixtureMembershipId],
  );
  if (existingVisits >= FIXTURE_KB_PAGE_VISITS_MIN) return;

  const pagesNeeded = Math.min(FIXTURE_KB_PAGE_VISITS_MIN, pageIds.length);
  const pages = pageIds.slice(0, pagesNeeded);
  for (const { id: pageId } of pages) {
    await sql.unsafe(
      `INSERT INTO kb_page_visits (org_id, user_id, membership_id, page_id, visited_at)
       VALUES ($1, $2, $3::int, $4::int, now() - (random() * 100 || ' hours')::interval)
       ON CONFLICT DO NOTHING`,
      [ctx.org, fixtureUserId, fixtureMembershipId, pageId],
    );
  }
  if (pages.length < FIXTURE_KB_PAGE_VISITS_MIN) {
    log(`  ${ctx.label} kb_page_visits: only ${pages.length} kb_pages available (need ${FIXTURE_KB_PAGE_VISITS_MIN}); seed more kb_pages in layer 2`);
  }
  log(`  ${ctx.label} kb_page_visits: seeded ${pages.length} visits for fixture membership`);
}

// ---------------------------------------------------------------------------
// Leave policies — required by leave-accrual-ledger-dedup and leave-accrual-balance-read
// ---------------------------------------------------------------------------

async function seedLeavePolicies(ctx) {
  const leaveTypeId = (await one(`SELECT id FROM leave_types WHERE org_id = $1 ORDER BY id LIMIT 1`, [ctx.org]))?.id;
  if (!leaveTypeId) { log(`  ${ctx.label} leave_policies: no leave_type — skipping`); return; }
  const existing = await count("leave_policies", "org_id = $1 AND accrual_type = 'MONTHLY' AND is_active = true", [ctx.org]);
  if (existing > 0) return;
  await sql.unsafe(
    `INSERT INTO leave_policies
       (org_id, leave_type_id, name, accrual_type, accrual_rate, effective_from, is_active, created_at)
     VALUES ($1, $2, 'Monthly Accrual', 'MONTHLY', 2.00, '2024-01-01', true, now())`,
    [ctx.org, leaveTypeId],
  );
  log(`  ${ctx.label} leave_policies: seeded 1 MONTHLY active policy`);
}

// ---------------------------------------------------------------------------
// Payroll — required by payroll-runs-list, payroll-run-employees, payroll-line-items
// ---------------------------------------------------------------------------

async function seedPayroll(ctx) {
  const runsWant = Math.max(6, scaled(BASE.payrollRuns, ctx.weight, SCALE));
  const existingRuns = await count("payroll_runs", "org_id = $1", [ctx.org]);
  if (existingRuns < runsWant) {
    for (let i = existingRuns; i < runsWant; i++) {
      const d = new Date();
      d.setMonth(d.getMonth() - (runsWant - i));
      const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      // Insert as DRAFT so the immutability trigger allows employee/line-item inserts.
      await sql.unsafe(
        `INSERT INTO payroll_runs
           (org_id, run_type, month, status, gross_total, deduction_total, employer_cost_total, net_total, created_at, updated_at)
         VALUES ($1, 'REGULAR', $2, 'DRAFT', 500000, 50000, 25000, 450000, now(), now())
         ON CONFLICT DO NOTHING`,
        [ctx.org, month],
      ).catch((e) => log(`  ${ctx.label} payroll_run ${month}: ${e.message}`));
    }
    log(`  ${ctx.label} payroll_runs: ${existingRuns} -> ${await count("payroll_runs", "org_id = $1", [ctx.org])}`);
  }

  // Prefer a DRAFT run so the trigger allows inserts; fall back to any run for idempotency.
  let runRow = await one(
    `SELECT id, status FROM payroll_runs WHERE org_id = $1 AND status = 'DRAFT' ORDER BY id DESC LIMIT 1`,
    [ctx.org],
  );
  if (!runRow) {
    // All runs are already finalized (prior seeded run). Check whether the latest has line_items.
    const latest = await one(`SELECT id, status FROM payroll_runs WHERE org_id = $1 ORDER BY id DESC LIMIT 1`, [ctx.org]);
    if (!latest) return;
    const lineCount = await count("payroll_line_items", "org_id = $1 AND run_id = $2", [ctx.org, latest.id]);
    if (lineCount >= Math.max(5, ctx.memberCount * 2)) return; // already fully seeded
    // Recovery path: create a fresh DRAFT run for the missing line_items.
    const d = new Date();
    d.setMonth(d.getMonth() - runsWant - 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    runRow = await one(
      `INSERT INTO payroll_runs
         (org_id, run_type, month, status, gross_total, deduction_total, employer_cost_total, net_total, created_at, updated_at)
       VALUES ($1, 'REGULAR', $2, 'DRAFT', 500000, 50000, 25000, 450000, now(), now())
       ON CONFLICT DO NOTHING RETURNING id, status`,
      [ctx.org, month],
    );
    if (!runRow) return;
  }
  const runId = runRow.id;

  await topUp(`${ctx.label} payroll_run_employees`, "payroll_run_employees", "org_id = $1 AND run_id = $2", [ctx.org, runId], Math.max(5, ctx.memberCount), async (have, need) => {
    await sql.unsafe(
      `INSERT INTO payroll_run_employees
         (org_id, run_id, user_id, user_membership_id, worker_type, currency, scheduled_days, paid_days,
          gross, total_deductions, net, status, created_at, updated_at)
       SELECT $1, $2::int, m.user_id, m.id, 'EMPLOYEE'::payroll_worker_type, 'INR',
              22, 22, 50000, 5000, 45000, 'PROCESSED', now(), now()
       FROM (SELECT id, user_id FROM organization_members
             WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id OFFSET $3::int LIMIT $4::int) m
       ON CONFLICT DO NOTHING`,
      [ctx.org, runId, have, need],
    );
  });

  const empCount = await count("payroll_run_employees", "org_id = $1 AND run_id = $2", [ctx.org, runId]);
  await topUp(`${ctx.label} payroll_line_items`, "payroll_line_items", "org_id = $1 AND run_id = $2", [ctx.org, runId], Math.max(5, empCount * 2), async () => {
    await sql.unsafe(
      `WITH rpe AS (SELECT id, (row_number() OVER (ORDER BY id)) - 1 AS rn FROM payroll_run_employees WHERE org_id = $1 AND run_id = $2::int)
       INSERT INTO payroll_line_items
         (org_id, run_id, run_employee_id, code, name, category, amount, calc_method, calc_explain, taxable, sort_order, created_at)
       SELECT $1, $2::int, rpe.id,
              CASE g % 2 WHEN 0 THEN 'BASIC' ELSE 'HRA' END,
              CASE g % 2 WHEN 0 THEN 'Basic Salary' ELSE 'House Rent Allowance' END,
              'EARNING'::salary_component_type,
              CASE g % 2 WHEN 0 THEN 30000 ELSE 15000 END,
              'FIXED'::salary_component_calc_method,
              '{}'::jsonb, true, g % 2,
              now()
       FROM generate_series(0, $3::int * 2 - 1) g
       JOIN rpe ON rpe.rn = g % GREATEST(1, $3::int)
       ON CONFLICT DO NOTHING`,
      [ctx.org, runId, empCount],
    );
  });

  // Lock the run now that employees and line_items are committed.
  await sql.unsafe(
    `UPDATE payroll_runs SET status = 'CLOSED', updated_at = now() WHERE id = $1 AND org_id = $2 AND status = 'DRAFT'`,
    [runId, ctx.org],
  ).catch((e) => log(`  ${ctx.label} payroll close run ${runId}: ${e.message}`));
}

// ---------------------------------------------------------------------------
// Announcements — required by dashboard-announcements fixture flag
// ---------------------------------------------------------------------------

async function seedAnnouncements(ctx) {
  const want = Math.max(10, scaled(BASE.announcements, ctx.weight, SCALE));
  await topUp(`${ctx.label} announcements`, "announcements", "org_id = $1", [ctx.org], want, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO announcements
         (org_id, title, content, author_id, target_type, is_pinned, status, read_count, attachment_urls, created_at, updated_at)
       SELECT $1, 'Announcement ' || g, 'Content for announcement ' || g,
              $2, 'ALL', false, 'PUBLISHED', 0, '[]'::jsonb,
              now() - (g || ' hours')::interval, now()
       FROM generate_series($3::int + 1, $3::int + $4::int) g`,
      [ctx.org, ctx.userId, have, need],
    );
  });
}

// ---------------------------------------------------------------------------
// Reporting lines — required by employee-reporting-line-lookup (minRows 1000)
// ---------------------------------------------------------------------------

async function seedReportingLines(ctx) {
  const target = 1500;
  const empCount = await count("hr_employments", "org_id = $1 AND deleted_at IS NULL", [ctx.org]);
  if (empCount < 2) { log(`  ${ctx.label} hr_reporting_lines: skip — fewer than 2 employments`); return; }

  // Phase 1: give each employment exactly one open primary line (effective_to = 'infinity').
  // The NOT EXISTS guard skips employments that already have one (e.g., from layer 1 for large).
  // Each row in `emps` is unique, so at most one open line is inserted per employment.
  await sql.unsafe(
    `WITH emps AS (
       SELECT e.id, (row_number() OVER (ORDER BY e.id)) - 1 AS rn
       FROM hr_employments e WHERE e.org_id = $1 AND e.deleted_at IS NULL
     )
     INSERT INTO hr_reporting_lines
       (org_id, employment_id, manager_employment_id, line_type, effective_from, effective_to, created_at)
     SELECT $1, e1.id, e2.id, 'primary'::hr_reporting_line_type, '2020-01-01'::date, 'infinity'::date, now()
     FROM emps e1
     JOIN emps e2 ON e2.rn = (e1.rn + 1) % $2::int
     WHERE e1.id <> e2.id
       AND NOT EXISTS (
         SELECT 1 FROM hr_reporting_lines rl
         WHERE rl.org_id = $1 AND rl.employment_id = e1.id
           AND rl.line_type = 'primary' AND rl.effective_to = 'infinity'::date
       )`,
    [ctx.org, empCount],
  ).catch((e) => log(`  ${ctx.label} reporting lines phase 1: ${e.message}`));

  // Phase 2: pad with bounded historical lines to reach 1500 total.
  // Each (employment, slot) pair gets a unique 90-day window anchored at 1900-01-01.
  // Slot = floor(g / empCount), so the same employment_id never reuses a slot, preventing
  // overlap. Dates in 1900-1936 never overlap with layer-1 open lines (effective_from >= 2021).
  const have1 = await count("hr_reporting_lines", "org_id = $1", [ctx.org]);
  if (have1 >= target) { log(`  ${ctx.label} hr_reporting_lines: ${have1}`); return; }
  const need2 = target - have1;
  await sql.unsafe(
    `WITH emps AS (
       SELECT e.id, (row_number() OVER (ORDER BY e.id)) - 1 AS rn
       FROM hr_employments e WHERE e.org_id = $1 AND e.deleted_at IS NULL
     )
     INSERT INTO hr_reporting_lines
       (org_id, employment_id, manager_employment_id, line_type, effective_from, effective_to, created_at)
     SELECT $1, e1.id, e2.id, 'primary'::hr_reporting_line_type,
            ('1900-01-01'::date + ((g / $2::int) * 90 || ' days')::interval)::date,
            ('1900-01-01'::date + ((g / $2::int) * 90 + 89 || ' days')::interval)::date,
            now()
     FROM generate_series(0, $3::int - 1) g
     JOIN emps e1 ON e1.rn = g % $2::int
     JOIN emps e2 ON e2.rn = (g + 1) % $2::int
     WHERE e1.id <> e2.id`,
    [ctx.org, empCount, need2],
  ).catch((e) => log(`  ${ctx.label} reporting lines phase 2: ${e.message}`));

  log(`  ${ctx.label} hr_reporting_lines: ${have1} -> ${await count("hr_reporting_lines", "org_id = $1", [ctx.org])}`);
}

// ---------------------------------------------------------------------------
// Organization people — required by org-people-list (minRows 10)
// ---------------------------------------------------------------------------

async function seedOrganizationPeople(ctx) {
  const want = Math.max(15, ctx.memberCount);
  await topUp(`${ctx.label} organization_people`, "organization_people", "organization_id = $1 AND deleted_at IS NULL", [ctx.org], want, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO organization_people
         (organization_person_id, organization_id, first_name, last_name, work_email,
          language_code, row_version, created_at, updated_at)
       SELECT gen_random_uuid(), $1, 'Person' || g, 'Perf' || g,
              'person' || g || '@' || $1 || '.perf', 'en', 1,
              now() - (g || ' hours')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g`,
      [ctx.org, have, need],
    );
  });
}

// ---------------------------------------------------------------------------
// Module role — required by module-access-roster (hasModuleRoles fixture flag)
// ---------------------------------------------------------------------------

async function seedModuleRole(ctx) {
  await sql.unsafe(
    `INSERT INTO org_modules (org_id, module_key, enabled, enabled_at)
     VALUES ($1, 'hr', true, now())
     ON CONFLICT DO NOTHING`,
    [ctx.org],
  );
  const role = await one(
    `INSERT INTO roles (org_id, name, slug, module_key, is_system, rank, created_at, updated_at)
     VALUES ($1, 'HR Admin', 'HR_ADMIN', 'hr', true, 40, now(), now())
     ON CONFLICT DO NOTHING RETURNING id`,
    [ctx.org],
  );
  const roleId = role?.id ?? (await one(`SELECT id FROM roles WHERE org_id = $1 AND module_key = 'hr' ORDER BY id LIMIT 1`, [ctx.org]))?.id;
  if (!roleId) throw new Error("no role with module_key for org");
  await topUp(`${ctx.label} role_assignments`, "role_assignments", "org_id = $1 AND role_id = $2", [ctx.org, roleId], Math.min(5, ctx.memberCount), async () => {
    await sql.unsafe(
      `INSERT INTO role_assignments (org_id, organization_membership_id, role_id, created_at)
       SELECT $1, m.id, $2::int, now()
       FROM (SELECT id FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 5) m
       ON CONFLICT DO NOTHING`,
      [ctx.org, roleId],
    );
  });
}

// ---------------------------------------------------------------------------
// Finance core — required by clients-list, invoices-open, purchase-bills-list, gl-journals-list
// ---------------------------------------------------------------------------

async function seedFinanceCore(ctx) {
  const clientsWant = Math.max(30, scaled(BASE.clients, ctx.weight, SCALE));
  await topUp(`${ctx.label} clients`, "clients", "org_id = $1", [ctx.org], clientsWant, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO clients (org_id, name, status, health_score, health_status, converted_at, created_at, updated_at)
       SELECT $1, 'Client ' || g,
              (ARRAY['active','inactive'])[1 + (g % 2)],
              50 + (g % 50), 'healthy'::crm_health, now() - (g || ' days')::interval,
              now() - (g || ' hours')::interval, now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need],
    );
  });

  const invoicesWant = Math.max(30, scaled(BASE.invoices, ctx.weight, SCALE));
  await topUp(`${ctx.label} invoices`, "invoices", "org_id = $1", [ctx.org], invoicesWant, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO invoices
         (org_id, invoice_number, status, subtotal, tax_rate, tax_amount, discount, total,
          currency, due_date, created_by, created_at, updated_at,
          amount_paid, exchange_rate, reverse_charge, tax_inclusive,
          cgst_amount, sgst_amount, igst_amount, is_recurring)
       SELECT $1, 'INV-' || $1 || '-' || g,
              (ARRAY['DRAFT','SENT','OVERDUE','PARTIALLY_PAID'])[1 + (g % 4)]::invoice_status,
              10000, 18, 1800, 0, 11800, 'INR',
              (CURRENT_DATE + ((g % 30) || ' days')::interval)::date,
              $4, now() - (g || ' hours')::interval, now(),
              0, 1, false, false, 0, 0, 0, false
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, ctx.userId],
    );
  });

  const billsWant = Math.max(30, scaled(BASE.purchaseBills, ctx.weight, SCALE));
  await topUp(`${ctx.label} purchase_bills`, "purchase_bills", "org_id = $1", [ctx.org], billsWant, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO purchase_bills
         (org_id, bill_number, bill_date, status, subtotal, tax_amount,
          cgst_amount, sgst_amount, igst_amount, discount, total, amount_paid,
          currency, reverse_charge, created_by, created_at, updated_at, exchange_rate)
       SELECT $1, 'BILL-' || $1 || '-' || g,
              (CURRENT_DATE - ((g % 90) || ' days')::interval)::date,
              (ARRAY['DRAFT','PENDING','OVERDUE','PARTIALLY_PAID'])[1 + (g % 4)],
              8000, 1440, 0, 0, 1440, 0, 9440, 0, 'INR', false,
              $4, now() - (g || ' hours')::interval, now(), 1
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, have, need, ctx.userId],
    );
  });

  const bookId = `book-perf-${ctx.label}`;
  const fyId = `fy-perf-${ctx.label}`;
  const periodId = `period-perf-${ctx.label}`;
  await sql.unsafe(
    `INSERT INTO gl_books (id, org_id, name, country_code, base_currency, localization_pack)
     VALUES ($1, $2, 'Main Ledger', 'IN', 'INR', 'IN') ON CONFLICT (id) DO NOTHING`,
    [bookId, ctx.org],
  ).catch((e) => log(`  ${ctx.label} gl_books: ${e.message}`));
  await sql.unsafe(
    `INSERT INTO gl_fiscal_years (id, org_id, book_id, name, starts_on, ends_on, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'FY 2026', '2026-01-01', '2026-12-31', 'OPEN', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [fyId, ctx.org, bookId],
  ).catch((e) => log(`  ${ctx.label} gl_fiscal_years: ${e.message}`));
  await sql.unsafe(
    `INSERT INTO gl_periods (id, org_id, book_id, fiscal_year_id, name, starts_on, ends_on, sequence, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, '2026-01', '2026-01-01', '2026-01-31', 1, 'OPEN', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [periodId, ctx.org, bookId, fyId],
  ).catch((e) => log(`  ${ctx.label} gl_periods: ${e.message}`));

  const journalsWant = Math.max(30, scaled(BASE.glJournals, ctx.weight, SCALE));
  const bookReady = (await sql.unsafe(`SELECT 1 FROM gl_periods WHERE id = $1 AND org_id = $2 LIMIT 1`, [periodId, ctx.org]).catch(() => [])).length > 0;
  if (!bookReady) { log(`  ${ctx.label} gl_journals: period missing — skipping`); return; }
  await topUp(`${ctx.label} gl_journals`, "gl_journals", "org_id = $1", [ctx.org], journalsWant, async (have, need) => {
    await sql.unsafe(
      `INSERT INTO gl_journals
         (id, org_id, book_id, period_id, journal_number, journal_date, memo, source_type, idempotency_key)
       SELECT 'jnl-' || $5 || '-' || g, $1, $2, $3,
              'JNL-' || $5 || '-' || lpad(g::text, 6, '0'),
              (CURRENT_DATE - ((g % 365) || ' days')::interval)::date,
              'Perf seed journal', 'manual',
              'perf-jnl-' || $5 || '-' || g
       FROM generate_series($4::int + 1, $4::int + $6::int) g
       ON CONFLICT DO NOTHING`,
      [ctx.org, bookId, periodId, have, ctx.label, need],
    );
  });
}

// ---------------------------------------------------------------------------

const TOUCHED = [
  "organizations", "users", "organization_members", "organization_people",
  "org_modules", "roles", "role_assignments",
  "business_parties", "contacts", "leads", "deals", "lead_party_map", "contact_party_map",
  "clients", "invoices", "purchase_bills",
  "gl_books", "gl_fiscal_years", "gl_periods", "gl_journals",
  "inv_vendors", "inv_warehouses", "inv_locations", "inv_products", "inv_product_variants",
  "inv_stock_levels", "inv_stock_transactions", "inv_purchase_orders",
  "build.projects", "build.project_statuses", "build.sprints",
  "build.project_members", "build.tickets", "build.ticket_assignees",
  "build.roadmap_items", "build.feedback_posts", "build.changelog_entries",
  "acc_tax_payments", "fin_reminder_policies",
  "payroll_runs", "payroll_run_employees", "payroll_line_items",
  "announcements",
  "subscriptions",
  "chat_channels", "chat_channel_members", "chat_messages", "chat_saved_messages",
  "hr_people", "hr_employments", "hr_reporting_lines", "leave_types", "leave_policies",
  "leave_requests", "leave_balances",
  "hr_leave_ledger", "attendance", "timesheets", "support_tickets", "mail_message_metadata",
  "calendar_events", "kb_spaces", "kb_page_visits",
];

/** A plan read before ANALYZE is a plan against stale statistics, which is not a plan. */
async function vacuumAnalyze() {
  log("VACUUM ANALYZE...");
  for (const t of TOUCHED) {
    await sql.unsafe(`VACUUM ANALYZE ${t}`).catch((e) => {
      failures.push({ label: `vacuum ${t}`, message: e?.message ?? String(e) });
    });
  }
  log("VACUUM ANALYZE complete.");
}

const PURGEABLE = [
  "payroll_line_items", "payroll_run_employees", "payroll_runs",
  "invoices", "purchase_bills", "clients",
  "gl_journals", "gl_periods", "gl_fiscal_years", "gl_books",
  "announcements",
  "inv_stock_transactions", "inv_stock_levels", "inv_product_variants", "inv_products",
  "inv_purchase_orders", "inv_locations", "inv_warehouses", "inv_vendors",
  "lead_party_map", "contact_party_map", "deals", "leads", "contacts", "business_parties",
  "acc_tax_payments", "fin_reminder_policies", "support_tickets", "mail_message_metadata",
];

async function purge() {
  log("Purging perf-layer rows for the four seed orgs...");
  for (const o of PERF_ORGS)
    for (const t of PURGEABLE) {
      await sql.unsafe(`DELETE FROM ${t} WHERE ${tenantColumn(t)} = $1`, [o.id]).catch(() => {});
    }
}

const SHAPE_TABLES = [
  "build.tickets", "notifications", "calendar_events", "event_attendees", "chat_messages",
  "contacts", "leads", "deals", "business_parties", "lead_party_map", "contact_party_map",
  "inv_stock_transactions", "inv_stock_levels",
  "inv_product_variants", "inv_products", "support_tickets", "attendance", "timesheets",
  "leave_requests", "mail_message_metadata", "hr_employments", "hr_people", "hr_reporting_lines",
  "kb_pages", "kb_article_chunks", "organization_members", "organization_people",
  "payroll_runs", "invoices", "purchase_bills", "gl_journals", "announcements",
];

async function reportShape() {
  console.log("\n--- TENANT SHAPE (rows per organization) ---");
  console.log([
    "table".padEnd(26),
    ...PERF_ORGS.map((o) => o.label.padStart(9)),
    "total".padStart(9),
    "majority%".padStart(10),
    "minority%".padStart(10),
  ].join(" "));
  for (const t of SHAPE_TABLES) {
    const col = tenantColumn(t);
    const per = [];
    for (const o of PERF_ORGS) per.push(await count(t, `${col} = $1`, [o.id]).catch(() => 0));
    const all = Number((await sql.unsafe(`SELECT count(*)::bigint n FROM ${t}`))[0].n);
    const majority = all > 0 ? (per[0] / all) * 100 : 0;
    const minority = all > 0 ? ((per[2] + per[3]) / all) * 100 : 0;
    console.log([
      t.padEnd(26),
      ...per.map((n) => String(n).padStart(9)),
      String(all).padStart(9),
      `${majority.toFixed(2)}%`.padStart(10),
      `${minority.toFixed(2)}%`.padStart(10),
    ].join(" "));
  }
  const orgs = Number((await sql.unsafe(`SELECT count(*)::bigint n FROM organizations`))[0].n);
  const live = await sql.unsafe(`SELECT count(*)::bigint n FROM pg_stat_user_tables WHERE n_live_tup > 0`);
  console.log(`\norganizations: ${orgs} · non-empty tables: ${live[0].n}`);
}

async function main() {
  log(`target database ${target.database} · scale ${SCALE}`);
  if (PURGE) await purge();

  for (const profile of PERF_ORGS) await section(`ensureOrg ${profile.label}`, () => ensureOrg(profile));
  for (const profile of PERF_ORGS) await section(`${profile.label} plan+onboarding`, () => seedOrgPlanAndOnboarding(profile.id, profile.label));

  for (const profile of PERF_ORGS) {
    const ctx = { org: profile.id, label: profile.label, weight: profile.weight, memberCount: 0 };
    log(`org ${ctx.label} (weight ${ctx.weight})`);
    await section(`${ctx.label} members`, () => ensureMembers(ctx, Math.max(10, scaled(BASE.members, ctx.weight, SCALE))));
    if (!ctx.membership || ctx.memberCount === 0) {
      failures.push({ label: `${ctx.label} members`, message: "no active membership — every later section would be meaningless" });
      continue;
    }
    await section(`${ctx.label} crm`, () => seedCrm(ctx));
    await section(`${ctx.label} party seam`, () => seedPartySeam(ctx));
    await section(`${ctx.label} inventory`, () => seedInventory(ctx));
    await section(`${ctx.label} build`, () => seedBuildProduct(ctx));
    await section(`${ctx.label} kb`, () => seedKb(ctx));
    await section(`${ctx.label} finance`, () => seedFinance(ctx));
    await section(`${ctx.label} finance core`, () => seedFinanceCore(ctx));
    await section(`${ctx.label} payroll`, () => seedPayroll(ctx));
    await section(`${ctx.label} chat`, () => seedChat(ctx));
    await section(`${ctx.label} hr`, () => seedHr(ctx));
    await section(`${ctx.label} leave policies`, () => seedLeavePolicies(ctx));
    await section(`${ctx.label} reporting lines`, () => seedReportingLines(ctx));
    await section(`${ctx.label} organization people`, () => seedOrganizationPeople(ctx));
    await section(`${ctx.label} module role`, () => seedModuleRole(ctx));
    await section(`${ctx.label} announcements`, () => seedAnnouncements(ctx));
    await section(`${ctx.label} calendar forward window`, () => seedCalendarForwardWindow(ctx));
    await section(`${ctx.label} support`, () => seedSupport(ctx));
    await section(`${ctx.label} mail`, () => seedMail(ctx));
  }

  await vacuumAnalyze();
  await reportShape();

  if (failures.length > 0) {
    const grouped = new Map();
    for (const f of failures) {
      const key = `${f.label}: ${f.message.slice(0, 200)}`;
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    console.log(`\nFAILURES: ${failures.length} in ${grouped.size} distinct sections`);
    for (const [k, n] of grouped) console.log(`  (x${n}) ${k}`);
    process.exitCode = 1;
  } else {
    console.log("\nAll sections completed without errors.");
  }
  log("seed-perf-scratch complete.");
}

main()
  .catch((e) => {
    console.error("SEED FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
