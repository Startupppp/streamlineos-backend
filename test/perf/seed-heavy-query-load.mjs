#!/usr/bin/env node
/**
 * Production-shaped load for the named heavy read paths — reminder, export, fanout,
 * unread, free/busy, recurrence, search/vector and dashboard.
 *
 * Layered on top of `src/scripts/seed-scratch-e2e.mjs`, which must run first: it creates the
 * organizations, users and memberships this script attaches volume to.
 *
 * Three organizations of deliberately different sizes. ANN recall and every RLS-post-filtered
 * plan look better than they are when measured on the majority tenant, so the small org exists
 * to be measured, not to pad the row count.
 *
 * Usage:
 *   SCRATCH_DATABASE_URL=<owner url> node test/perf/seed-heavy-query-load.mjs [--purge] [--scale=0.25]
 */

import postgres from "postgres";
import * as dotenv from "dotenv";
import { resolve } from "node:path";
import {
  ORG_PROFILES,
  LARGE_ORG,
  MID_ORG,
  SMALL_ORG,
  TINY_ORG,
  assertScratchTarget,
  scaled,
} from "./heavy-query-fixtures.mjs";

dotenv.config({ path: resolve(process.cwd(), ".env") });

export const PRIVATE_ANCHOR_TITLE = "Private upcoming anchor (plan fixture)";

export const UPCOMING_WINDOW_TITLE = "Upcoming window event (dashboard fixture)";

/**
 * How many org-visible, single-occurrence events every tenant keeps AHEAD of now(),
 * and how far ahead they are spread.
 *
 * `seedCalendarEvents` generates every event at `now() - ((g % 730) || ' days')`, so the
 * whole 60,025-event history of the majority tenant sits in the PAST of the moment the
 * seed ran. `DashboardPersonalService.upcomingEvents` reads `start_date >= NOW()`, so on
 * any day after the seed the only rows it can see are the 12 reminder-window events (which
 * are minutes ahead of the seed clock and expire the same hour) and the private anchor
 * (`visibility = 'private'`, no attendee row, created by the first member — deliberately
 * invisible to the fixture participant). Measured on `scratch_perf_seed` on 2026-09-04:
 * `start_date >= now()` returned exactly ONE row for the reference tenant and it was the
 * private anchor, so `dashboard-personal-calendar-events` measured an empty result set and
 * `run-read-cost-budgets.mjs` reported it vacuous — a ceiling and two plan assertions that
 * could not fail.
 *
 * The window is not a fixed set of rows, it is a fixed SHAPE: `topUp`'s predicate counts
 * only events that are still upcoming, so re-running the seed on any later day refills
 * whatever the wall clock consumed. That is what stops this from becoming the same time
 * bomb a second time — the same reasoning `dashboard-team-attendance` records for anchoring
 * its date to the seed rather than to `CURRENT_DATE`.
 */
export const UPCOMING_WINDOW_EVENTS = 60;
export const UPCOMING_WINDOW_DAYS = 180;

/**
 * The window starts a day out, not at `now()`. `seedReminderWindow` writes 12 events
 * `now() + (g % 18) minutes` ahead, and they satisfy a bare `start_date >= now()` for the
 * few minutes they exist. Counting them toward the target let the seed report a full window
 * that was two events short an hour later — the same decay this section exists to stop, one
 * layer up. Everything counted here has to survive a day.
 */
export const UPCOMING_WINDOW_MIN_LEAD_DAYS = 1;

/**
 * The post-conditions of the upcoming window, as a value rather than a side effect, so the
 * check itself is testable. Each entry is a way the window stops being able to answer an
 * "upcoming events" read while still holding rows.
 */
export function upcomingWindowDefects(row) {
  const defects = [];
  if (row.upcoming_org_events < UPCOMING_WINDOW_EVENTS)
    defects.push(`${row.upcoming_org_events} upcoming org-visible events, want ${UPCOMING_WINDOW_EVENTS}`);
  if (row.nearest_days_ahead === null) defects.push("no upcoming org-visible event at all");
  else if (row.nearest_days_ahead > 14)
    defects.push(`nearest upcoming event is ${row.nearest_days_ahead} days out`);
  if (row.recurring > 0) defects.push(`${row.recurring} of them recur`);
  return defects;
}

const SOUND_UPCOMING_WINDOW = {
  upcoming_org_events: UPCOMING_WINDOW_EVENTS,
  nearest_days_ahead: 0,
  recurring: 0,
};

/**
 * The post-conditions of the private upcoming anchor, as a value rather than as a
 * side effect, so that the check itself can be tested. Each one is a way the fixture
 * stops forcing the plan it exists to force while still existing.
 */
export function anchorDefects(row) {
  const defects = [];
  if (!row.is_private) defects.push("not private");
  if (!row.is_upcoming) defects.push("not upcoming");
  if (!row.is_single) defects.push("recurring");
  if (row.sharing_timestamp !== 1) defects.push(`${row.sharing_timestamp} events share its start_date`);
  if (row.attendees !== 0) defects.push(`${row.attendees} attendee rows`);
  return defects;
}

const SOUND_ANCHOR = {
  is_private: true,
  is_upcoming: true,
  is_single: true,
  sharing_timestamp: 1,
  attendees: 0,
};

if (process.argv.includes("--self-test")) {
  const cases = [
    ["rejects a non-scratch database", assertScratchTarget("postgres://u:p@h/neondb", []).ok, false],
    ["accepts a scratch database", assertScratchTarget("postgres://u:p@h/scratch_boot_d", []).ok, true],
    ["rejects a url equal to a live url", assertScratchTarget("postgres://u:p@h/scratch_x", ["postgres://u:p@h/scratch_x"]).ok, false],
    ["rejects an unparseable url", assertScratchTarget("nope", []).ok, false],
    ["scale never collapses a section to zero", scaled(10, 0.001) >= 1, true],
    ["scale is proportional", scaled(1000, 0.5), 500],
    ["a sound private anchor reports no defect", anchorDefects(SOUND_ANCHOR).length, 0],
    ["an anchor sharing its timestamp is reported vacuous", anchorDefects({ ...SOUND_ANCHOR, sharing_timestamp: 6 }).join(), "6 events share its start_date"],
    ["an anchor that has drifted into the past is reported vacuous", anchorDefects({ ...SOUND_ANCHOR, is_upcoming: false }).join(), "not upcoming"],
    ["an anchor that is no longer private is reported vacuous", anchorDefects({ ...SOUND_ANCHOR, is_private: false }).join(), "not private"],
    ["an attended anchor is reported vacuous", anchorDefects({ ...SOUND_ANCHOR, attendees: 2 }).join(), "2 attendee rows"],
    ["a sound upcoming window reports no defect", upcomingWindowDefects(SOUND_UPCOMING_WINDOW).length, 0],
    ["an empty upcoming window is reported vacuous", upcomingWindowDefects({ ...SOUND_UPCOMING_WINDOW, upcoming_org_events: 0, nearest_days_ahead: null }).join(), "0 upcoming org-visible events, want 60,no upcoming org-visible event at all"],
    ["an upcoming window that has drained below target is reported vacuous", upcomingWindowDefects({ ...SOUND_UPCOMING_WINDOW, upcoming_org_events: 59 }).join(), "59 upcoming org-visible events, want 60"],
    ["an upcoming window whose nearest event has drifted away is reported vacuous", upcomingWindowDefects({ ...SOUND_UPCOMING_WINDOW, nearest_days_ahead: 90 }).join(), "nearest upcoming event is 90 days out"],
    ["a recurring upcoming window is reported vacuous", upcomingWindowDefects({ ...SOUND_UPCOMING_WINDOW, recurring: 3 }).join(), "3 of them recur"],
  ];
  let failed = false;
  for (const [label, actual, wanted] of cases) {
    if (actual === wanted) console.log(`  [pass] ${label}`);
    else { console.error(`  [FAIL] ${label}: expected ${wanted}, got ${actual}`); failed = true; }
  }
  console.log(failed ? "\nSELF-TEST FAILED" : "\nSELF-TEST PASSED");
  process.exit(failed ? 1 : 0);
}

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run against NODE_ENV=production.");
  process.exit(1);
}

const URL_ = process.env.SCRATCH_DATABASE_URL;
if (!URL_) {
  console.error("SCRATCH_DATABASE_URL is required (owner role — RLS is bypassed during load).");
  process.exit(1);
}
const target = assertScratchTarget(URL_, [process.env.DATABASE_URL, process.env.APP_DATABASE_URL]);
if (!target.ok) {
  console.error(`seed-heavy-query-load: ${target.reason}`);
  process.exit(1);
}

const PURGE = process.argv.includes("--purge");
const scaleArg = process.argv.find((a) => a.startsWith("--scale="));
const SCALE = scaleArg ? Number(scaleArg.slice("--scale=".length)) : 1;
if (!Number.isFinite(SCALE) || SCALE <= 0) {
  console.error("--scale must be a positive number");
  process.exit(1);
}

const ssl = URL_.includes("sslmode=disable") ? false : "require";
const sql = postgres(URL_, { max: 1, prepare: false, ssl, onnotice: () => {} });

const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`);
const failures = [];

/** A section that throws is recorded and re-reported at exit; a warning that never fails is a lie. */
async function section(label, fn) {
  try {
    await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[${((Date.now() - started) / 1000).toFixed(1)}s] FAIL ${label}: ${message}`);
    failures.push(`${label}: ${message}`);
  }
}

const count = async (table, where, params) => {
  const rows = await sql.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return rows[0].n;
};

async function placeOrg(orgId) {
  await sql.unsafe(
    `INSERT INTO organization_placement
       (organization_id, region, cell_id, database_shard, object_storage_region, search_cluster,
        placement_version, write_fence_token, lease_expires_at, status, created_at, updated_at)
     VALUES ($1, 'primary', 'legacy-1', 'primary', 'primary', 'primary',
             1, gen_random_uuid()::text, now() + interval '24 hours', 'ACTIVE', now(), now())
     ON CONFLICT (organization_id) DO NOTHING`,
    [orgId],
  );
}

async function ensureMidOrg() {
  const [existing] = await sql.unsafe(`SELECT id FROM organizations WHERE id = $1`, [MID_ORG]);
  if (existing) return;
  const ownerUserId = "bbbbbbbb-8888-0000-0000-000000000003";
  await sql.unsafe(
    `INSERT INTO users (id, name, email, email_verified, first_name, last_name, is_active, created_at, updated_at)
     VALUES ($1, 'Perf Mid Owner', 'owner-mid@scratch-seed.test', now(), 'Perf', 'MidOwner', true, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [ownerUserId],
  );
  const [{ next_id: nextId }] = await sql.unsafe(
    `SELECT nextval('organization_members_id_seq') AS next_id`,
  );
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `INSERT INTO organizations (id, name, slug, status, owner_membership_id, created_at, updated_at)
       VALUES ($1, 'Scratch Mid Org', 'scratch-mid-org', 'ACTIVE', $2, now(), now())`,
      [MID_ORG, nextId],
    );
    await tx.unsafe(
      `INSERT INTO organization_members (id, user_id, org_id, role, is_owner, status, joined_at)
       VALUES ($1, $2, $3, 'OWNER', true, 'ACTIVE', now())`,
      [nextId, ownerUserId, MID_ORG],
    );
  });
  await placeOrg(MID_ORG);
  log(`  created mid org (owner membership ${nextId})`);
}

async function ensureTinyOrg() {
  const [existing] = await sql.unsafe(`SELECT id FROM organizations WHERE id = $1`, [TINY_ORG]);
  if (existing) return;
  const ownerUserId = "bbbbbbbb-8888-0000-0000-000000000004";
  await sql.unsafe(
    `INSERT INTO users (id, name, email, email_verified, first_name, last_name, is_active, created_at, updated_at)
     VALUES ($1, 'Perf Tiny Owner', 'owner-tiny@scratch-seed.test', now(), 'Perf', 'TinyOwner', true, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [ownerUserId],
  );
  const [{ next_id: nextId }] = await sql.unsafe(
    `SELECT nextval('organization_members_id_seq') AS next_id`,
  );
  await sql.begin(async (tx) => {
    await tx.unsafe(
      `INSERT INTO organizations (id, name, slug, status, owner_membership_id, created_at, updated_at)
       VALUES ($1, 'Scratch Tiny Org', 'scratch-tiny-org', 'ACTIVE', $2, now(), now())`,
      [TINY_ORG, nextId],
    );
    await tx.unsafe(
      `INSERT INTO organization_members (id, user_id, org_id, role, is_owner, status, joined_at)
       VALUES ($1, $2, $3, 'OWNER', true, 'ACTIVE', now())`,
      [nextId, ownerUserId, TINY_ORG],
    );
  });
  await placeOrg(TINY_ORG);
  log(`  created tiny org (owner membership ${nextId})`);
}

async function ensureMembers(orgId, label, wanted) {
  const have = await count("organization_members", "org_id = $1", [orgId]);
  if (have >= wanted) return;
  for (let i = have; i < wanted; i++) {
    const uid = `bbbbbbbb-${label.slice(0, 4).padEnd(4, "x")}-${String(i).padStart(4, "0")}-0000-000000000001`;
    await sql.unsafe(
      `INSERT INTO users (id, name, email, email_verified, first_name, last_name, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, now(), 'Perf', $4, true, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [uid, `Perf ${label} ${i}`, `perf-${label}-${i}@scratch-seed.test`, `${label}${i}`],
    );
    await sql.unsafe(
      `INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
       VALUES ($1, $2, 'MEMBER', false, 'ACTIVE', now() - ($3 || ' days')::interval)
       ON CONFLICT DO NOTHING`,
      [uid, orgId, i + 1],
    );
  }
  log(`  ${label}: members ${have} -> ${await count("organization_members", "org_id = $1", [orgId])}`);
}

async function seedCalendarEvents(orgId, label, wanted) {
  const have = await count("calendar_events", "org_id = $1", [orgId]);
  if (have >= wanted) {
    log(`  ${label}: calendar_events already ${have}`);
    return;
  }
  const [{ id: creator }] = await sql.unsafe(
    `SELECT id FROM organization_members WHERE org_id = $1 ORDER BY id LIMIT 1`,
    [orgId],
  );
  const need = wanted - have;
  // 15% recurring; half of those open-ended. start_date spans two years so that a
  // `start_date <= now()` predicate really does face the org's whole history.
  await sql.unsafe(
    `INSERT INTO calendar_events
       (org_id, title, description, location, start_date, end_date, all_day, category,
        timezone, rrule, recurrence_end, reminder_15min_sent, created_by_membership_id, visibility, color)
     SELECT $1,
            'Event ' || g,
            'Seeded description for event ' || g,
            'Room ' || (g % 40),
            now() - ((g % 730) || ' days')::interval + ((g % 24) || ' hours')::interval,
            now() - ((g % 730) || ' days')::interval + ((g % 24) || ' hours')::interval + interval '45 minutes',
            false,
            (ARRAY['meeting','review','interview','standup'])[1 + (g % 4)],
            'UTC',
            CASE WHEN g % 7 = 0 THEN 'FREQ=WEEKLY;INTERVAL=1' ELSE NULL END,
            CASE WHEN g % 7 = 0 AND g % 14 = 0 THEN now() + interval '400 days' ELSE NULL END,
            (g % 3 <> 0),
            $2::int,
            CASE WHEN g % 11 = 0 THEN 'private' ELSE 'org' END,
            '#4f46e5'
     FROM generate_series($3::int + 1, $3::int + $4::int) g`,
    [orgId, creator, have, need],
  );
  log(`  ${label}: calendar_events ${have} -> ${await count("calendar_events", "org_id = $1", [orgId])}`);
}

/** A handful of events inside the sweep's 20-minute window, so the reminder path has candidates. */
async function seedReminderWindow(orgId, label) {
  const due = await count(
    "calendar_events",
    "org_id = $1 AND reminder_15min_sent = false AND all_day = false AND rrule IS NULL AND start_date >= now() AND start_date <= now() + interval '20 minutes'",
    [orgId],
  );
  if (due >= 12) return;
  const [{ id: creator }] = await sql.unsafe(
    `SELECT id FROM organization_members WHERE org_id = $1 ORDER BY id LIMIT 1`,
    [orgId],
  );
  await sql.unsafe(
    `INSERT INTO calendar_events
       (org_id, title, start_date, end_date, all_day, category, timezone, rrule,
        reminder_15min_sent, created_by_membership_id, visibility)
     SELECT $1, 'Due soon ' || g,
            now() + ((g % 18) || ' minutes')::interval,
            now() + ((g % 18) + 30 || ' minutes')::interval,
            false, 'meeting', 'UTC', NULL, false, $2::int, 'org'
     FROM generate_series(1, $3::int) g`,
    [orgId, creator, 12 - due],
  );
  log(`  ${label}: reminder-window events -> 12`);
}

/**
 * The forward half of the tenant's calendar. See `UPCOMING_WINDOW_EVENTS`.
 *
 * `topUp`-shaped: the count predicate is the same predicate the dashboard read issues
 * (`start_date >= now()`), so a window that time has drained is refilled and a window that
 * is already full costs one COUNT. The events are `org`-visible and single-occurrence
 * because that is the arm of `DashboardPersonalService.upcomingEvents` a tenant's ordinary
 * traffic exercises; the private anchor next to it still holds the non-'org' arm open.
 */
async function seedUpcomingWindow(orgId, label) {
  const have = await count(
    "calendar_events",
    "org_id = $1 AND visibility = 'org' AND rrule IS NULL" +
      ` AND start_date >= now() + interval '${UPCOMING_WINDOW_MIN_LEAD_DAYS} days'` +
      ` AND start_date <= now() + interval '${UPCOMING_WINDOW_DAYS} days'`,
    [orgId],
  );
  if (have < UPCOMING_WINDOW_EVENTS) {
    const [creatorRow] = await sql.unsafe(
      `SELECT id FROM organization_members WHERE org_id = $1 ORDER BY id LIMIT 1`,
      [orgId],
    );
    if (!creatorRow) throw new Error(`${label}: no organization_members row to author upcoming events`);
    await sql.unsafe(
      `INSERT INTO calendar_events
         (org_id, title, description, location, start_date, end_date, all_day, category,
          timezone, rrule, recurrence_end, reminder_15min_sent, created_by_membership_id,
          visibility, color)
       SELECT $1, $2 || ' ' || g, 'Keeps the upcoming-events read non-vacuous', 'Room ' || (g % 40),
              now() + ((g % $5::int) + $6::int || ' days')::interval + ((g % 9) || ' hours')::interval,
              now() + ((g % $5::int) + $6::int || ' days')::interval + ((g % 9) || ' hours')::interval + interval '45 minutes',
              false, (ARRAY['meeting','review','interview','standup'])[1 + (g % 4)],
              'UTC', NULL, NULL, false, $3::int, 'org', '#0ea5e9'
       FROM generate_series(1, $4::int) g`,
      [orgId, UPCOMING_WINDOW_TITLE, creatorRow.id, UPCOMING_WINDOW_EVENTS - have,
       UPCOMING_WINDOW_DAYS - UPCOMING_WINDOW_MIN_LEAD_DAYS, UPCOMING_WINDOW_MIN_LEAD_DAYS],
    );
  }

  const [check] = await sql.unsafe(
    `SELECT count(*)::int AS upcoming_org_events,
            count(*) FILTER (WHERE rrule IS NOT NULL)::int AS recurring,
            min(EXTRACT(EPOCH FROM (start_date - now())) / 86400)::int AS nearest_days_ahead
     FROM calendar_events
     WHERE org_id = $1 AND visibility = 'org' AND rrule IS NULL
       AND start_date >= now() + interval '${UPCOMING_WINDOW_MIN_LEAD_DAYS} days'
       AND start_date <= now() + interval '${UPCOMING_WINDOW_DAYS} days'`,
    [orgId],
  );
  const defects = upcomingWindowDefects(check ?? { upcoming_org_events: 0, nearest_days_ahead: null, recurring: 0 });
  if (defects.length > 0)
    throw new Error(`${label}: upcoming window is not usable — ${defects.join("; ")}`);
  log(`  ${label}: upcoming org events ${have} -> ${check.upcoming_org_events} (nearest +${check.nearest_days_ahead}d)`);
}

/**
 * One private, upcoming, non-recurring event at a timestamp no other event of the
 * tenant shares — per tenant, including the tiny one.
 *
 * Report 22d could not pin `GET /dashboard/personal`'s attendee plan because the
 * branch it guards is only reached when a NON-'org' event lands inside the window.
 * On this seed every private event shares its start_date with five or six 'org' ones,
 * the index returns the 'org' rows first, and the SubPlan reads `never executed`; the
 * two minority tenants had no upcoming private event at all. So the same query measured
 * 6 blocks on one run and 1,140 on the next, and which one you got moved with the wall
 * clock as events passed now(). This is that fixture.
 *
 * `GREATEST(now(), max(start_date)) + a distinctive offset` makes both invariants hold
 * by construction rather than by luck: strictly later than every existing event, so the
 * timestamp is unique AND the event is upcoming. It carries no attendee row, so the
 * caller-attendance arm is genuinely evaluated rather than short-circuited.
 *
 * The post-conditions are checked, not assumed: a fixture that silently stops being
 * private, upcoming, alone at its timestamp or unattended stops forcing the plan it
 * exists to force, and every measurement downstream would quietly go back to a coin toss.
 */
async function seedPrivateUpcomingAnchor(orgId, label) {
  const [creatorRow] = await sql.unsafe(
    `SELECT id FROM organization_members WHERE org_id = $1 ORDER BY id LIMIT 1`,
    [orgId],
  );
  if (!creatorRow) throw new Error(`no organization_members row for ${label}`);

  const have = await count(
    "calendar_events",
    "org_id = $1 AND title = $2",
    [orgId, PRIVATE_ANCHOR_TITLE],
  );
  if (have === 0) {
    await sql.unsafe(
      `INSERT INTO calendar_events
         (org_id, title, description, start_date, end_date, all_day, category, timezone,
          rrule, recurrence_end, reminder_15min_sent, created_by_membership_id, visibility, color)
       SELECT $1, $2, 'Anchors the non-org visibility branch at a timestamp nothing else shares',
              anchor, anchor + interval '45 minutes', false, 'meeting', 'UTC',
              NULL, NULL, true, $3::int, 'private', '#dc2626'
       FROM (SELECT GREATEST(now(), COALESCE((SELECT max(start_date) FROM calendar_events WHERE org_id = $1), now()))
                    + interval '400 days 7 hours 13 minutes 11 seconds' AS anchor) a`,
      [orgId, PRIVATE_ANCHOR_TITLE, creatorRow.id],
    );
  }

  const [check] = await sql.unsafe(
    `SELECT e.id, e.start_date,
            (e.visibility <> 'org') AS is_private,
            (e.start_date > now()) AS is_upcoming,
            (e.rrule IS NULL) AS is_single,
            (SELECT count(*)::int FROM calendar_events o
              WHERE o.org_id = e.org_id AND o.start_date = e.start_date) AS sharing_timestamp,
            (SELECT count(*)::int FROM event_attendees a WHERE a.org_id = e.org_id AND a.event_id = e.id) AS attendees
     FROM calendar_events e
     WHERE e.org_id = $1 AND e.title = $2
     ORDER BY e.id LIMIT 1`,
    [orgId, PRIVATE_ANCHOR_TITLE],
  );

  if (!check) throw new Error(`${label}: private upcoming anchor was not created`);
  const defects = anchorDefects(check);
  if (defects.length > 0)
    throw new Error(`${label}: private upcoming anchor is vacuous — ${defects.join(", ")}`);

  log(`  ${label}: private upcoming anchor id=${check.id} at ${new Date(check.start_date).toISOString()} (alone at its timestamp, unattended)`);
}

async function seedAttendees(orgId, label, perEvent) {
  const have = await count("event_attendees", "org_id = $1", [orgId]);
  const events = await count("calendar_events", "org_id = $1", [orgId]);
  if (have >= events * perEvent * 0.9) {
    log(`  ${label}: event_attendees already ${have}`);
    return;
  }
  await sql.unsafe(
    `INSERT INTO event_attendees (org_id, event_id, membership_id, status)
     SELECT $1, e.id, m.id,
            (ARRAY['pending','accepted','declined'])[1 + ((e.id + m.id) % 3)]
     FROM calendar_events e
     JOIN LATERAL (
       SELECT id FROM organization_members
       WHERE org_id = $1 AND status = 'ACTIVE'
       ORDER BY ((id * 7 + e.id) % 10007)
       LIMIT $2::int
     ) m ON true
     WHERE e.org_id = $1
     ON CONFLICT DO NOTHING`,
    [orgId, perEvent],
  );
  // A large recurring meeting is what makes the reminder fan-out page loop run more than once.
  await sql.unsafe(
    `INSERT INTO event_attendees (org_id, event_id, membership_id, status)
     SELECT $1, e.id, m.id, 'accepted'
     FROM calendar_events e
     CROSS JOIN organization_members m
     WHERE e.org_id = $1 AND m.org_id = $1 AND m.status = 'ACTIVE'
       AND e.reminder_15min_sent = false AND e.rrule IS NULL
       AND e.start_date >= now() AND e.start_date <= now() + interval '20 minutes'
     ON CONFLICT DO NOTHING`,
    [orgId],
  );
  log(`  ${label}: event_attendees ${have} -> ${await count("event_attendees", "org_id = $1", [orgId])}`);
}

async function seedExceptions(orgId, label, wanted) {
  const have = await count("calendar_event_exceptions", "org_id = $1", [orgId]);
  if (have >= wanted) return;
  await sql.unsafe(
    `INSERT INTO calendar_event_exceptions
       (org_id, event_id, occurrence_start, is_cancelled, modified_title, modified_start, modified_end)
     SELECT $1, e.id,
            e.start_date + ((g * 7) || ' days')::interval,
            (g % 5 = 0),
            CASE WHEN g % 3 = 0 THEN 'Moved: ' || e.title ELSE NULL END,
            CASE WHEN g % 3 = 0 THEN e.start_date + ((g * 7) || ' days')::interval + interval '30 minutes' ELSE NULL END,
            CASE WHEN g % 3 = 0 THEN e.start_date + ((g * 7) || ' days')::interval + interval '90 minutes' ELSE NULL END
     FROM (SELECT id, start_date, title FROM calendar_events WHERE org_id = $1 AND rrule IS NOT NULL ORDER BY id LIMIT $2::int) e
     CROSS JOIN generate_series(1, 4) g
     ON CONFLICT DO NOTHING`,
    [orgId, Math.ceil(wanted / 4)],
  );
  log(`  ${label}: calendar_event_exceptions ${have} -> ${await count("calendar_event_exceptions", "org_id = $1", [orgId])}`);
}

async function seedNotifications(orgId, label, wanted) {
  const have = await count("notifications", "org_id = $1", [orgId]);
  if (have >= wanted) {
    log(`  ${label}: notifications already ${have}`);
    return;
  }
  const need = wanted - have;
  const CHUNK = 50000;
  for (let done = 0; done < need; done += CHUNK) {
    const batch = Math.min(CHUNK, need - done);
    await sql.unsafe(
      `INSERT INTO notifications
         (org_id, user_id, membership_id, type, priority, category, source_module, event_key,
          entity_type, entity_id, title, message, link, is_read, pinned, metadata, channel,
          archived_at, deleted_at, created_at, updated_at)
       SELECT $1, m.user_id, m.id,
              'INFO'::notification_type,
              (ARRAY['LOW','NORMAL','HIGH'])[1 + (g % 3)]::notification_priority,
              (ARRAY['SYSTEM','WORKFLOW','PROJECTS'])[1 + (g % 3)]::notification_category,
              CASE WHEN g % 9 = 0 THEN 'broadcast' ELSE 'build' END,
              (ARRAY['build.ticket.assigned','chat.mention','calendar.reminder'])[1 + (g % 3)],
              'ticket', (g % 5000)::text,
              'Notification ' || g,
              'Seeded notification body for row ' || g,
              '/notifications',
              (g % 10 <> 0),
              (g % 97 = 0),
              jsonb_build_object('seq', g, 'note', 'perf seed'),
              'IN_APP',
              CASE WHEN g % 23 = 0 THEN now() - ((g % 200) || ' days')::interval ELSE NULL END,
              CASE WHEN g % 51 = 0 THEN now() - ((g % 200) || ' days')::interval ELSE NULL END,
              now() - ((g % 330) || ' days')::interval - ((g % 1440) || ' minutes')::interval,
              now()
       FROM generate_series($2::int + 1, $2::int + $3::int) g
       JOIN LATERAL (
         SELECT id, user_id FROM organization_members
         WHERE org_id = $1 AND status = 'ACTIVE'
         ORDER BY id
         OFFSET (g % GREATEST(1, (SELECT count(*) FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE')))
         LIMIT 1
       ) m ON true`,
      [orgId, have + done, batch],
    );
  }
  log(`  ${label}: notifications ${have} -> ${await count("notifications", "org_id = $1", [orgId])}`);

  await sql.unsafe(
    `INSERT INTO notification_read_watermarks (org_id, user_id, membership_id, last_read_notification_id)
     SELECT $1, m.user_id, m.id,
            COALESCE((SELECT max(n.id) - 25 FROM notifications n WHERE n.org_id = $1 AND n.membership_id = m.id), 0)
     FROM organization_members m
     WHERE m.org_id = $1 AND m.status = 'ACTIVE'
     ON CONFLICT (org_id, membership_id) DO NOTHING`,
    [orgId],
  );
}

async function seedFanoutTargets(orgId, label) {
  const have = await count("roles", "org_id = $1 AND slug LIKE 'PERF_%'", [orgId]);
  if (have === 0) {
    await sql.unsafe(
      `INSERT INTO roles (org_id, name, slug, is_system, module_key, rank)
       SELECT $1, 'Perf Role ' || g, 'PERF_ROLE_' || g, false, 'build', 40
       FROM generate_series(1, 3) g
       ON CONFLICT DO NOTHING`,
      [orgId],
    );
  }
  const roles = await sql.unsafe(
    `SELECT id FROM roles WHERE org_id = $1 AND slug LIKE 'PERF_%' ORDER BY id`,
    [orgId],
  );
  if (roles.length === 0) return;
  // One in five members carries the first perf role — a selective semi-join branch.
  await sql.unsafe(
    `INSERT INTO role_assignments (org_id, organization_membership_id, role_id)
     SELECT $1, m.id, $2::int
     FROM organization_members m
     WHERE m.org_id = $1 AND m.status = 'ACTIVE' AND (m.id % 5) = 0
     ON CONFLICT DO NOTHING`,
    [orgId, roles[0].id],
  );

  const broadcasts = await count("broadcasts", "org_id = $1 AND title LIKE 'Perf broadcast%'", [orgId]);
  if (broadcasts === 0) {
    const [{ user_id: creator }] = await sql.unsafe(
      `SELECT user_id FROM organization_members WHERE org_id = $1 ORDER BY id LIMIT 1`,
      [orgId],
    );
    await sql.unsafe(
      `INSERT INTO broadcasts (org_id, title, message, audience, audience_type, status, created_by)
       VALUES ($1, 'Perf broadcast roles', 'seeded', '{"type":"roles"}'::jsonb, 'roles', 'DRAFT', $2)`,
      [orgId, creator],
    );
  }
  const [bc] = await sql.unsafe(
    `SELECT id FROM broadcasts WHERE org_id = $1 AND title LIKE 'Perf broadcast%' ORDER BY id LIMIT 1`,
    [orgId],
  );
  if (bc)
    await sql.unsafe(
      `INSERT INTO broadcast_audience_targets (org_id, broadcast_id, kind, target_id)
       VALUES ($1, $2::int, 'ROLE', $3)
       ON CONFLICT DO NOTHING`,
      [orgId, bc.id, String(roles[0].id)],
    );
  log(`  ${label}: fanout targets ready (roles ${roles.length})`);
}

async function seedKbPages(orgId, label, wantedPages) {
  const have = await count("kb_pages", "org_id = $1", [orgId]);
  if (have >= wantedPages) return;
  await sql.unsafe(
    `INSERT INTO kb_spaces (org_id, name, slug, audience, created_at, updated_at)
     VALUES ($1, 'Perf Space', 'perf-space-' || substr($1, 1, 8), 'internal', now(), now())
     ON CONFLICT DO NOTHING`,
    [orgId],
  );
  const [space] = await sql.unsafe(
    `SELECT id FROM kb_spaces WHERE org_id = $1 ORDER BY id LIMIT 1`,
    [orgId],
  );
  if (!space) return;
  const [member] = await sql.unsafe(
    `SELECT id, user_id FROM organization_members WHERE org_id = $1 ORDER BY id LIMIT 1`,
    [orgId],
  );
  await sql.unsafe(
    `INSERT INTO kb_pages (org_id, space_id, title, content, status, visibility, sort_order,
                           created_by_id, created_by_membership_id, last_edited_by_id,
                           last_edited_by_membership_id, created_at, updated_at)
     SELECT $1, $2::int, 'Perf Page ' || g, '{}'::jsonb, 'published', 'org', g, $3, $4::int, $3, $4::int,
            now() - (g || ' hours')::interval, now() - (g || ' minutes')::interval
     FROM generate_series($5::int + 1, $6::int) g`,
    [orgId, space.id, member.user_id, member.id, have, wantedPages],
  );
  log(`  ${label}: kb_pages ${have} -> ${await count("kb_pages", "org_id = $1", [orgId])}`);
}

async function seedChunks(orgId, label, wanted) {
  const have = await count("kb_article_chunks", "org_id = $1", [orgId]);
  if (have >= wanted) {
    log(`  ${label}: kb_article_chunks already ${have}`);
    return;
  }
  const [member] = await sql.unsafe(
    `SELECT id FROM organization_members WHERE org_id = $1 ORDER BY id LIMIT 1`,
    [orgId],
  );
  const need = wanted - have;
  const CHUNK = 2000;
  for (let done = 0; done < need; done += CHUNK) {
    const batch = Math.min(CHUNK, need - done);
    await sql.unsafe(
      `INSERT INTO kb_article_chunks
         (org_id, page_id, source, chunk_index, content, embedding, embedding_model,
          page_visibility, page_created_by_membership_id, acl_revision, content_revision, content_hash)
       SELECT $1, p.id, 'page', g,
              'Seeded knowledge chunk ' || g || ' for page ' || p.id ||
                '. Retrieval corpus filler text repeated to give the row a realistic width.',
              (SELECT ('[' || string_agg((random() + 0 * (s.i + g))::real::text, ',') || ']')::vector
                 FROM generate_series(1, 1536) s(i)),
              'text-embedding-3-small', 'org', $2::int, 1, 1,
              md5($1 || ':' || p.id || ':' || g)
       FROM generate_series($3::int + 1, $3::int + $4::int) g
       JOIN LATERAL (
         SELECT id FROM kb_pages
         WHERE org_id = $1 AND deleted_at IS NULL
         ORDER BY id
         OFFSET (g % GREATEST(1, (SELECT count(*) FROM kb_pages WHERE org_id = $1 AND deleted_at IS NULL)))
         LIMIT 1
       ) p ON true
       ON CONFLICT DO NOTHING`,
      [orgId, member.id, have + done, batch],
    );
    log(`    ${label}: chunks +${batch}`);
  }
  log(`  ${label}: kb_article_chunks ${have} -> ${await count("kb_article_chunks", "org_id = $1", [orgId])}`);
}

async function purge() {
  log("Purging perf load...");
  for (const { id } of ORG_PROFILES) {
    await sql.unsafe(`DELETE FROM kb_article_chunks WHERE org_id = $1`, [id]);
    await sql.unsafe(`DELETE FROM event_attendees WHERE org_id = $1`, [id]);
    await sql.unsafe(`DELETE FROM calendar_event_exceptions WHERE org_id = $1`, [id]);
    await sql.unsafe(`DELETE FROM calendar_events WHERE org_id = $1`, [id]);
    await sql.unsafe(`DELETE FROM notification_read_watermarks WHERE org_id = $1`, [id]);
    await sql.unsafe(`DELETE FROM notifications WHERE org_id = $1`, [id]);
    await sql.unsafe(`DELETE FROM broadcast_audience_targets WHERE org_id = $1`, [id]);
    await sql.unsafe(`DELETE FROM broadcasts WHERE org_id = $1 AND title LIKE 'Perf broadcast%'`, [id]);
    await sql.unsafe(
      `DELETE FROM role_assignments WHERE org_id = $1 AND role_id IN (SELECT id FROM roles WHERE org_id = $1 AND slug LIKE 'PERF_%')`,
      [id],
    );
    await sql.unsafe(`DELETE FROM roles WHERE org_id = $1 AND slug LIKE 'PERF_%'`, [id]);
  }
  log("Purge complete.");
}

const VACUUM_TABLES = [
  "calendar_events",
  "calendar_event_exceptions",
  "event_attendees",
  "notifications",
  "notification_read_watermarks",
  "kb_article_chunks",
  "kb_pages",
  "organization_members",
  "role_assignments",
  "broadcast_audience_targets",
];

async function main() {
  await sql`SET statement_timeout = 0`;
  log(`target database ${target.database} · scale ${SCALE}`);

  if (PURGE) await purge();

  await section("mid org", ensureMidOrg);
  await section("tiny org", ensureTinyOrg);

  for (const profile of ORG_PROFILES) {
    const events = scaled(profile.events, SCALE);
    const notifications = scaled(profile.notifications, SCALE);
    const chunks = scaled(profile.chunks, SCALE);
    log(`org ${profile.label} (${profile.id.slice(0, 8)}) → events ${events} · notifications ${notifications} · chunks ${chunks}`);
    await section(`${profile.label}/members`, () => ensureMembers(profile.id, profile.label, profile.members));
    await section(`${profile.label}/calendar_events`, () => seedCalendarEvents(profile.id, profile.label, events));
    await section(`${profile.label}/reminder_window`, () => seedReminderWindow(profile.id, profile.label));
    await section(`${profile.label}/upcoming_window`, () => seedUpcomingWindow(profile.id, profile.label));
    await section(`${profile.label}/attendees`, () => seedAttendees(profile.id, profile.label, 2));
    await section(`${profile.label}/private_anchor`, () => seedPrivateUpcomingAnchor(profile.id, profile.label));
    await section(`${profile.label}/exceptions`, () => seedExceptions(profile.id, profile.label, Math.max(40, Math.round(events / 8))));
    await section(`${profile.label}/notifications`, () => seedNotifications(profile.id, profile.label, notifications));
    await section(`${profile.label}/fanout`, () => seedFanoutTargets(profile.id, profile.label));
    await section(`${profile.label}/kb_pages`, () => seedKbPages(profile.id, profile.label, Math.max(30, Math.round(chunks / 20))));
    await section(`${profile.label}/chunks`, () => seedChunks(profile.id, profile.label, chunks));
  }

  // A count or a plan read before this is read against stale statistics and an empty
  // visibility map, which is the difference between an index-only scan and a heap scan.
  log("VACUUM ANALYZE...");
  for (const t of VACUUM_TABLES) await sql.unsafe(`VACUUM ANALYZE ${t}`);
  log("VACUUM ANALYZE complete.");

  console.log("\n--- ROW COUNTS BY ORGANIZATION ---");
  const summary = await sql.unsafe(
    `SELECT o.id, o.name,
            (SELECT count(*) FROM organization_members m WHERE m.org_id = o.id) AS members,
            (SELECT count(*) FROM calendar_events e WHERE e.org_id = o.id) AS events,
            (SELECT count(*) FROM calendar_events e WHERE e.org_id = o.id AND e.rrule IS NOT NULL) AS recurring,
            (SELECT count(*) FROM event_attendees a WHERE a.org_id = o.id) AS attendees,
            (SELECT count(*) FROM calendar_event_exceptions x WHERE x.org_id = o.id) AS exceptions,
            (SELECT count(*) FROM notifications n WHERE n.org_id = o.id) AS notifications,
            (SELECT count(*) FROM notifications n WHERE n.org_id = o.id AND n.is_read = false AND n.deleted_at IS NULL AND n.archived_at IS NULL) AS unread,
            (SELECT count(*) FROM kb_article_chunks c WHERE c.org_id = o.id) AS chunks
     FROM organizations o ORDER BY 3 DESC`,
  );
  for (const r of summary)
    console.log(
      `  ${r.name.padEnd(24)} members=${String(r.members).padStart(5)} events=${String(r.events).padStart(6)}` +
        ` recur=${String(r.recurring).padStart(5)} attendees=${String(r.attendees).padStart(7)}` +
        ` exc=${String(r.exceptions).padStart(5)} notif=${String(r.notifications).padStart(7)}` +
        ` unread=${String(r.unread).padStart(6)} chunks=${String(r.chunks).padStart(6)}`,
    );
  const [totals] = await sql.unsafe(
    `SELECT (SELECT count(*) FROM kb_article_chunks) AS chunks, (SELECT count(*) FROM notifications) AS notifications`,
  );
  console.log(`  TOTAL chunks=${totals.chunks} notifications=${totals.notifications}`);
}

main()
  .then(async () => {
    await sql.end();
    if (failures.length > 0) {
      console.error(`\n${failures.length} section(s) failed:`);
      for (const f of failures) console.error(`  FAIL: ${f}`);
      process.exitCode = 1;
      return;
    }
    console.log("\nSeed complete — every section succeeded.");
  })
  .catch(async (e) => {
    await sql.end();
    console.error("SEED FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
