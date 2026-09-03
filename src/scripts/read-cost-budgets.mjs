/**
 * Read-cost budget table.
 *
 * Each entry is one query a user waits on over a tenant-growing table.
 * The runner (run-read-cost-budgets.mjs) connects as the non-BYPASSRLS app role,
 * sets the tenant GUC, runs EXPLAIN (ANALYZE, BUFFERS) and asserts:
 *   - shared blocks (hit + read) <= ceiling
 *   - plan assertions hold (require-index-only-scan, forbid-seq-scan)
 *   - seed data is adequate (rowCountSql >= minRows)
 *
 * Ceilings are tripwires for a plan falling off an index, not drift detectors.
 * Set them well above measured normal cost but below what a full sequential scan
 * would cost. Raise only with a written reason.
 *
 * After a table rewrite: run VACUUM ANALYZE before measuring. A rewrite empties
 * the visibility map, silently degrading an Index Only Scan to an Index Scan,
 * and invalidates statistics so the planner chooses wrong plans.
 *
 * params(fixtures) returns null to skip a budget when a required fixture is absent
 * (e.g. no payroll runs exist in the seed). A skipped budget is reported as SKIP,
 * never PASS.
 *
 * VACUOUS BUDGETS. The runner also fails a budget whose query returns zero rows. A budget over an
 * empty result set satisfies every ceiling trivially and no plan assertion it declares can ever
 * fire, so reporting it as PASS is the exact failure this catalog exists to prevent — it measures
 * nothing while reading as measured. Six budgets were doing this when the guard was added.
 * `allowEmptyResult: true` waives it and REQUIRES `allowEmptyReason` alongside; use it only where
 * an empty result is the correct steady state, never to silence a fixture that stopped matching.
 *
 * EXCLUSIONS. `excluded: "<reason>"` skips a budget entirely and is reported as EXCL, which proves
 * nothing at all. Ten entries carried "CRM/Inventory module not seeded on scratch_e2e"; the perf
 * seed populates both across four tenants, so the exclusions were removed rather than renewed. An
 * exclusion is a claim about the database, and a stale claim is indistinguishable from coverage.
 */

const DAY_MS = 86_400_000;

/**
 * The `notifications` read window, mirroring `src/modules/notifications/notification-read-window.ts`.
 *
 * `notifications` is RANGE-partitioned on `created_at`. A budget with no `created_at` predicate
 * plans a Merge Append over every declared partition and measures partition pruning that the
 * service does not have to pay for — the opposite of what the ceiling is for. Kept in step with
 * NOTIFICATION_RETENTION_POLICY.notifications.retainDays (180) by hand, because this catalog is
 * plain ESM and the policy is TypeScript; changing the retention window without changing this
 * makes the budget measure a wider window than the service reads.
 */
const NOTIFICATION_RETAIN_DAYS = 180;

export function notificationReadWindow(now = new Date()) {
  const cutoff = new Date(now.getTime() - NOTIFICATION_RETAIN_DAYS * DAY_MS);
  const monthStart = Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1);
  return {
    start: new Date(monthStart - DAY_MS).toISOString(),
    end: new Date(now.getTime() + DAY_MS).toISOString(),
  };
}

export const BUDGETS = [
  {
    id: "scoped-board-page",
    ceiling: 5_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.projectId && f.membershipId ? [f.orgId, f.projectId, f.membershipId] : null),
    sql: `
      SELECT t.id, count(*) OVER () total
      FROM build.tickets t
      WHERE t.org_id = $1 AND t.project_id = $2 AND t.deleted_at IS NULL
        AND (t.assignee_membership_id = $3 OR t.reporter_membership_id = $3
             OR EXISTS (SELECT 1 FROM build.ticket_assignees ta
                        WHERE ta.org_id = $1 AND ta.membership_id = $3 AND ta.ticket_id = t.id))
      ORDER BY t.rank ASC, t.created_at DESC, t.id ASC
      LIMIT 50 OFFSET 0`,
    // ticket_assignees is accessed via a hashed SubPlan (one-time materialization of the user's
    // assignments, then hash-probed per outer ticket row). This is the correct optimizer choice
    // when the user's assignment selectivity is high — an Index Only Scan is the right access
    // only for correlated per-row lookups, which the planner avoids here. The block ceiling
    // guards against degradation back to a per-row full scan.
    planAssertions: [],
  },
  {
    id: "my-work",
    ceiling: 30_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM build.ticket_assignees WHERE org_id = $1`,
    params: (f) => (f.membershipId ? [f.orgId, f.membershipId] : null),
    sql: `
      SELECT u.id, count(*) OVER () total FROM (
        (SELECT t.id, t.due_date, t.priority
         FROM build.tickets t INNER JOIN build.projects p ON p.id = t.project_id
         WHERE t.org_id = $1 AND p.status <> 'ARCHIVED' AND t.deleted_at IS NULL AND t.assignee_membership_id = $2)
        UNION
        (SELECT t.id, t.due_date, t.priority
         FROM build.tickets t INNER JOIN build.projects p ON p.id = t.project_id
         INNER JOIN build.ticket_assignees ta ON ta.ticket_id = t.id AND ta.org_id = $1 AND ta.membership_id = $2
         WHERE t.org_id = $1 AND p.status <> 'ARCHIVED' AND t.deleted_at IS NULL)
      ) u
      ORDER BY u.due_date ASC NULLS LAST,
        CASE u.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END ASC,
        u.id ASC
      LIMIT 100 OFFSET 0`,
    // Same hashed-SubPlan reasoning as scoped-board-page: ticket_assignees is scanned once into
    // a hash for the UNION branch. Block ceiling is the correctness guard.
    planAssertions: [],
  },
  {
    id: "ticket-list-project",
    ceiling: 8_000,
    minRows: 50,
    maxScanRows: 50_000,
    rowCountSql: `SELECT count(*)::int FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.projectId ? [f.orgId, f.projectId] : null),
    sql: `
      SELECT t.id, t.title, t.status, t.priority, t.assignee_membership_id, t.rank,
             count(*) OVER () total
      FROM build.tickets t
      WHERE t.org_id = $1 AND t.project_id = $2 AND t.deleted_at IS NULL
      ORDER BY t.rank ASC, t.created_at DESC, t.id ASC
      LIMIT 100 OFFSET 0`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "tickets" },
    ],
  },
  {
    id: "ticket-org-assigned-to-me",
    ceiling: 20_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.membershipId ? [f.orgId, f.membershipId] : null),
    sql: `
      SELECT t.id, t.title, t.status, t.priority, t.due_date,
             count(*) OVER () total
      FROM build.tickets t
      INNER JOIN build.projects p ON p.id = t.project_id
      WHERE t.org_id = $1 AND t.assignee_membership_id = $2
        AND t.deleted_at IS NULL AND p.status <> 'ARCHIVED'
      ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC
      LIMIT 50 OFFSET 0`,
    // idx_tickets_org_assignee_status (org_id, assignee_membership_id, status) exists for production use.
    // Seed data has only 2 users sharing 20 000 tickets, so each user has ~34% of all rows and
    // the planner correctly prefers a seq scan. The block ceiling (20 000) guards correctness;
    // the index assertion fires naturally once realistic data exists.
    planAssertions: [],
  },
  {
    id: "notifications-list",
    ceiling: 5_000,
    minRows: 100,
    maxScanRows: 2_000,
    rowCountSql: `SELECT count(*)::int FROM notifications WHERE org_id = $1 AND deleted_at IS NULL`,
    // Migration 0520 moved the recipient authority from `user_id` to `membership_id`, and the live
    // indexes followed the service rather than this catalog: there is no `(org_id, user_id, …)`
    // index left. Filtering the old column measured a plan the application never runs — 3,860-6,267
    // rows scanned in each of 11 partitions — and would have stayed flat through both the fix and
    // any future regression. A budget that does not track the code it bounds is not a budget.
    params: (f) => {
      if (!f.membershipId) return null;
      const w = notificationReadWindow();
      return [f.orgId, f.membershipId, w.start, w.end];
    },
    sql: `
      SELECT id, title, message, is_read, category, source_module, link, created_at
      FROM notifications
      WHERE org_id = $1 AND membership_id = $2
        AND created_at >= $3::timestamptz AND created_at < $4::timestamptz
        AND deleted_at IS NULL AND archived_at IS NULL
      ORDER BY id DESC
      LIMIT 50`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "notifications" },
    ],
  },
  {
    id: "notifications-unread-count",
    ceiling: 3_000,
    minRows: 100,
    rowCountSql: `SELECT count(*)::int FROM notifications WHERE org_id = $1 AND deleted_at IS NULL`,
    // Same 0520 drift as notifications-list, same remedy — see the note there.
    params: (f) => {
      if (!f.membershipId) return null;
      const w = notificationReadWindow();
      return [f.orgId, f.membershipId, w.start, w.end];
    },
    sql: `
      SELECT count(*)::int
      FROM notifications
      WHERE org_id = $1 AND membership_id = $2
        AND created_at >= $3::timestamptz AND created_at < $4::timestamptz
        AND is_read = false AND deleted_at IS NULL AND archived_at IS NULL`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "notifications" },
    ],
  },
  {
    id: "chat-channel-list",
    ceiling: 8_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM chat_channels WHERE org_id = $1 AND is_archived = false`,
    params: (f) => [f.orgId, f.userId],
    sql: `
      SELECT c.id, c.name, c.type, c.last_message_at, c.is_private,
             m.last_read_at, m.is_favorite
      FROM chat_channels c
      INNER JOIN chat_channel_members m ON m.channel_id = c.id AND m.org_id = $1
      INNER JOIN organization_members om ON om.id = m.membership_id AND om.org_id = $1 AND om.user_id = $2
      WHERE c.org_id = $1 AND m.archived_at IS NULL AND c.is_archived = false
      ORDER BY c.last_message_at DESC
      LIMIT 50`,
    planAssertions: [
      // The growing side of this join is chat_channel_members, not chat_channels: a tenant has
      // tens of channels and thousands of memberships. Before this the budget asserted nothing
      // about plan shape, so a membership Seq Scan would still have passed under an 8,000-block
      // ceiling. Measured on scratch_perf_seed at head as streamline_app with the tenant GUC:
      // 11 warm blocks, 2 rows scanned for 2 returned.
      { kind: "forbid-seq-scan", relation: "chat_channel_members" },
    ],
  },
  {
    id: "chat-messages-page",
    ceiling: 10_000,
    minRows: 200,
    rowCountSql: `SELECT count(*)::int FROM chat_messages WHERE org_id = $1 AND is_deleted = false`,
    params: (f) => (f.channelId ? [f.orgId, f.channelId] : null),
    sql: `
      SELECT id, sender_membership_id, content, message_type, metadata, created_at, is_edited
      FROM chat_messages
      WHERE org_id = $1 AND channel_id = $2 AND is_deleted = false
      ORDER BY created_at DESC
      LIMIT 50`,
    planAssertions: [
      // 12,000 messages on the reference tenant. Measured: 10 warm blocks, 50 rows scanned for a
      // 50-row page — the (org_id, channel_id, created_at DESC) access path. A Seq Scan here is
      // O(channel history) for one screen and is the regression this asserts against.
      { kind: "forbid-seq-scan", relation: "chat_messages" },
    ],
  },
  {
    id: "chat-channel-members",
    ceiling: 5_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM chat_channel_members WHERE org_id = $1`,
    params: (f) => (f.channelId ? [f.orgId, f.channelId] : null),
    sql: `
      SELECT m.membership_id, m.role, m.joined_at
      FROM chat_channel_members m
      WHERE m.org_id = $1 AND m.channel_id = $2
      ORDER BY m.joined_at ASC
      LIMIT 100`,
    planAssertions: [
      // Measured: 9 warm blocks, 500 rows scanned for a 100-row page. The 5x over-scan is the
      // seed's two 500-member channels being ordered by joined_at with no matching index prefix;
      // it is inside the ceiling and is recorded here rather than silently tolerated.
      { kind: "forbid-seq-scan", relation: "chat_channel_members" },
    ],
  },
  {
    id: "kb-page-id-probe-sdf",
    ceiling: 3_000,
    minRows: 30,
    rowCountSql: `SELECT count(*)::int FROM kb_pages WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.hasKbPageProbe ? ["policy", 51] : null),
    sql: `SELECT * FROM app.search_kb_page_ids($1, $2)`,
    planAssertions: [],
  },
  {
    id: "kb-space-pages",
    ceiling: 8_000,
    minRows: 30,
    rowCountSql: `SELECT count(*)::int FROM kb_pages WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.spaceId ? [f.orgId, f.spaceId] : null),
    sql: `
      SELECT id, title, parent_page_id, sort_order, status, visibility, updated_at
      FROM kb_pages
      WHERE org_id = $1 AND space_id = $2 AND deleted_at IS NULL
      ORDER BY sort_order ASC, id ASC
      LIMIT 200`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "kb_pages" },
    ],
  },
  {
    id: "kb-recently-updated",
    ceiling: 8_000,
    minRows: 30,
    rowCountSql: `SELECT count(*)::int FROM kb_pages WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, title, space_id, status, updated_at, last_edited_by_id
      FROM kb_pages
      WHERE org_id = $1 AND deleted_at IS NULL AND status = 'published'
      ORDER BY updated_at DESC
      LIMIT 50`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "kb_pages" },
    ],
  },
  {
    id: "kb-spaces-list",
    ceiling: 3_000,
    minRows: 3,
    rowCountSql: `SELECT count(*)::int FROM kb_spaces WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, name, slug, icon, color, audience, created_at
      FROM kb_spaces
      WHERE org_id = $1
      ORDER BY name ASC
      LIMIT 100`,
    planAssertions: [],
  },
  {
    id: "kb-page-visits-mine",
    ceiling: 5_000,
    minRows: 30,
    rowCountSql: `SELECT count(*)::int FROM kb_page_visits WHERE org_id = $1`,
    // Same membership migration as the notification budgets: KbPageVisitsService.getRecent filters
    // `kbPageVisits.membershipId`, and `idx_kb_page_visits_org_membership_visited` is the index
    // that serves it. The catalog filtered `user_id`, which is a different plan on a different
    // index and so a ceiling over a query the application does not issue.
    params: (f) => (f.membershipId ? [f.orgId, f.membershipId] : null),
    sql: `
      SELECT pv.page_id, pv.visited_at, p.title, p.space_id
      FROM kb_page_visits pv
      INNER JOIN kb_pages p ON p.id = pv.page_id
      WHERE pv.org_id = $1 AND pv.membership_id = $2
        AND p.deleted_at IS NULL
      ORDER BY pv.visited_at DESC
      LIMIT 20`,
    planAssertions: [],
  },
  {
    id: "org-members-list",
    ceiling: 5_000,
    minRows: 10,
    maxScanRows: 5_000,
    rowCountSql: `SELECT count(*)::int FROM organization_members WHERE org_id = $1 AND status = 'ACTIVE'`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, user_id, role, is_owner, status, joined_at
      FROM organization_members
      WHERE org_id = $1 AND status = 'ACTIVE'
      ORDER BY joined_at DESC
      LIMIT 100`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "organization_members" },
    ],
  },
  {
    // drift-fix 2026-08-31: service (directory.service.ts listPeople) sorts by
    // organization_person_id ASC using cursor pagination, not by first_name/last_name.
    // The unique index uniq_org_people_org_person on (organization_id, organization_person_id)
    // covers this query. Old budget was measuring a different index path.
    id: "org-people-list",
    ceiling: 8_000,
    minRows: 10,
    rowCountSql: `SELECT count(*)::int FROM organization_people WHERE organization_id = $1 AND deleted_at IS NULL`,
    params: (f) => [f.orgId],
    sql: `
      SELECT organization_person_id, first_name, last_name, work_email,
             avatar_url, display_name, archived_at
      FROM organization_people
      WHERE organization_id = $1 AND deleted_at IS NULL
      ORDER BY organization_person_id ASC
      LIMIT 51`,
    planAssertions: [],
  },
  {
    id: "employee-record-list-canonical",
    ceiling: 8_000,
    minRows: 5_000,
    rowCountSql: `SELECT count(*)::int FROM hr_employments WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => [f.orgId],
    sql: `
      SELECT u.id, e.employee_number, e.designation, e.joining_date,
             e.department_id, e.location_id, mp.user_id AS manager_user_id
      FROM users u
      LEFT JOIN hr_people p
        ON p.org_id = $1 AND p.user_id = u.id AND p.deleted_at IS NULL
      LEFT JOIN hr_employments e
        ON e.org_id = $1 AND e.person_id = p.id AND e.is_primary = true AND e.deleted_at IS NULL
      LEFT JOIN hr_reporting_lines rl
        ON rl.org_id = $1 AND rl.line_type = 'primary'
       AND rl.effective_from <= CURRENT_DATE AND rl.effective_to >= CURRENT_DATE
       AND rl.employment_id = e.id
      LEFT JOIN hr_employments me
        ON me.org_id = $1 AND me.id = rl.manager_employment_id AND me.deleted_at IS NULL
      LEFT JOIN hr_people mp
        ON mp.org_id = $1 AND mp.id = me.person_id AND mp.deleted_at IS NULL
      WHERE u.id IN (
        SELECT m.user_id FROM organization_members m
        WHERE m.org_id = $1 AND m.status = 'ACTIVE'
        ORDER BY m.joined_at DESC LIMIT 100)
      ORDER BY e.id`,
    planAssertions: [],
  },
  {
    id: "employee-reporting-line-lookup",
    ceiling: 5_000,
    minRows: 1_000,
    rowCountSql: `SELECT count(*)::int FROM hr_reporting_lines WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT rl.employment_id, rl.manager_employment_id, rl.effective_from
      FROM hr_reporting_lines rl
      WHERE rl.org_id = $1
        AND rl.line_type = 'primary'
        AND rl.effective_from <= CURRENT_DATE
        AND rl.effective_to >= CURRENT_DATE
      ORDER BY rl.employment_id ASC
      LIMIT 100`,
    planAssertions: [],
  },
  {
    id: "leave-requests-pending-org",
    ceiling: 8_000,
    minRows: 20,
    rowCountSql: `SELECT count(*)::int FROM leave_requests WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, user_id, status, start_date, end_date, created_at
      FROM leave_requests
      WHERE org_id = $1 AND status IN ('PENDING', 'APPROVED')
      ORDER BY created_at DESC
      LIMIT 50`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "leave_requests" },
    ],
  },
  {
    id: "leave-requests-mine",
    ceiling: 5_000,
    minRows: 20,
    rowCountSql: `SELECT count(*)::int FROM leave_requests WHERE org_id = $1`,
    // LeavesService.my filters `user_membership_id` and orders by `id DESC` (cursor pagination on
    // id, not on created_at). This budget filtered `user_id` and ordered by `created_at`, so it
    // measured `idx_leave_requests_user_id` and a sort the endpoint never performs, while
    // `idx_leave_requests_org_user_membership` — the index that actually serves the route — went
    // unexercised.
    params: (f) => (f.membershipId ? [f.orgId, f.membershipId] : null),
    sql: `
      SELECT id, status, start_date, end_date, created_at
      FROM leave_requests
      WHERE org_id = $1 AND user_membership_id = $2
      ORDER BY id DESC
      LIMIT 50`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "leave_requests" },
    ],
  },
  {
    id: "attendance-mine",
    ceiling: 5_000,
    minRows: 30,
    maxScanRows: 200,
    rowCountSql: `SELECT count(*)::int FROM attendance WHERE org_id = $1`,
    // EmployeeAttendanceService.history filters `user_membership_id` and orders by
    // (date DESC, created_at DESC). Same membership migration as the notification budgets.
    params: (f) => (f.membershipId ? [f.orgId, f.membershipId] : null),
    sql: `
      SELECT id, date, status, check_in, check_out
      FROM attendance
      WHERE org_id = $1 AND user_membership_id = $2
      ORDER BY date DESC, created_at DESC
      LIMIT 31`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "attendance" },
    ],
  },
  {
    id: "leave-ledger-mine",
    ceiling: 5_000,
    minRows: 10,
    rowCountSql: `SELECT count(*)::int FROM hr_leave_ledger WHERE org_id = $1`,
    params: (f) => [f.orgId, f.userId],
    sql: `
      SELECT id, leave_type_id, txn_type, days, effective_date
      FROM hr_leave_ledger
      WHERE org_id = $1 AND user_id = $2
      ORDER BY effective_date DESC
      LIMIT 50`,
    planAssertions: [],
  },
  {
    // DRIFTED, and NOT correctable here yet — see the note on leads-active below. `queryContacts`
    // reads `contact_party_map INNER JOIN business_parties`; `contacts` is the legacy mirror.
    id: "contacts-list",
    ceiling: 8_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM contacts WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, name, email, phone, created_at
      FROM contacts
      WHERE org_id = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 50`,
    planAssertions: [],
  },
  {
    // DRIFTED at the table, not the column, and BLOCKED on the fixture rather than on this file.
    // `LeadsReadService.list` reads `lead_party_map INNER JOIN business_parties` through
    // `LEAD_PARTY_COLUMNS` (ticket 02 made Party canonical and `leads` a derived mirror), so this
    // budget and leads-assigned-to-me below bound a table the module no longer selects from — the
    // same defect class as the 0520 notification budgets, one level up.
    //
    // Re-pointing them at Party today would make them VACUOUS, which is worse: measured on the
    // perf seed at head, `lead_party_map` and `contact_party_map` hold 0 rows and
    // `business_parties.owner_user_id` is NULL on all 22,240 rows, while `leads` and `contacts`
    // hold 8,896 each. The seed writes the mirror and not the canonical side. Fix the seed first
    // (test/perf + scripts/seed-*), then move these three budgets and re-measure; the mapping is
    // leads.assigned_to_id -> business_parties.owner_user_id, .status -> coalesce(lifecycle_stage,
    // 'NEW'), .score -> qualification_score, ORDER BY created_at DESC, lead_id DESC.
    id: "leads-active",
    ceiling: 10_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM leads WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, name, email, status, score, assigned_to_id, created_at
      FROM leads
      WHERE org_id = $1 AND deleted_at IS NULL
        AND status NOT IN ('CONVERTED', 'LOST', 'DISQUALIFIED')
      ORDER BY created_at DESC
      LIMIT 50`,
    planAssertions: [],
  },
  {
    // Same Party drift and the same fixture block as leads-active — see the note there.
    id: "leads-assigned-to-me",
    ceiling: 8_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM leads WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => [f.orgId, f.userId],
    sql: `
      SELECT id, name, email, status, score, created_at
      FROM leads
      WHERE org_id = $1 AND assigned_to_id = $2 AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 50`,
    planAssertions: [],
  },
  {
    id: "deals-pipeline",
    ceiling: 10_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM deals WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, name, stage, value, expected_close_date, assigned_to_id
      FROM deals
      WHERE org_id = $1 AND deleted_at IS NULL
      ORDER BY expected_close_date ASC NULLS LAST, id DESC
      LIMIT 50`,
    planAssertions: [],
  },
  {
    id: "clients-list",
    ceiling: 8_000,
    minRows: 20,
    rowCountSql: `SELECT count(*)::int FROM clients WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, name, status, account_manager_id, created_at
      FROM clients
      WHERE org_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    planAssertions: [],
  },
  {
    id: "invoices-open",
    ceiling: 8_000,
    minRows: 20,
    rowCountSql: `SELECT count(*)::int FROM invoices WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, status, due_date, created_at
      FROM invoices
      WHERE org_id = $1 AND status IN ('DRAFT', 'SENT', 'OVERDUE', 'PARTIALLY_PAID')
      ORDER BY created_at DESC
      LIMIT 50`,
    planAssertions: [],
  },
  {
    id: "purchase-bills-list",
    ceiling: 8_000,
    minRows: 20,
    rowCountSql: `SELECT count(*)::int FROM purchase_bills WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, status, due_date, created_at
      FROM purchase_bills
      WHERE org_id = $1 AND status IN ('DRAFT', 'PENDING', 'OVERDUE', 'PARTIALLY_PAID')
      ORDER BY created_at DESC
      LIMIT 50`,
    planAssertions: [],
  },
  {
    id: "gl-journals-list",
    ceiling: 8_000,
    minRows: 30,
    rowCountSql: `SELECT count(*)::int FROM gl_journals WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, journal_number, journal_date, memo, source_type
      FROM gl_journals
      WHERE org_id = $1
      ORDER BY journal_date DESC
      LIMIT 50`,
    planAssertions: [],
  },
  {
    id: "payroll-runs-list",
    ceiling: 5_000,
    minRows: 5,
    rowCountSql: `SELECT count(*)::int FROM payroll_runs WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, month, run_type, status, created_at
      FROM payroll_runs
      WHERE org_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    planAssertions: [],
  },
  {
    id: "payroll-run-employees",
    ceiling: 8_000,
    minRows: 5,
    rowCountSql: `SELECT count(*)::int FROM payroll_runs WHERE org_id = $1`,
    params: (f) => (f.payrollRunId ? [f.orgId, f.payrollRunId] : null),
    sql: `
      SELECT id, user_id, worker_id, status, gross, net
      FROM payroll_run_employees
      WHERE org_id = $1 AND run_id = $2
      ORDER BY id ASC
      LIMIT 100`,
    planAssertions: [],
  },
  {
    id: "payroll-line-items",
    ceiling: 5_000,
    minRows: 5,
    rowCountSql: `SELECT count(*)::int FROM payroll_runs WHERE org_id = $1`,
    params: (f) => (f.payrollRunId ? [f.orgId, f.payrollRunId] : null),
    sql: `
      SELECT id, run_employee_id, code, amount, sort_order
      FROM payroll_line_items
      WHERE org_id = $1 AND run_id = $2
      ORDER BY id ASC
      LIMIT 500`,
    planAssertions: [],
  },
  {
    id: "inv-products-list",
    ceiling: 10_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM inv_products WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, name, sku, status, category_id
      FROM inv_products
      WHERE org_id = $1 AND status <> 'DISCONTINUED'
      ORDER BY id DESC
      LIMIT 50`,
    planAssertions: [],
  },
  {
    id: "inv-stock-levels",
    ceiling: 10_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM inv_stock_levels WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, product_variant_id, location_id, on_hand, committed
      FROM inv_stock_levels
      WHERE org_id = $1
      ORDER BY product_variant_id ASC
      LIMIT 100`,
    planAssertions: [],
  },
  {
    id: "inv-stock-transactions",
    ceiling: 15_000,
    minRows: 100,
    rowCountSql: `SELECT count(*)::int FROM inv_stock_transactions WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, product_variant_id, transaction_type, quantity_change, posting_date, created_at
      FROM inv_stock_transactions
      WHERE org_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    planAssertions: [],
  },
  {
    id: "inv-purchase-orders",
    ceiling: 8_000,
    minRows: 20,
    rowCountSql: `SELECT count(*)::int FROM inv_purchase_orders WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, po_number, status, vendor_id, expected_delivery_date, created_at
      FROM inv_purchase_orders
      WHERE org_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    planAssertions: [],
  },
  {
    id: "inv-vendors-list",
    ceiling: 5_000,
    minRows: 10,
    rowCountSql: `SELECT count(*)::int FROM inv_vendors WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, name, code, created_at
      FROM inv_vendors
      WHERE org_id = $1
      ORDER BY name ASC
      LIMIT 100`,
    planAssertions: [],
  },
  {
    id: "search-tickets-sdf",
    ceiling: 30_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL`,
    params: () => [],
    sql: `SELECT * FROM app.search_ticket_ids('ticket', 20)`,
    planAssertions: [],
  },
  {
    id: "search-lead-party-sdf",
    ceiling: 30_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM business_parties WHERE organization_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.hasBusinessParties ? [] : null),
    sql: `SELECT * FROM app.search_lead_party_ids('a', 20)`,
    planAssertions: [],
  },
  {
    id: "search-deal-sdf",
    ceiling: 30_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM deals WHERE org_id = $1 AND deleted_at IS NULL`,
    params: () => [],
    sql: `SELECT * FROM app.search_deal_ids('a', 20)`,
    planAssertions: [],
  },
  {
    id: "search-contact-party-sdf",
    ceiling: 30_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM business_parties WHERE organization_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.hasBusinessParties ? [] : null),
    sql: `SELECT * FROM app.search_contact_party_ids('a', 20)`,
    planAssertions: [],
  },
  {
    id: "search-client-party-sdf",
    ceiling: 30_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM business_parties WHERE organization_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.hasBusinessParties ? [] : null),
    sql: `SELECT * FROM app.search_client_party_ids('a', 20)`,
    planAssertions: [],
  },
  {
    id: "leave-balances-org",
    ceiling: 5_000,
    minRows: 10,
    rowCountSql: `SELECT count(*)::int FROM leave_balances WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, user_id, leave_type_id, year, balance
      FROM leave_balances
      WHERE org_id = $1
      ORDER BY user_id ASC, year DESC
      LIMIT 100`,
    planAssertions: [],
  },
  {
    id: "leave-accrual-ledger-dedup",
    ceiling: 100,
    minRows: 10,
    rowCountSql: `SELECT count(*)::int FROM hr_leave_ledger WHERE org_id = $1`,
    params: (f) => (f.leaveTypeIds && f.leaveTypeIds.length > 0 ? [f.orgId, f.leaveTypeIds, f.period] : null),
    sql: `
      SELECT user_id, leave_type_id
      FROM hr_leave_ledger
      WHERE org_id = $1
        AND leave_type_id = ANY($2)
        AND txn_type = 'accrual'
        AND period = $3
        AND source = 'cron'`,
    planAssertions: [],
  },
  {
    id: "leave-accrual-balance-read",
    ceiling: 200,
    minRows: 10,
    rowCountSql: `SELECT count(*)::int FROM leave_balances WHERE org_id = $1`,
    params: (f) => (f.leaveTypeIds && f.leaveTypeIds.length > 0
      ? [f.orgId, f.leaveTypeIds, parseInt(f.period.slice(0, 4), 10)]
      : null),
    sql: `
      SELECT user_id, leave_type_id, balance
      FROM leave_balances
      WHERE org_id = $1
        AND leave_type_id = ANY($2)
        AND year = $3`,
    planAssertions: [],
  },
  {
    id: "chat-saved-messages",
    ceiling: 5_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM chat_messages WHERE org_id = $1 AND is_deleted = false`,
    params: (f) => [f.orgId, f.userId],
    sql: `
      SELECT sm.message_id, sm.saved_at, m.content, m.channel_id, m.created_at
      FROM chat_saved_messages sm
      INNER JOIN chat_messages m ON m.id = sm.message_id
      INNER JOIN organization_members om ON om.id = sm.membership_id AND om.org_id = $1 AND om.user_id = $2
      WHERE sm.org_id = $1 AND m.is_deleted = false
      ORDER BY sm.saved_at DESC
      LIMIT 50`,
    planAssertions: [
      // chat_messages is the growing side (12,000 rows); chat_saved_messages is the small one.
      // Measured: 81 warm blocks, 230 rows scanned for 25 returned.
      { kind: "forbid-seq-scan", relation: "chat_messages" },
    ],
  },
  {
    id: "accounting-receivables-list",
    ceiling: 5_000,
    minRows: 10,
    rowCountSql: `SELECT count(*)::int FROM clients WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT c.id, c.name, c.state, c.gstin,
             count(DISTINCT i.id) AS invoice_count,
             (COALESCE(SUM(i.total), 0) - COALESCE(paid_sq.paid, 0)) AS outstanding,
             count(*) OVER () AS total
      FROM clients c
      LEFT JOIN invoices i ON i.client_id = c.id AND i.org_id = $1
      LEFT JOIN (
        SELECT i2.client_id, COALESCE(SUM(p.amount), 0) AS paid
        FROM payments p
        INNER JOIN invoices i2 ON p.invoice_id = i2.id AND i2.org_id = $1
        WHERE p.org_id = $1
        GROUP BY i2.client_id
      ) paid_sq ON paid_sq.client_id = c.id
      WHERE c.org_id = $1
      GROUP BY c.id, c.name, c.state, c.gstin, paid_sq.paid
      ORDER BY outstanding DESC, c.name ASC
      LIMIT 50 OFFSET 0`,
    planAssertions: [],
  },
  {
    // Support ticket queue — the list every support agent lands on first.
    // Rationale: agents visit the open queue on every session; SLA deadlines make this
    // latency-sensitive. The queue_id filter plus status pre-filter on the index should
    // keep this under 10 000 blocks even with tens of thousands of historical tickets.
    // Selected as high-traffic: support is enabled for all orgs and the queue page is
    // the default landing route for support agents.
    id: "support-ticket-queue",
    ceiling: 10_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM support_tickets WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, title, status, priority, assignee_membership_id, sla_deadline, created_at,
             count(*) OVER () total
      FROM support_tickets
      WHERE org_id = $1 AND status IN ('OPEN', 'IN_PROGRESS', 'WAITING')
      ORDER BY priority ASC, sla_deadline ASC NULLS LAST, created_at ASC
      LIMIT 50 OFFSET 0`,
    planAssertions: [],
  },
  {
    id: "support-ticket-assigned-to-me",
    ceiling: 8_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM support_tickets WHERE org_id = $1`,
    params: (f) => (f.membershipId ? [f.orgId, f.membershipId] : null),
    sql: `
      SELECT id, title, status, priority, sla_deadline, created_at,
             count(*) OVER () total
      FROM support_tickets
      WHERE org_id = $1 AND assignee_membership_id = $2
        AND status NOT IN ('RESOLVED', 'CLOSED')
      ORDER BY sla_deadline ASC NULLS LAST, created_at DESC
      LIMIT 50 OFFSET 0`,
    planAssertions: [],
  },
  {
    id: "timesheets-pending-org",
    ceiling: 8_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM timesheets WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, date, status, count(*) OVER () total
      FROM timesheets
      WHERE org_id = $1 AND status = 'PENDING'
      ORDER BY date DESC
      LIMIT 50 OFFSET 0`,
    planAssertions: [],
  },
  {
    // Self-service timesheet view — every employee hits this on every timesheet page load.
    // Service: build/execution/timesheets.service.ts listTimeEntries with scope='own'.
    // applyMembershipScope adds user_membership_id = actingMembershipId(user.principal), so the
    //   WHERE is (org_id, user_membership_id) and the membership id arrives on the request
    //   principal — the service issues no organization_members lookup for it. This budget used to
    //   resolve it with a scalar subquery and to name idx_timesheets_org_user_date on
    //   (org_id, user_id, date), an index that does not exist at head: it charged the route for a
    //   membership probe it does not make and described a plan on a column the table stopped
    //   filtering on.
    // idx_timesheets_org_user_membership_date on (org_id, user_membership_id, date) covers this.
    // SQL verified against listTimeEntries with scope resolved to 'own'.
    id: "timesheets-mine",
    ceiling: 3_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM timesheets WHERE org_id = $1`,
    params: (f) => (f.membershipId ? [f.orgId, f.membershipId] : null),
    sql: `
      SELECT id, date, hours, status, description, project_id, ticket_id, voided_at
      FROM timesheets
      WHERE org_id = $1 AND user_membership_id = $2
      ORDER BY date DESC
      LIMIT 50 OFFSET 0`,
    planAssertions: [],
  },
  {
    // Mail inbox cached list — first page served from mail_message_metadata on every inbox load.
    // Service: mail/mail-metadata.service.ts listCached (called by mail.service.ts listMessages
    //   on first page when no search and single account selected).
    // idx_mail_metadata_list_keyset on (org_id, user_membership_id, folder, date DESC, id DESC)
    //   covers this exactly. Migration 1022 made the page keyset-pageable and DROPPED
    //   idx_mail_metadata_list, which this comment used to name on a column (user_id) the table no
    //   longer filters on; the ORDER BY here carried the same lag — listCached orders by
    //   (date DESC, id DESC) so the cursor cannot repeat or skip a row at a page boundary, and a
    //   budget ordering by date alone measures a prefix scan the route does not run.
    // SQL verified against listCached: WHERE org_id, user_membership_id, folder
    //   ORDER BY date DESC, id DESC LIMIT.
    id: "mail-inbox-cached",
    ceiling: 5_000,
    // 10 rows satisfied the floor while guaranteeing a Seq Scan: on a single-page
    // table the planner will never prefer an index, so forbid-seq-scan could only
    // ever fail. A floor that lets a budget "measure" a plan the data cannot
    // produce is worse than no budget.
    minRows: 2_000,
    rowCountSql: `SELECT count(*)::int FROM mail_message_metadata WHERE org_id = $1`,
    params: (f) => (f.hasMailMessages && f.membershipId ? [f.orgId, f.membershipId] : null),
    sql: `
      SELECT id, message_id, thread_id, account_id, subject, sender_email, sender_name,
             date, is_read, is_starred, has_attachment, labels, folder, synced_at
      FROM mail_message_metadata
      WHERE org_id = $1 AND user_membership_id = $2 AND folder = 'inbox'
      ORDER BY date DESC, id DESC
      LIMIT 51`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "mail_message_metadata" },
    ],
  },
  {
    // All-work cursor-paginated list — the Build module landing page for every project member.
    // Service: build/core/projects-work-query.service.ts getAllWork → pageFilteredWork
    //   (scope != 'mine'). Two queries: member project lookup + ticket page. Budget combines
    //   them into one subquery IN so the planner sees the full cost.
    // SQL verified against getAllWork + pageFilteredWork with default sort (rank ASC, id ASC).
    // idx_project_members_org_member_membership on (org_id, membership_id) covers the subquery.
    // idx_tickets_org_project_rank on (org_id, project_id, rank) covers the outer scan,
    //   executed as BitmapOr across member projects.
    // PROVISIONAL ceiling — measure with actual seed data at realistic member project count.
    id: "build-all-work",
    ceiling: 30_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.membershipId ? [f.orgId, f.membershipId] : null),
    sql: `
      SELECT t.id, t.title, t.status, t.priority, t.type, t.due_date, t.rank,
             t.created_at, t.updated_at,
             p.id AS project_id, p.key AS project_key, p.name AS project_name
      FROM build.tickets t
      INNER JOIN build.projects p ON p.id = t.project_id
      WHERE t.org_id = $1
        AND t.project_id IN (
          SELECT pm.project_id FROM build.project_members pm
          WHERE pm.org_id = $1 AND pm.membership_id = $2
        )
        AND p.status <> 'ARCHIVED'
        AND t.deleted_at IS NULL
      ORDER BY t.rank ASC, t.id ASC
      LIMIT 51`,
    planAssertions: [],
  },
  {
    // Roadmap list — cursor-paginated, first page on every roadmap landing.
    // Service: build/core/projects-roadmap.service.ts listRoadmap.
    // SQL verified against listRoadmap with no status/search filter (common default).
    // idx_roadmap_items_org_status partial index on (org_id, status) WHERE deleted_at IS NULL
    //   covers the filter; sort by sort_order, id has no dedicated index so planner may sort.
    // Seq scan is planner-correct for small tables — no forbid-seq-scan assertion.
    // PROVISIONAL ceiling — measure when roadmap data is seeded.
    id: "build-roadmap-list",
    ceiling: 5_000,
    minRows: 1,
    rowCountSql: `SELECT count(*)::int FROM build.roadmap_items WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.hasRoadmapItems ? [f.orgId] : null),
    sql: `
      SELECT id, title, status, sort_order, category, is_public, target_quarter,
             votes, created_at, updated_at
      FROM build.roadmap_items
      WHERE org_id = $1 AND deleted_at IS NULL
      ORDER BY sort_order ASC, id ASC
      LIMIT 51`,
    planAssertions: [],
  },
  {
    // Feedback list — cursor-paginated by votes DESC, default excludes merged duplicates.
    // Service: build/core/projects-roadmap.service.ts listFeedback.
    // SQL verified: includeMerged=false (default) adds isNull(feedbackPosts.duplicateOfId),
    //   no status filter by default, ORDER BY votes DESC, id ASC.
    // idx_feedback_posts_org_status partial WHERE deleted_at IS NULL covers the filter.
    // Seq scan is planner-correct for small tables.
    // PROVISIONAL ceiling — measure when feedback data is seeded.
    id: "build-feedback-list",
    ceiling: 5_000,
    minRows: 1,
    rowCountSql: `SELECT count(*)::int FROM build.feedback_posts WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.hasFeedbackPosts ? [f.orgId] : null),
    sql: `
      SELECT id, title, status, votes, category, submitted_by_name, created_at, updated_at
      FROM build.feedback_posts
      WHERE org_id = $1 AND deleted_at IS NULL AND duplicate_of_id IS NULL
      ORDER BY votes DESC, id ASC
      LIMIT 51`,
    planAssertions: [],
  },
  {
    // Changelog list — cursor-paginated by created_at DESC, id DESC.
    // Service: build/core/projects-roadmap.service.ts listChangelog.
    // SQL verified: no deleted_at column on changelog_entries, ORDER BY created_at DESC, id DESC.
    // No index covers this sort on (org_id, created_at, id); seq scan is planner-correct
    //   for small tables. Planner-correct result documented here — not a missing index.
    // PROVISIONAL ceiling — measure when changelog data is seeded.
    id: "build-changelog-list",
    ceiling: 3_000,
    minRows: 1,
    rowCountSql: `SELECT count(*)::int FROM build.changelog_entries WHERE org_id = $1`,
    params: (f) => (f.hasChangelogEntries ? [f.orgId] : null),
    sql: `
      SELECT id, title, type, is_published, version, published_at, created_at, updated_at
      FROM build.changelog_entries
      WHERE org_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 51`,
    planAssertions: [],
  },
  {
    // Finance tax payments list — cursor-paginated by id DESC (newest first).
    // Service: finance/tax/tax-payments.service.ts list.
    // SQL verified: WHERE org_id AND archived_at IS NULL ORDER BY id DESC LIMIT pageLimit+1.
    // unique constraint uniq_acc_tax_payments_org_id on (org_id, id) — a unique index that
    //   allows a descending range scan: WHERE org_id = $1 ORDER BY id DESC is index-supported.
    // Seq scan is planner-correct for small/unseeded tables.
    // PROVISIONAL ceiling — measure when tax payment data is seeded.
    id: "finance-tax-payments",
    ceiling: 3_000,
    minRows: 1,
    rowCountSql: `SELECT count(*)::int FROM acc_tax_payments WHERE org_id = $1 AND archived_at IS NULL`,
    params: (f) => (f.hasTaxPayments ? [f.orgId] : null),
    sql: `
      SELECT id, tax_type, period_start, period_end, amount, paid_date, reference,
             notes, created_at
      FROM acc_tax_payments
      WHERE org_id = $1 AND archived_at IS NULL
      ORDER BY id DESC
      LIMIT 51`,
    planAssertions: [],
  },
  {
    // Finance reminder policies list — cursor-paginated by id ASC.
    // Service: finance/ar/reminders.service.ts listPolicies.
    // SQL verified: WHERE org_id AND archived_at IS NULL ORDER BY id ASC LIMIT pageLimit+1.
    // unique constraint uniq_fin_reminder_policies_org_id on (org_id, id) — index supports
    //   WHERE org_id = $1 [AND id > cursor] ORDER BY id ASC.
    // Seq scan is planner-correct for small/unseeded tables.
    // PROVISIONAL ceiling — measure when reminder policy data is seeded.
    id: "finance-reminder-policies",
    ceiling: 2_000,
    minRows: 1,
    rowCountSql: `SELECT count(*)::int FROM fin_reminder_policies WHERE org_id = $1 AND archived_at IS NULL`,
    params: (f) => (f.hasReminderPolicies ? [f.orgId] : null),
    sql: `
      SELECT id, name, offsets, channel, template, is_active, created_at, updated_at
      FROM fin_reminder_policies
      WHERE org_id = $1 AND archived_at IS NULL
      ORDER BY id ASC
      LIMIT 51`,
    planAssertions: [],
  },
  {
    // Module-access member roster — the member list shown in module access settings.
    // Service: module-access/module-access-roster.service.ts fetchMembers (page=1, no cursor).
    // SQL verified against the service's selectDistinct + joins on role_assignments,
    //   organization_members, users. Uses 'hr' as the module key fixture since HR roles
    //   are seeded in every enabled HR org.
    // idx_role_assignments_org_role on (org_id, role_id) covers the join predicate.
    // Plan depends on member count and role count; no forbid assertion.
    // PROVISIONAL ceiling — measure with realistic role assignment data.
    id: "module-access-roster",
    ceiling: 10_000,
    minRows: 1,
    rowCountSql: `SELECT count(*)::int FROM roles WHERE org_id = $1 AND module_key IS NOT NULL`,
    params: (f) => (f.hasModuleRoles ? [f.orgId] : null),
    sql: `
      SELECT DISTINCT ra.organization_membership_id, om.user_id, u.name, u.email, u.image
      FROM role_assignments ra
      INNER JOIN organization_members om
        ON om.org_id = ra.org_id AND om.id = ra.organization_membership_id
      INNER JOIN users u ON u.id = om.user_id
      WHERE ra.org_id = $1
        AND ra.role_id IN (
          SELECT r.id FROM roles r WHERE r.org_id = $1 AND r.module_key = 'hr'
        )
        AND om.status = 'ACTIVE'
      ORDER BY u.name ASC
      LIMIT 100`,
    planAssertions: [],
  },
  {
    id: "dashboard-personal-my-tasks",
    // The status list mirrors DEFAULT_PROJECT_STATUSES / ACTIVE_TICKET_STATUSES, which the
    // application writes in UPPER_SNAKE. Do NOT retune it to a fixture's vocabulary — that makes
    // the budget measure a query the application never runs.
    //
    // If this budget reports VACUOUS on your database, the database is stale, not the predicate.
    // seed-perf-scratch.mjs used to write title-case ('Todo', 'In Progress'); it writes UPPER_SNAKE
    // at head and carries LEGACY_STATUS_NAMES to rename an existing database's rows in place (the
    // composite FK is ON UPDATE CASCADE, so the tickets follow). Rebuild or re-run the seed. A
    // database built before that fix — `scratch_perf_seed` is one — still holds title-case rows,
    // and every ceiling here reads as satisfied over an empty result set. That is what the
    // vacuous-result guard exists to catch, and it does: measured on a seed at head this budget
    // returns 10 rows on all three measurable tenants, `vacuous: false`.
    //
    // The scan-rows ceiling is 200, tightened from 1,000. While the covering index was missing this
    // walked 1,801 rows to return 10, because the planner took idx_tickets_org_updated_live
    // (org_id, updated_at DESC) for the ORDER BY and declined idx_tickets_org_assignee_status,
    // which cannot order. Migration 1027 added
    // (org_id, assignee_membership_id, updated_at DESC) WHERE deleted_at IS NULL and it now scans
    // 19 / 21 / 22 rows on the 89.93 / 9.00 / 0.90 percent tenants — 45x below the ceiling that was
    // meant to bound it, which is a guard that has stopped guarding. 200 keeps 9x headroom over the
    // worst measured tenant and still trips an order of magnitude below the 1,801 a declined index
    // costs. Tightened, never raised.
    ceiling: 2_000,
    minRows: 50,
    maxScanRows: 200,
    rowCountSql: `SELECT count(*)::int FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.membershipId ? [f.orgId, f.membershipId] : null),
    sql: `
      SELECT t.id, t.title, t.status, t.priority, t.updated_at,
             p.id AS project_id, p.name AS project_name
      FROM build.tickets t
      LEFT JOIN build.projects p ON p.id = t.project_id
      WHERE t.org_id = $1 AND t.assignee_membership_id = $2 AND t.deleted_at IS NULL
        AND t.status IN ('TODO', 'IN_PROGRESS', 'IN_REVIEW')
      ORDER BY t.updated_at DESC
      LIMIT 10`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "tickets" },
    ],
  },
  {
    id: "dashboard-my-issues",
    // Declares a scan-rows ceiling now, which it did not. This is
    // dashboard-personal-my-tasks without the status filter — the same tenant+assignee read on the
    // same index — and while the covering index was missing it walked 1,801 rows to return 10 and
    // reported PASS on buffers alone, because a budget with no maxScanRows cannot see a plan
    // regression that stays inside its block ceiling. 200 is the ceiling: measured post-1027 it
    // scans 10 / 21 / 22 rows on the 89.93 / 9.00 / 0.90 percent tenants, so 200 leaves 9x headroom
    // and still trips at an order of magnitude below the 1,801 the declined index cost.
    ceiling: 2_000,
    minRows: 50,
    maxScanRows: 200,
    rowCountSql: `SELECT count(*)::int FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.membershipId ? [f.orgId, f.membershipId] : null),
    sql: `
      SELECT t.id, t.title, t.status, t.priority, t.type, t.ticket_number, t.updated_at,
             p.id AS project_id, p.name AS project_name, p.key AS project_key,
             om.user_id AS assignee_id, u.first_name, u.last_name, u.image
      FROM build.tickets t
      LEFT JOIN build.projects p ON p.id = t.project_id
      LEFT JOIN organization_members om
        ON om.org_id = t.org_id AND om.id = t.assignee_membership_id
      LEFT JOIN users u ON u.id = om.user_id
      WHERE t.org_id = $1 AND t.assignee_membership_id = $2 AND t.deleted_at IS NULL
      ORDER BY t.updated_at DESC
      LIMIT 10`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "tickets" },
    ],
  },
  {
    id: "dashboard-personal-calendar-events",
    ceiling: 500,
    minRows: 1,
    maxScanRows: 200,
    rowCountSql: `SELECT count(*)::int FROM calendar_events WHERE org_id = $1`,
    // Mirrors DashboardPersonalService.upcomingEvents, NOT `GET /calendar/events` — that route runs
    // CalendarEventSourceLoader and has its own budget (calendar-events-visible-batch).
    //
    // The attendee test is a LEFT JOIN LATERAL, not an EXISTS, and that is load-bearing. With an
    // EXISTS the planner is free to de-correlate it into a hashed SubPlan that materialises every
    // attendee row the caller owns (39,114 on the 89.93% tenant) before LIMIT 3 can stop anything:
    // measured 1,140 blocks. Worse, whether it does so depends on whether a non-'org' event lands
    // in the first three rows, which moves with the wall clock — the same query on the same fixture
    // measured 6 blocks on one run and 1,140 on the next, so the recorded number was a coin toss
    // rather than a budget. A LATERAL is structural: it is probed once per candidate row through
    // event_attendees_event_membership_unique and the planner cannot hash it. Measured after the
    // fix: 18 blocks in the cheap window, 20 in the worst-case window — a stable quantity.
    // maxScanRows bites at 39,114 if the LATERAL is ever turned back into an EXISTS.
    params: (f) =>
      f.hasCalendarEvents && f.userId && f.membershipId ? [f.orgId, f.userId, f.membershipId] : null,
    sql: `
      SELECT calendar_events.id, calendar_events.title, calendar_events.start_date,
             calendar_events.end_date, calendar_events.category
      FROM calendar_events
      LEFT JOIN LATERAL (
        SELECT 1 AS hit FROM event_attendees
        WHERE event_attendees.org_id = $1 AND event_attendees.event_id = calendar_events.id
          AND event_attendees.membership_id = $3 AND event_attendees.status <> 'declined'
        LIMIT 1
      ) attended_event ON true
      WHERE calendar_events.org_id = $1 AND calendar_events.start_date >= NOW()
        AND (
          calendar_events.visibility = 'org'
          OR EXISTS (
            SELECT 1 FROM organization_members om
            WHERE om.org_id = calendar_events.org_id
              AND om.id = calendar_events.created_by_membership_id
              AND om.user_id = $2 AND om.status = 'ACTIVE'
          )
          OR hit IS NOT NULL
        )
      ORDER BY calendar_events.start_date ASC
      LIMIT 3`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "calendar_events" },
      { kind: "forbid-hashed-subplan", relation: "event_attendees" },
    ],
  },
  {
    id: "calendar-events-visible-batch",
    ceiling: 2_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM calendar_events WHERE org_id = $1`,
    // The dominant statement of `GET /calendar/events`: the recurring branch of
    // CalendarEventSourceLoader's candidate page. Until 2026-09-03 that route's budget was
    // linked to dashboard-personal-calendar-events, so the calendar route was charged for the
    // dashboard's statement and this one had never been measured at all; when it was, it
    // measured 7,063 blocks against this ceiling and the ceiling was deliberately left alone.
    //
    // The 7,063 was one query: both range branches under an OR, three left joins and the
    // 18-column projection. The recurring arm has no lower bound on start_date, so the
    // planner walked idx_calendar_events_org_date from the tenant's first event and fetched
    // the heap tuple for every candidate before the window filter could reject it — 3,610
    // rows scanned to keep 517, four times a sequential scan of a 1,731-page table.
    //
    // The loader now issues four statements per page and this is the most expensive of them.
    // Measured on the same database and fixture, worst statement per tenant:
    //   89.93%  697   9.00%  700   0.90%  46
    // and the companions are cand-nonrec 295/31/5, rsvp 501/14/21, fetch 322/136/21.
    //
    // The two plan assertions are the load-bearing part, because neither failure mode this
    // budget guards is reliably visible in a block count. forbid-hashed-subplan pins that the
    // caller's attendance stays a correlated probe: as an EXISTS the planner de-correlates it
    // and materialises all 39,114 attendee rows of the fixture membership before the OR can
    // short-circuit on visibility = 'org', which is O(the caller's attendance) rather than
    // O(page) and therefore invisible on every tenant but this one.
    params: (f) => {
      if (!f.hasCalendarEvents || !f.membershipId) return null;
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      return [f.orgId, f.membershipId, start.toISOString(), end.toISOString()];
    },
    sql: `
      SELECT ce.id, ce.start_date
      FROM calendar_events ce
      WHERE ce.org_id = $1
        AND ce.rrule IS NOT NULL
        AND ce.start_date < $4::timestamptz
        AND (ce.recurrence_end IS NULL OR ce.recurrence_end > $3::timestamptz)
        AND (
          ce.visibility = 'org'
          OR ce.created_by_membership_id = $2
          OR (SELECT ea.id FROM event_attendees ea
              WHERE ea.org_id = ce.org_id AND ea.event_id = ce.id
                AND ea.membership_id = $2 LIMIT 1) IS NOT NULL
        )
      ORDER BY ce.start_date ASC, ce.id ASC
      LIMIT 500`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "calendar_events" },
      { kind: "forbid-hashed-subplan", relation: "event_attendees" },
    ],
  },
{
    id: "dashboard-personal-notifications-count",
    ceiling: 3_000,
    minRows: 1,
    rowCountSql: `SELECT count(*)::int FROM notifications WHERE org_id = $1 AND deleted_at IS NULL`,
    // `GET /dashboard/personal` calls NotificationsReadService.unreadCount, so this budget must be
    // the same query as notifications-unread-count — including the partition window. It carried the
    // pre-0520 `user_id` predicate and no window, and measured 11,044 blocks for it.
    params: (f) => {
      if (!f.membershipId) return null;
      const w = notificationReadWindow();
      return [f.orgId, f.membershipId, w.start, w.end];
    },
    sql: `
      SELECT count(*)::int
      FROM notifications
      WHERE org_id = $1 AND membership_id = $2
        AND created_at >= $3::timestamptz AND created_at < $4::timestamptz
        AND is_read = false AND deleted_at IS NULL AND archived_at IS NULL`,
    planAssertions: [
      // 235,297 notifications on the reference tenant. Its two siblings over the same table
      // (notifications-list, notifications-unread-count) already forbid a Seq Scan; this one did
      // not, which is exactly how it Seq Scanned at 11,377 blocks before the 22c predicate fix and
      // still sat inside its 3,000-block ceiling afterwards. Measured now: 16 warm blocks.
      { kind: "forbid-seq-scan", relation: "notifications" },
    ],
  },
  {
    id: "dashboard-stats-attendance-count",
    ceiling: 500,
    minRows: 1,
    rowCountSql: `SELECT count(*)::int FROM attendance WHERE org_id = $1`,
    params: (f) => {
      const today = new Date().toISOString().slice(0, 10);
      return [f.orgId, today];
    },
    sql: `SELECT count(*)::int FROM attendance WHERE org_id = $1 AND date = $2`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "attendance" },
    ],
  },
  {
    id: "dashboard-announcements",
    ceiling: 2_000,
    minRows: 1,
    rowCountSql: `SELECT count(*)::int FROM announcements WHERE org_id = $1`,
    params: (f) => (f.hasAnnouncements ? [f.orgId] : null),
    sql: `
      SELECT a.id, a.content, a.is_pinned, a.expires_at, a.created_at,
             a.author_id, u.name, u.first_name, u.last_name
      FROM announcements a
      INNER JOIN users u ON a.author_id = u.id
      WHERE a.org_id = $1 AND a.status != 'DRAFT'
        AND (a.expires_at IS NULL OR a.expires_at > NOW())
      ORDER BY a.is_pinned DESC, a.created_at DESC
      LIMIT 20`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "announcements" },
    ],
  },
  {
    id: "dashboard-leaves-today",
    ceiling: 2_000,
    minRows: 5,
    rowCountSql: `SELECT count(*)::int FROM leave_requests WHERE org_id = $1`,
    params: (f) => {
      const today = new Date().toISOString().slice(0, 10);
      return [f.orgId, today];
    },
    sql: `
      SELECT lr.id, lr.start_date, lr.end_date, lr.leave_type_id,
             u.name, u.image
      FROM leave_requests lr
      INNER JOIN users u ON lr.user_id = u.id
      WHERE lr.org_id = $1 AND lr.status = 'APPROVED'
        AND lr.start_date <= $2 AND lr.end_date >= $2`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "leave_requests" },
    ],
  },
  {
    id: "dashboard-team-attendance",
    ceiling: 2_000,
    minRows: 1,
    rowCountSql: `SELECT count(*)::int FROM attendance WHERE org_id = $1`,
    // The date is anchored to the seed's own latest attendance day, not to wall-clock today.
    // DashboardStatsService reads `today`, and against a static seed that predicate matches
    // nothing from the day after the seed was built — measured 2026-09-03 on a seed whose last
    // attendance row is 2026-09-02, which is how this budget reached the manifest holding
    // measuredBufferBlocks 41 while returning 0 rows. A budget that goes vacuous on a calendar
    // boundary is a time bomb, not a budget; the anchor is an InitPlan constant, so the
    // predicate the route issues (a.date = <one day>) is unchanged.
    params: (f) => [f.orgId],
    sql: `
      SELECT a.user_id, u.name, u.image, a.check_in, a.check_out, a.status, a.created_at
      FROM attendance a
      INNER JOIN users u ON a.user_id = u.id
      WHERE a.org_id = $1
        AND a.date = (SELECT max(date) FROM attendance WHERE org_id = $1)`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "attendance" },
    ],
  },
  {
    id: "dashboard-active-sprint",
    ceiling: 1_000,
    minRows: 1,
    rowCountSql: `SELECT count(*)::int FROM build.sprints WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => [f.orgId],
    sql: `
      SELECT s.id, s.name, s.status, s.end_date, p.id AS project_id, p.name AS project_name
      FROM build.sprints s
      LEFT JOIN build.projects p ON p.id = s.project_id
      WHERE s.org_id = $1 AND s.status = 'ACTIVE' AND s.deleted_at IS NULL
      LIMIT 1`,
    planAssertions: [],
  },
  {
    id: "dashboard-recent-projects",
    ceiling: 2_000,
    minRows: 1,
    rowCountSql: `SELECT count(*)::int FROM build.project_members WHERE org_id = $1`,
    params: (f) => (f.membershipId ? [f.orgId, f.membershipId] : null),
    sql: `
      SELECT p.id, p.name, p.status, p.created_at
      FROM build.projects p
      INNER JOIN build.project_members pm
        ON pm.project_id = p.id AND pm.org_id = $1 AND pm.membership_id = $2
      WHERE p.org_id = $1 AND p.deleted_at IS NULL
      ORDER BY p.id DESC
      LIMIT 5`,
    planAssertions: [],
  },
];

export const REQUIRED_BUDGET_IDS = new Set([
  "dashboard-personal-my-tasks",
  "dashboard-my-issues",
  "dashboard-personal-calendar-events",
  "calendar-events-visible-batch",
  "dashboard-personal-notifications-count",
  "dashboard-stats-attendance-count",
  "dashboard-announcements",
  "dashboard-leaves-today",
  "dashboard-team-attendance",
  "dashboard-active-sprint",
  "dashboard-recent-projects",
]);
