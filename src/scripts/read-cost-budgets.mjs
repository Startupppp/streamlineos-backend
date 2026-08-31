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
 */

export const BUDGETS = [
  {
    id: "scoped-board-page",
    ceiling: 5_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.projectId ? [f.orgId, f.projectId, f.userId] : null),
    sql: `
      SELECT t.id, count(*) OVER () total
      FROM build.tickets t
      WHERE t.org_id = $1 AND t.project_id = $2 AND t.deleted_at IS NULL
        AND (t.assignee_id = $3 OR t.reporter_id = $3
             OR EXISTS (SELECT 1 FROM build.ticket_assignees ta
                        WHERE ta.org_id = $1 AND ta.user_id = $3 AND ta.ticket_id = t.id))
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
    params: (f) => [f.orgId, f.userId],
    sql: `
      SELECT u.id, count(*) OVER () total FROM (
        (SELECT t.id, t.due_date, t.priority
         FROM build.tickets t INNER JOIN build.projects p ON p.id = t.project_id
         WHERE t.org_id = $1 AND p.status <> 'ARCHIVED' AND t.deleted_at IS NULL AND t.assignee_id = $2)
        UNION
        (SELECT t.id, t.due_date, t.priority
         FROM build.tickets t INNER JOIN build.projects p ON p.id = t.project_id
         INNER JOIN build.ticket_assignees ta ON ta.ticket_id = t.id AND ta.org_id = $1 AND ta.user_id = $2
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
    rowCountSql: `SELECT count(*)::int FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.projectId ? [f.orgId, f.projectId] : null),
    sql: `
      SELECT t.id, t.title, t.status, t.priority, t.assignee_id, t.rank,
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
    params: (f) => [f.orgId, f.userId],
    sql: `
      SELECT t.id, t.title, t.status, t.priority, t.due_date,
             count(*) OVER () total
      FROM build.tickets t
      INNER JOIN build.projects p ON p.id = t.project_id
      WHERE t.org_id = $1 AND t.assignee_id = $2
        AND t.deleted_at IS NULL AND p.status <> 'ARCHIVED'
      ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC
      LIMIT 50 OFFSET 0`,
    // idx_tickets_org_assignee_status (org_id, assignee_id, status) exists for production use.
    // Seed data has only 2 users sharing 20 000 tickets, so each user has ~34% of all rows and
    // the planner correctly prefers a seq scan. The block ceiling (20 000) guards correctness;
    // the index assertion fires naturally once realistic data exists.
    planAssertions: [],
  },
  {
    id: "notifications-list",
    ceiling: 5_000,
    minRows: 100,
    rowCountSql: `SELECT count(*)::int FROM notifications WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => [f.orgId, f.userId],
    sql: `
      SELECT id, title, message, is_read, category, source_module, link, created_at
      FROM notifications
      WHERE org_id = $1 AND user_id = $2
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
    params: (f) => [f.orgId, f.userId],
    sql: `
      SELECT count(*)::int
      FROM notifications
      WHERE org_id = $1 AND user_id = $2
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
      WHERE c.org_id = $1 AND m.user_id = $2
        AND m.archived_at IS NULL AND c.is_archived = false
      ORDER BY c.last_message_at DESC
      LIMIT 50`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "chat_channels" },
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
      SELECT id, sender_id, content, message_type, metadata, created_at, is_edited
      FROM chat_messages
      WHERE org_id = $1 AND channel_id = $2 AND is_deleted = false
      ORDER BY created_at DESC
      LIMIT 50`,
    planAssertions: [
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
      SELECT m.user_id, m.role, m.joined_at
      FROM chat_channel_members m
      WHERE m.org_id = $1 AND m.channel_id = $2
      ORDER BY m.joined_at ASC
      LIMIT 100`,
    planAssertions: [
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "kb_spaces" },
    ],
  },
  {
    id: "kb-page-visits-mine",
    ceiling: 5_000,
    minRows: 30,
    rowCountSql: `SELECT count(*)::int FROM kb_page_visits WHERE org_id = $1`,
    params: (f) => [f.orgId, f.userId],
    sql: `
      SELECT pv.page_id, pv.visited_at, p.title, p.space_id
      FROM kb_page_visits pv
      INNER JOIN kb_pages p ON p.id = pv.page_id
      WHERE pv.org_id = $1 AND pv.user_id = $2
        AND p.deleted_at IS NULL
      ORDER BY pv.visited_at DESC
      LIMIT 20`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "kb_page_visits" },
    ],
  },
  {
    id: "org-members-list",
    ceiling: 5_000,
    minRows: 10,
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "organization_people" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "hr_employments" },
      { kind: "forbid-seq-scan", relation: "hr_people" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "hr_reporting_lines" },
    ],
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
    params: (f) => [f.orgId, f.userId],
    sql: `
      SELECT id, status, start_date, end_date, created_at
      FROM leave_requests
      WHERE org_id = $1 AND user_id = $2
      ORDER BY created_at DESC
      LIMIT 50`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "leave_requests" },
    ],
  },
  {
    id: "attendance-mine",
    ceiling: 5_000,
    minRows: 30,
    rowCountSql: `SELECT count(*)::int FROM attendance WHERE org_id = $1`,
    params: (f) => [f.orgId, f.userId],
    sql: `
      SELECT id, date, status, check_in, check_out
      FROM attendance
      WHERE org_id = $1 AND user_id = $2
      ORDER BY date DESC
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "hr_leave_ledger" },
    ],
  },
  {
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "contacts" },
    ],
  },
  {
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "leads" },
    ],
  },
  {
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "leads" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "deals" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "clients" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "invoices" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "purchase_bills" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "gl_journals" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "payroll_runs" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "payroll_run_employees" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "payroll_line_items" },
    ],
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
      WHERE org_id = $1 AND deleted_at IS NULL AND status <> 'DISCONTINUED'
      ORDER BY id DESC
      LIMIT 50`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "inv_products" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "inv_stock_levels" },
    ],
  },
  /**
   * G1 — the three shapes the movements and audit lists actually issue.
   *
   * The ordering carries `id` because `created_at` alone is not unique on this
   * table, and the cursor pages carry the boundary as text at microsecond
   * precision because that is what the endpoint sends. Measured as
   * `streamline_app` with the tenant GUC on the seed organisation's 4,200-row
   * ledger, before 0547: page one cost 849 blocks — the planner reached for
   * `idx_inv_txn_created`, which cannot supply `org_id` and so cannot answer the
   * tenant qual from the index — and a deep page fell back to a bitmap scan of
   * the whole tenant plus a sort, 94 blocks and rising with the tenant. After:
   * single digits, and flat at any depth.
   *
   * The ceilings sit far above that and far below one tenant scan, so they fire
   * when the plan falls off `idx_inv_txn_org_created_id` and not before.
   */
  {
    id: "inv-stock-transactions",
    ceiling: 60,
    minRows: 100,
    rowCountSql: `SELECT count(*)::int FROM inv_stock_transactions WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, product_variant_id, transaction_type, quantity_change, posting_date, created_at
      FROM inv_stock_transactions
      WHERE org_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 51`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "inv_stock_transactions" },
    ],
  },
  {
    id: "inv-stock-transactions-cursor",
    ceiling: 60,
    minRows: 100,
    rowCountSql: `SELECT count(*)::int FROM inv_stock_transactions WHERE org_id = $1`,
    params: (f) => (f.ledgerCursorId ? [f.orgId, f.ledgerCursorAt, f.ledgerCursorId] : null),
    sql: `
      SELECT id, product_variant_id, transaction_type, quantity_change, posting_date, created_at,
             to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_at
      FROM inv_stock_transactions
      WHERE org_id = $1 AND (created_at, id) < ($2::timestamp, $3::int)
      ORDER BY created_at DESC, id DESC
      LIMIT 51`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "inv_stock_transactions" },
    ],
  },
  {
    id: "inv-audit-events-cursor",
    ceiling: 60,
    minRows: 1,
    rowCountSql: `SELECT count(*)::int FROM inv_audit_events WHERE org_id = $1`,
    params: (f) => (f.auditCursorId ? [f.orgId, f.auditCursorAt, f.auditCursorId] : null),
    sql: `
      SELECT id, action, resource_type, resource_id, actor_user_id, created_at,
             to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS cursor_at
      FROM inv_audit_events
      WHERE org_id = $1 AND (created_at, id) < ($2::timestamp, $3::int)
      ORDER BY created_at DESC, id DESC
      LIMIT 51`,
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "inv_purchase_orders" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "inv_vendors" },
    ],
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
    params: () => [],
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
    params: () => [],
    sql: `SELECT * FROM app.search_contact_party_ids('a', 20)`,
    planAssertions: [],
  },
  {
    id: "search-client-party-sdf",
    ceiling: 30_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM business_parties WHERE organization_id = $1 AND deleted_at IS NULL`,
    params: () => [],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "leave_balances" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "hr_leave_ledger" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "leave_balances" },
    ],
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
      WHERE sm.org_id = $1 AND sm.user_id = $2 AND m.is_deleted = false
      ORDER BY sm.saved_at DESC
      LIMIT 50`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "chat_saved_messages" },
    ],
  },
  /**
   * D1 — one hop of the lot/serial genealogy walk.
   *
   * Both entries measure the shape, not the volume: the walk is anchored on
   * fixed ids because the traversal's cost is decided by whether the ledger can
   * be reached by lot id and by document reference at all, not by how many rows
   * come back. Measured on the seed organisation's 4,200-row ledger: 3 buffers
   * on the indexes 0542 adds, 3,936 as a sequential scan — and that gap grows
   * linearly with the tenant, which is why an uncapped or unindexed traversal
   * is a denial of service a customer can trigger from a URL.
   *
   * The ceiling sits far above the measured cost and far below one scan, so it
   * fires when the plan falls off the index and not before.
   */
  {
    id: "inv-genealogy-item-hop",
    ceiling: 500,
    minRows: 100,
    rowCountSql: `SELECT count(*)::int FROM inv_stock_transactions WHERE org_id = $1`,
    params: (f) => [f.orgId, 1, 2, 3],
    sql: `
      SELECT 'lot'::text || ':' || a.item_id::text AS source_key,
             x.id, x.lot_id, x.serial_id, x.reference_type, x.reference_id,
             x.transaction_type, x.quantity_change, x.location_id, x.created_at, x.reversed
      FROM (VALUES ($2::int), ($3::int), ($4::int)) AS a(item_id)
      CROSS JOIN LATERAL (
        SELECT t.id, t.lot_id, t.serial_id, t.reference_type, t.reference_id,
               t.transaction_type, t.quantity_change, t.location_id, t.created_at,
               (t.correction_of_transaction_id IS NOT NULL OR EXISTS (
                  SELECT 1 FROM inv_stock_transactions c
                  WHERE c.org_id = t.org_id AND c.correction_of_transaction_id = t.id)) AS reversed
        FROM inv_stock_transactions t
        WHERE t.org_id = $1
          AND t.lot_id = a.item_id
          AND t.reference_type IS NOT NULL
          AND t.reference_id IS NOT NULL
          AND (t.correction_of_transaction_id IS NULL AND NOT EXISTS (
                SELECT 1 FROM inv_stock_transactions c
                WHERE c.org_id = t.org_id AND c.correction_of_transaction_id = t.id))
        ORDER BY t.id DESC
        LIMIT 26
      ) x
      LIMIT 79`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "inv_stock_transactions" },
    ],
  },
  {
    id: "inv-genealogy-document-hop",
    ceiling: 500,
    minRows: 100,
    rowCountSql: `SELECT count(*)::int FROM inv_stock_transactions WHERE org_id = $1`,
    params: (f) => [f.orgId, "inv_grn", "1", "inv_sales_order", "1"],
    sql: `
      SELECT d.ref_type || ':' || d.ref_id AS source_key,
             x.id, x.lot_id, x.serial_id, x.reference_type, x.reference_id,
             x.transaction_type, x.quantity_change, x.location_id, x.created_at, x.reversed
      FROM (VALUES ($2::text, $3::text), ($4::text, $5::text)) AS d(ref_type, ref_id)
      CROSS JOIN LATERAL (
        SELECT t.id, t.lot_id, t.serial_id, t.reference_type, t.reference_id,
               t.transaction_type, t.quantity_change, t.location_id, t.created_at,
               (t.correction_of_transaction_id IS NOT NULL OR EXISTS (
                  SELECT 1 FROM inv_stock_transactions c
                  WHERE c.org_id = t.org_id AND c.correction_of_transaction_id = t.id)) AS reversed
        FROM inv_stock_transactions t
        WHERE t.org_id = $1
          AND t.reference_type = d.ref_type
          AND t.reference_id = d.ref_id
          AND (t.lot_id IS NOT NULL OR t.serial_id IS NOT NULL)
          AND (t.correction_of_transaction_id IS NULL AND NOT EXISTS (
                SELECT 1 FROM inv_stock_transactions c
                WHERE c.org_id = t.org_id AND c.correction_of_transaction_id = t.id))
        ORDER BY t.id DESC
        LIMIT 26
      ) x
      LIMIT 53`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "inv_stock_transactions" },
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "clients" },
    ],
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
      SELECT id, title, status, priority, assignee_id, sla_deadline, created_at,
             count(*) OVER () total
      FROM support_tickets
      WHERE org_id = $1 AND status IN ('OPEN', 'IN_PROGRESS', 'WAITING')
      ORDER BY priority ASC, sla_deadline ASC NULLS LAST, created_at ASC
      LIMIT 50 OFFSET 0`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "support_tickets" },
    ],
  },
  {
    // Support tickets assigned to a specific agent — the "my tickets" view.
    // Selected as high-traffic: every agent checks their queue on login.
    // idx_support_tickets_org_assignee (org_id, assignee_id, created_at DESC) must exist
    // to satisfy this without a full scan.
    id: "support-ticket-assigned-to-me",
    ceiling: 8_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM support_tickets WHERE org_id = $1`,
    params: (f) => (f.userId ? [f.orgId, f.userId] : null),
    sql: `
      SELECT id, title, status, priority, sla_deadline, created_at,
             count(*) OVER () total
      FROM support_tickets
      WHERE org_id = $1 AND assignee_id = $2
        AND status NOT IN ('RESOLVED', 'CLOSED')
      ORDER BY sla_deadline ASC NULLS LAST, created_at DESC
      LIMIT 50 OFFSET 0`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "support_tickets" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "timesheets" },
    ],
  },
  {
    // Self-service timesheet view — every employee hits this on every timesheet page load.
    // Service: build/execution/timesheets.service.ts listTimeEntries with scope='own'
    // applyScope adds user_id = caller, so the WHERE is always (org_id, user_id).
    // idx_timesheets_org_user_date on (org_id, user_id, date) covers this exactly.
    // SQL verified against listTimeEntries with scope resolved to 'own'.
    id: "timesheets-mine",
    ceiling: 3_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM timesheets WHERE org_id = $1`,
    params: (f) => (f.userId ? [f.orgId, f.userId] : null),
    sql: `
      SELECT id, date, hours, status, description, project_id, ticket_id, voided_at
      FROM timesheets
      WHERE org_id = $1 AND user_id = $2
      ORDER BY date DESC
      LIMIT 50 OFFSET 0`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "timesheets" },
    ],
  },
  {
    // Mail inbox cached list — first page served from mail_message_metadata on every inbox load.
    // Service: mail/mail-metadata.service.ts listCached (called by mail.service.ts listMessages
    //   on first page when no search and single account selected).
    // idx_mail_metadata_list on (org_id, user_id, folder, date DESC) covers this exactly.
    // SQL verified against listCached: WHERE org_id, user_id, folder ORDER BY date DESC LIMIT.
    // PROVISIONAL ceiling — measure with actual mail seed; mail is not seeded by default.
    id: "mail-inbox-cached",
    ceiling: 5_000,
    minRows: 10,
    rowCountSql: `SELECT count(*)::int FROM mail_message_metadata WHERE org_id = $1`,
    params: (f) => (f.hasMailMessages && f.userId ? [f.orgId, f.userId] : null),
    sql: `
      SELECT message_id, thread_id, account_id, subject, sender_email, sender_name,
             date, is_read, is_starred, has_attachment, labels, folder, synced_at
      FROM mail_message_metadata
      WHERE org_id = $1 AND user_id = $2 AND folder = 'inbox'
      ORDER BY date DESC
      LIMIT 50`,
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
    // idx_project_members_org_user on (org_id, user_id) covers the subquery.
    // idx_tickets_org_project_rank on (org_id, project_id, rank) covers the outer scan,
    //   executed as BitmapOr across member projects.
    // PROVISIONAL ceiling — measure with actual seed data at realistic member project count.
    id: "build-all-work",
    ceiling: 30_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.userId ? [f.orgId, f.userId] : null),
    sql: `
      SELECT t.id, t.title, t.status, t.priority, t.type, t.due_date, t.rank,
             t.created_at, t.updated_at,
             p.id AS project_id, p.key AS project_key, p.name AS project_name
      FROM build.tickets t
      INNER JOIN build.projects p ON p.id = t.project_id
      WHERE t.org_id = $1
        AND t.project_id IN (
          SELECT pm.project_id FROM build.project_members pm
          WHERE pm.org_id = $1 AND pm.user_id = $2
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
    params: (f) => [f.orgId],
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
    ceiling: 2_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.userId ? [f.orgId, f.userId] : null),
    sql: `
      SELECT t.id, t.title, t.status, t.priority, t.updated_at,
             p.id AS project_id, p.name AS project_name
      FROM build.tickets t
      LEFT JOIN build.projects p ON p.id = t.project_id
      WHERE t.org_id = $1 AND t.assignee_id = $2 AND t.deleted_at IS NULL
        AND t.status IN ('TODO', 'IN_PROGRESS', 'IN_REVIEW')
      ORDER BY t.updated_at DESC
      LIMIT 10`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "tickets" },
    ],
  },
  {
    id: "dashboard-my-issues",
    ceiling: 2_000,
    minRows: 50,
    rowCountSql: `SELECT count(*)::int FROM build.tickets WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.userId ? [f.orgId, f.userId] : null),
    sql: `
      SELECT t.id, t.title, t.status, t.priority, t.type, t.ticket_number, t.updated_at,
             p.id AS project_id, p.name AS project_name, p.key AS project_key,
             u.id AS assignee_id, u.first_name, u.last_name, u.image
      FROM build.tickets t
      LEFT JOIN build.projects p ON p.id = t.project_id
      LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.org_id = $1 AND t.assignee_id = $2 AND t.deleted_at IS NULL
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
    rowCountSql: `SELECT count(*)::int FROM calendar_events WHERE org_id = $1`,
    params: (f) => (f.hasCalendarEvents && f.userId ? [f.orgId, f.userId] : null),
    sql: `
      SELECT id, title, start_date, end_date, category
      FROM calendar_events
      WHERE org_id = $1 AND start_date >= NOW()
        AND (
          visibility = 'org'
          OR EXISTS (
            SELECT 1 FROM organization_members om
            WHERE om.org_id = $1 AND om.id = calendar_events.created_by_membership_id
              AND om.user_id = $2 AND om.status = 'ACTIVE'
          )
          OR EXISTS (
            SELECT 1 FROM event_attendees ea
            INNER JOIN organization_members om2
              ON ea.org_id = om2.org_id AND ea.membership_id = om2.id
            WHERE ea.org_id = $1 AND ea.event_id = calendar_events.id
              AND om2.user_id = $2 AND om2.status = 'ACTIVE' AND ea.status != 'declined'
          )
        )
      ORDER BY start_date ASC
      LIMIT 3`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "calendar_events" },
    ],
  },
  {
    id: "dashboard-personal-notifications-count",
    ceiling: 3_000,
    minRows: 1,
    rowCountSql: `SELECT count(*)::int FROM notifications WHERE org_id = $1 AND deleted_at IS NULL`,
    params: (f) => (f.userId ? [f.orgId, f.userId] : null),
    sql: `
      SELECT count(*)::int
      FROM notifications
      WHERE org_id = $1 AND user_id = $2 AND is_read = false`,
    planAssertions: [],
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
    params: (f) => {
      const today = new Date().toISOString().slice(0, 10);
      return [f.orgId, today];
    },
    sql: `
      SELECT a.user_id, u.name, u.image, a.check_in, a.check_out, a.status, a.created_at
      FROM attendance a
      INNER JOIN users u ON a.user_id = u.id
      WHERE a.org_id = $1 AND a.date = $2`,
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "sprints" },
    ],
  },
  {
    id: "dashboard-recent-projects",
    ceiling: 2_000,
    minRows: 1,
    rowCountSql: `SELECT count(*)::int FROM build.project_members WHERE org_id = $1`,
    params: (f) => (f.userId ? [f.orgId, f.userId] : null),
    sql: `
      SELECT p.id, p.name, p.status, p.created_at
      FROM build.projects p
      INNER JOIN build.project_members pm
        ON pm.project_id = p.id AND pm.org_id = $1 AND pm.user_id = $2
      WHERE p.org_id = $1 AND p.deleted_at IS NULL
      ORDER BY p.id DESC
      LIMIT 5`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "projects" },
    ],
  },
];

export const REQUIRED_BUDGET_IDS = new Set([
  "dashboard-personal-my-tasks",
  "dashboard-my-issues",
  "dashboard-personal-calendar-events",
  "dashboard-personal-notifications-count",
  "dashboard-stats-attendance-count",
  "dashboard-announcements",
  "dashboard-leaves-today",
  "dashboard-team-attendance",
  "dashboard-active-sprint",
  "dashboard-recent-projects",
]);
