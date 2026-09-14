/**
 * The per-module benchmark declaration behind contracts/benchmark-manifest.json.
 *
 * WHAT THIS FILE IS NOT: a second catalog of SQL. Every benchmark named here resolves to an entry
 * that already exists — `src/scripts/read-cost-budgets.mjs` (70 route read paths, ticket 22) or
 * `test/perf/heavy-query-catalog.mjs` (36 named heavy paths). Duplicating the SQL would create two
 * ratchets over one query, and the looser one would win silently. This file adds only the grouping
 * and the per-benchmark facts those catalogs do not carry: which module owns the path, which tables
 * make up that module's dataset, and whether the statement is ORDINARY or COMPLEX under PRD §12.1.
 *
 * STATEMENT CLASS — the rule, applied uniformly, so the classification is auditable rather than
 * convenient. A statement is COMPLEX when it does at least one of:
 *   (a) aggregates over the tenant's set (SUM/COUNT/GROUP BY beyond the `count(*) OVER ()` that
 *       every paginated list carries for its total),
 *   (b) similarity, full-text or vector search,
 *   (c) joins three or more base tables.
 * Everything else is ORDINARY. PRD §12.1 gives ordinary statements a 50 ms p95 ceiling and approved
 * complex statements 200 ms; a COMPLEX entry without an `approval` string is a validation error, so
 * the looser ceiling can never be claimed by omission.
 *
 * A slow ordinary statement is NOT reclassified as complex to make it pass. `notifications-list` is
 * an eleven-partition Append and is declared ORDINARY, because it is a plain paginated list and the
 * breach is the finding.
 *
 * EVERY read-cost budget in the catalog is claimed by exactly one module. The five that were not —
 * `inbox-unified-notifications-page`, `inbox-unified-unread-count`, `chat-realtime-token-channel-ids`,
 * `support-realtime-token-ticket-ids` and `calendar-events-visible-batch` — are the unified-inbox and
 * realtime-token paths PRD-C145 names. They existed in `read-cost-budgets.mjs` and were measured by
 * that instrument, but being in no module kept them out of the manifest entirely, so the manifest
 * carried no p95 for the very paths the criterion asks about. All five are declared ORDINARY:
 * `calendar-events-visible-batch` is the slowest statement in the corpus and is still ordinary, per
 * the rule below that a slow statement is not reclassified to make it pass.
 *
 * SIX heavy-query ids are deliberately NOT claimed by any module:
 * `fanout-roles-semijoin-rewrite`, `read-section-page-union-rewrite`,
 * `membership-unread-count-equivalent`, `search-ticket-ilike-under-rls`, `search-ilike-under-rls`
 * and `dashboard-recent-activity-fullrow`. Each is the losing arm of a head-to-head comparison in
 * `heavy-query-catalog.mjs` — a query the application does not issue, kept so the winning shape can
 * be shown to win. Benchmarking a path nothing calls would inflate coverage with numbers no
 * regression could ever be attributed to.
 */

/** Ticket 22 and report 00 measure these four; the skew is the point, so all four are declared. */
export const TENANTS = [
  { label: "large", id: "aaaaaaaa-1111-0000-0000-000000000001", share: "89.93%" },
  { label: "mid", id: "aaaaaaaa-1111-0000-0000-000000000003", share: "9.0%" },
  { label: "small", id: "aaaaaaaa-1111-0000-0000-000000000002", share: "0.90%" },
  { label: "tiny", id: "aaaaaaaa-1111-0000-0000-000000000004", share: "0.18%" },
];

export { STATEMENT_CEILING_MS } from "../../src/scripts/timing-slo-thresholds.mjs";

const C = (approval) => ({ class: "complex", approval });
const O = { class: "ordinary", approval: null };

export const MODULES = [
  {
    id: "notifications",
    title: "Notifications",
    surface: "shell — issued on every authenticated page load",
    tables: ["notifications", "notification_read_watermarks"],
    readCostBudgets: {
      "notifications-list": O,
      "notifications-unread-count": O,
      "inbox-unified-notifications-page": O,
      "inbox-unified-unread-count": O,
    },
    heavyQueries: [
      "unread-count",
      "unread-section-page",
      "read-section-page-or-watermark",
      "unified-inbox-unread-count-by-user",
      "unified-inbox-list-by-user",
      "notification-list-search-ilike",
      "fanout-all-members-page",
      "fanout-roles-exists",
    ],
    concurrencyProbe: "notifications-unread-count",
  },
  {
    id: "chat",
    title: "Chat",
    surface: "shell — unread badge on every page load; channel history on open",
    tables: ["chat_channels", "chat_channel_members", "chat_messages", "chat_saved_messages"],
    readCostBudgets: {
      "chat-channel-list": C("three-table join (chat_channels × chat_channel_members × organization_members) is the membership check; it cannot be expressed with fewer without trusting a client-supplied membership id"),
      "chat-messages-page": O,
      "chat-channel-members": O,
      "chat-saved-messages": O,
      "chat-realtime-token-channel-ids": O,
    },
    heavyQueries: [],
    concurrencyProbe: "chat-channel-list",
  },
  {
    id: "calendar",
    title: "Calendar",
    surface: "range/history reads, free-busy, recurrence expansion and the reminder sweep",
    tables: ["calendar_events", "event_attendees"],
    readCostBudgets: {
      "dashboard-personal-calendar-events": O,
      "calendar-events-visible-batch": O,
    },
    heavyQueries: [
      "export-calendar-range",
      "freebusy-conflict-first-page",
      "freebusy-conflict-total-rows",
      "freebusy-ooo-leave",
      "recurrence-series-page",
      "recurrence-exceptions-uncapped",
      "reminder-nonrecurring-due",
      "reminder-recurring-candidates",
      "reminder-exception-window",
      "reminder-attendee-fanout-page",
    ],
    concurrencyProbe: "dashboard-personal-calendar-events",
  },
  {
    id: "mail",
    title: "Inbox (mail)",
    surface: "the cached metadata read; the provider fetch is excluded from every ceiling here",
    tables: ["mail_message_metadata"],
    readCostBudgets: {
      "mail-inbox-cached": O,
    },
    heavyQueries: [],
    concurrencyProbe: "mail-inbox-cached",
  },
  {
    id: "dashboard-home",
    title: "Home / dashboard",
    surface: "the section fan-out behind the authenticated landing page",
    tables: ["announcements"],
    readCostBudgets: {
      "dashboard-personal-my-tasks": O,
      "dashboard-my-issues": O,
      "dashboard-personal-notifications-count": O,
      "dashboard-stats-attendance-count": C("COUNT over the tenant's attendance for a date"),
      "dashboard-announcements": O,
      "dashboard-leaves-today": O,
      "dashboard-team-attendance": C("joins attendance × organization_members × users and aggregates per member"),
      "dashboard-active-sprint": O,
      "dashboard-recent-projects": O,
    },
    heavyQueries: [
      "dashboard-unread-notifications",
      "dashboard-upcoming-events",
      "dashboard-recent-activity-projected",
      "dashboard-announcements",
      "dashboard-recent-notifications",
      "dashboard-member-headcount",
    ],
    concurrencyProbe: "dashboard-active-sprint",
  },
  {
    id: "build",
    title: "Build (projects & product)",
    surface: "board, list and my-work reads plus the roadmap/feedback/changelog surfaces",
    tables: ["build.tickets", "build.projects", "build.ticket_assignees", "timesheets"],
    readCostBudgets: {
      "scoped-board-page": C("EXISTS semijoin against build.ticket_assignees on top of a two-table read — three base tables"),
      "my-work": C("joins build.tickets × build.projects × build.project_members"),
      "ticket-list-project": O,
      "ticket-org-assigned-to-me": O,
      "build-all-work": C("joins build.tickets × build.projects and filters through a project-membership subquery"),
      "build-roadmap-list": O,
      "build-feedback-list": O,
      "build-changelog-list": O,
      "timesheets-pending-org": O,
      "timesheets-mine": O,
    },
    heavyQueries: [],
    concurrencyProbe: "ticket-org-assigned-to-me",
  },
  {
    id: "search",
    title: "Search",
    surface: "the SECURITY DEFINER trigram and vector entry points",
    tables: ["kb_article_chunks"],
    readCostBudgets: {
      "search-tickets-sdf": C("trigram similarity search"),
      "search-lead-party-sdf": C("trigram similarity search"),
      "search-deal-sdf": C("trigram similarity search"),
      "search-contact-party-sdf": C("trigram similarity search"),
      "search-client-party-sdf": C("trigram similarity search"),
      "kb-page-id-probe-sdf": C("trigram similarity search"),
    },
    heavyQueries: [
      "vector-ann-security-definer",
      "vector-ann-direct-under-rls",
      "vector-ann-org-filtered-direct",
      "search-trigram-security-definer",
      "search-ticket-trigram-sdf",
      "search-kbpage-fts-under-rls",
    ],
    concurrencyProbe: "search-tickets-sdf",
  },
  {
    id: "kb",
    title: "Knowledge base",
    surface: "space, page and recently-updated reads",
    tables: ["kb_pages", "kb_spaces", "kb_article_chunks"],
    readCostBudgets: {
      "kb-space-pages": O,
      "kb-recently-updated": O,
      "kb-spaces-list": O,
      "kb-page-visits-mine": O,
    },
    heavyQueries: [],
    concurrencyProbe: "kb-recently-updated",
  },
  {
    id: "org-access",
    title: "Organization & access",
    surface: "member roster, people directory and the module-access roster",
    tables: ["organization_members", "roles"],
    readCostBudgets: {
      "org-members-list": O,
      "org-people-list": C("joins organization_members × users × hr_people"),
      "module-access-roster": C("joins roles × role_assignments × organization_members and aggregates per module"),
    },
    heavyQueries: [],
    concurrencyProbe: "org-members-list",
  },
  {
    id: "hr",
    title: "HR",
    surface: "employee roster, leave and attendance reads",
    tables: ["hr_people", "hr_employments", "attendance", "leave_requests"],
    readCostBudgets: {
      "employee-record-list-canonical": C("joins users × hr_people × hr_employments"),
      "employee-reporting-line-lookup": C("joins hr_people × hr_employments × the manager's hr_people row"),
      "leave-requests-pending-org": O,
      "leave-requests-mine": O,
      "attendance-mine": O,
      "leave-ledger-mine": O,
      "leave-balances-org": C("SUM over the accrual ledger grouped per member and leave type"),
      "leave-accrual-ledger-dedup": C("aggregates the accrual ledger to detect duplicate postings"),
      "leave-accrual-balance-read": C("SUM over the accrual ledger for a year"),
    },
    heavyQueries: [],
    concurrencyProbe: "leave-requests-pending-org",
  },
  {
    id: "crm",
    title: "CRM",
    surface: "contact, lead, deal and client list reads",
    tables: ["contacts", "leads", "deals", "clients", "business_parties"],
    readCostBudgets: {
      "contacts-list": O,
      "leads-active": O,
      "leads-assigned-to-me": O,
      "deals-pipeline": O,
      "clients-list": O,
    },
    heavyQueries: [],
    concurrencyProbe: "leads-active",
  },
  {
    id: "finance-accounting",
    title: "Finance & accounting",
    surface: "invoice, bill, journal and receivables reads",
    tables: ["invoices", "purchase_bills", "gl_journals", "clients"],
    readCostBudgets: {
      "invoices-open": O,
      "purchase-bills-list": O,
      "gl-journals-list": O,
      "accounting-receivables-list": C("joins clients × invoices × a payments sub-aggregate and SUMs outstanding per client"),
      "finance-tax-payments": O,
      "finance-reminder-policies": O,
    },
    heavyQueries: [],
    concurrencyProbe: "invoices-open",
  },
  {
    id: "payroll",
    title: "Payroll",
    surface: "run list and per-run employee/line-item reads",
    tables: ["payroll_runs", "payroll_line_items"],
    readCostBudgets: {
      "payroll-runs-list": O,
      "payroll-run-employees": O,
      "payroll-line-items": O,
    },
    heavyQueries: [],
    concurrencyProbe: "payroll-runs-list",
  },
  {
    id: "inventory",
    title: "Inventory",
    surface:
      "product, stock-level, stock-transaction, PO and vendor reads, the two keyset" +
      " cursors and the two genealogy hops",
    tables: [
      "inv_products",
      "inv_product_variants",
      "inv_stock_levels",
      "inv_stock_transactions",
      "inv_purchase_orders",
      "inv_vendors",
      "inv_audit_events",
    ],
    /*
      The four below were added to `read-cost-budgets.mjs` by the genealogy and
      cursor-pagination work and claimed by nothing, which is the exact hole the
      header's five unified-inbox budgets fell through: measured by the read-cost
      instrument, absent from the manifest, carrying no class and no ceiling.
      `validateModules` refuses an unclaimed budget, but it only runs at capture
      time, so nothing said so until the next capture was attempted.

      All four are ORDINARY. Neither cursor aggregates, searches or leaves its one
      table. Both genealogy hops read `inv_stock_transactions` and nothing else —
      the LATERAL walk and its correction-EXISTS are the same base table again, not
      a third one — and each hop is capped at 26 rows anchored on fixed ids. They
      are the slowest of the four and stay ordinary anyway, per the rule above that
      a slow statement is not reclassified to make it pass.
    */
    readCostBudgets: {
      "inv-products-list": O,
      "inv-stock-levels": O,
      "inv-stock-transactions": O,
      "inv-stock-transactions-cursor": O,
      "inv-audit-events-cursor": O,
      "inv-genealogy-item-hop": O,
      "inv-genealogy-document-hop": O,
      "inv-purchase-orders": O,
      "inv-vendors-list": O,
    },
    heavyQueries: [],
    concurrencyProbe: "inv-stock-transactions",
  },
  {
    id: "support",
    title: "Support",
    surface: "the SLA-ordered queue and the assigned-to-me read",
    tables: ["support_tickets"],
    readCostBudgets: {
      "support-ticket-queue": O,
      "support-ticket-assigned-to-me": O,
      "support-realtime-token-ticket-ids": O,
    },
    heavyQueries: [],
    concurrencyProbe: "support-ticket-queue",
  },
];

/** `business_parties` is the one table in the declaration that names its tenant column differently. */
export const ORG_COLUMN = { business_parties: "organization_id" };

export function orgColumnFor(table) {
  return ORG_COLUMN[table.replace(/^public\./, "")] ?? "org_id";
}

export function allDeclaredBenchmarkIds() {
  const out = [];
  for (const m of MODULES)
    for (const id of Object.keys(m.readCostBudgets)) out.push({ module: m.id, id, source: "read-cost" });
  for (const m of MODULES)
    for (const id of m.heavyQueries) out.push({ module: m.id, id, source: "heavy-query" });
  return out;
}

/**
 * Validation the runner and the gate both apply. Returns a list of strings; empty means valid.
 * `knownReadCost` / `knownHeavy` are the id sets of the two catalogs, passed in so this file has no
 * import cycle with them and so the gate can validate a manifest without a database.
 */
export function validateModules(modules, knownReadCost, knownHeavy) {
  const errors = [];
  const seenModule = new Set();
  const seenBenchmark = new Map();
  for (const m of modules) {
    if (seenModule.has(m.id)) errors.push(`duplicate module id "${m.id}"`);
    seenModule.add(m.id);
    for (const field of ["title", "surface", "concurrencyProbe"])
      if (typeof m[field] !== "string" || m[field].length === 0)
        errors.push(`${m.id}: missing ${field}`);
    if (!Array.isArray(m.tables) || m.tables.length === 0) errors.push(`${m.id}: no tables declared`);
    for (const [id, spec] of Object.entries(m.readCostBudgets ?? {})) {
      if (knownReadCost && !knownReadCost.has(id))
        errors.push(`${m.id}: read-cost budget "${id}" does not exist in read-cost-budgets.mjs`);
      if (spec.class !== "ordinary" && spec.class !== "complex")
        errors.push(`${m.id}/${id}: statement class must be "ordinary" or "complex", got "${spec.class}"`);
      if (spec.class === "complex" && (typeof spec.approval !== "string" || spec.approval.length < 10))
        errors.push(`${m.id}/${id}: a complex statement claims the 200 ms ceiling and needs an approval reason`);
      if (spec.class === "ordinary" && spec.approval !== null)
        errors.push(`${m.id}/${id}: an ordinary statement must not carry an approval`);
      if (seenBenchmark.has(id))
        errors.push(`benchmark "${id}" is claimed by both ${seenBenchmark.get(id)} and ${m.id}`);
      seenBenchmark.set(id, m.id);
    }
    for (const id of m.heavyQueries ?? []) {
      if (knownHeavy && !knownHeavy.has(id))
        errors.push(`${m.id}: heavy query "${id}" does not exist in heavy-query-catalog.mjs`);
    }
    if (!Object.prototype.hasOwnProperty.call(m.readCostBudgets ?? {}, m.concurrencyProbe))
      errors.push(`${m.id}: concurrencyProbe "${m.concurrencyProbe}" is not one of the module's read-cost budgets`);
  }
  /*
    The direction that was NOT checked, and it is the one that loses coverage silently. Claiming a
    benchmark that does not exist was already an error; leaving one unclaimed was not, so five
    budgets — every unified-inbox and realtime-token path — sat in read-cost-budgets.mjs being
    measured by that instrument while the manifest carried no entry, no class and no ceiling for
    them. Nothing failed, the manifest simply described a smaller corpus than the catalog holds.
    Heavy queries are exempt because six are deliberately unclaimed, named in the header above.
  */
  if (knownReadCost) {
    for (const id of knownReadCost)
      if (!seenBenchmark.has(id))
        errors.push(
          `read-cost budget "${id}" exists in read-cost-budgets.mjs but no module claims it, so the ` +
            `manifest would carry no ceiling for it. Add it to the module that owns the path.`,
        );
  }
  return errors;
}
