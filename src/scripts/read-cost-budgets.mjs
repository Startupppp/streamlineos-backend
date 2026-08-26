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
    planAssertions: [
      { kind: "require-index-only-scan", relation: "ticket_assignees" },
      { kind: "forbid-seq-scan", relation: "ticket_assignees" },
    ],
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
    planAssertions: [
      { kind: "require-index-only-scan", relation: "ticket_assignees" },
      { kind: "forbid-seq-scan", relation: "ticket_assignees" },
    ],
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
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "tickets" },
    ],
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
      SELECT id, sender_id, content, message_type, reactions, created_at, is_edited
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
      SELECT id, name, slug, icon, cover_image, audience, created_at
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
      ORDER BY first_name ASC, last_name ASC
      LIMIT 100`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "organization_people" },
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
      SELECT id, leave_type_id, entry_type, days, effective_date
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
      SELECT id, title, stage, value, expected_close_date, assigned_to_id
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
      SELECT id, user_id, worker_id, status, gross_pay, net_pay
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
      SELECT id, run_employee_id, component_code, amount, quantity
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
      WHERE org_id = $1 AND status <> 'ARCHIVED'
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
      SELECT id, product_variant_id, location_id, quantity_available, quantity_reserved
      FROM inv_stock_levels
      WHERE org_id = $1
      ORDER BY product_variant_id ASC
      LIMIT 100`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "inv_stock_levels" },
    ],
  },
  {
    id: "inv-stock-transactions",
    ceiling: 15_000,
    minRows: 100,
    rowCountSql: `SELECT count(*)::int FROM inv_stock_transactions WHERE org_id = $1`,
    params: (f) => [f.orgId],
    sql: `
      SELECT id, product_variant_id, transaction_type, quantity, posting_date, created_at
      FROM inv_stock_transactions
      WHERE org_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    planAssertions: [
      { kind: "forbid-seq-scan", relation: "inv_stock_transactions" },
    ],
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
];
