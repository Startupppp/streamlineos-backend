import type { Permission } from "./types";

export const ACCOUNTING_PERMISSIONS: Permission[] = [
  {
    name: "accounting:read",
    resource: "accounting",
    action: "read",
    description: "Read accounting data",
  },
  {
    name: "accounting:create",
    resource: "accounting",
    action: "create",
    description: "Create accounting records",
  },
  {
    name: "accounting:update",
    resource: "accounting",
    action: "update",
    description: "Update accounting records",
  },
  {
    name: "accounting:accounts:read",
    resource: "accounting:accounts",
    action: "read",
    description: "View chart of accounts",
  },
  {
    name: "accounting:accounts:create",
    resource: "accounting:accounts",
    action: "create",
    description: "Create accounts",
  },
  {
    name: "accounting:accounts:update",
    resource: "accounting:accounts",
    action: "update",
    description: "Update accounts",
  },
  {
    name: "accounting:accounts:manage",
    resource: "accounting:accounts",
    action: "manage",
    description: "Manage all chart of accounts settings and archiving",
  },
  /**
   * NOT `scopable`, deliberately. The only column that could narrow a journal
   * is `gl_journals.posted_by_user_id`, and it is not an owner:
   *
   *  - Most of the 15 `gl_journal_source` values are machine-posted —
   *    `fx_reval`, `payroll_run`, `bank_fee`, `billing_invoice`,
   *    `withholding`. "Posted by" is whoever clicked a button in another
   *    module, or nobody.
   *  - It is nullable and `ON DELETE SET NULL`, so journals would drop out of
   *    a narrowed read the day the person who posted them left.
   *  - The aggregates over the same rows are not scopable and could not be:
   *    trial balance (`accounting:reports:read`) and account ledger
   *    (`accounting:general-ledger:read`). Narrowing the detail while the
   *    totals stay whole restricts nothing — it only stops the two agreeing.
   *
   * A journal is the audit record. Offering `own` here would promise a
   * confidentiality boundary that double-entry does not have.
   */
  {
    name: "accounting:journal:read",
    resource: "accounting:journal",
    action: "read",
    description: "View journal entries",
  },
  {
    name: "accounting:journal:create",
    resource: "accounting:journal",
    action: "create",
    description: "Create draft journal entries",
  },
  {
    name: "accounting:journal:post",
    resource: "accounting:journal",
    action: "post",
    description: "Post journal entries to the ledger",
  },
  {
    name: "accounting:journal:approve",
    resource: "accounting:journal",
    action: "approve",
    description: "Approve journal entries awaiting review",
  },
  {
    name: "accounting:journal:manage",
    resource: "accounting:journal",
    action: "manage",
    description: "Post and manage journal entries",
  },
  {
    name: "accounting:periods:read",
    resource: "accounting:periods",
    action: "read",
    description: "View accounting periods and their status",
  },
  {
    name: "accounting:periods:manage",
    resource: "accounting:periods",
    action: "manage",
    description: "Open and close accounting periods",
  },
  {
    name: "accounting:periods:reopen",
    resource: "accounting:periods",
    action: "reopen",
    description: "Reopen a closed accounting period",
  },
  {
    name: "accounting:general-ledger:read",
    resource: "accounting:general-ledger",
    action: "read",
    description: "View general ledger balances and transactions",
  },
  {
    name: "accounting:settings:read",
    resource: "accounting:settings",
    action: "read",
    description: "View accounting module settings",
  },
  {
    name: "accounting:settings:manage",
    resource: "accounting:settings",
    action: "manage",
    description: "Manage accounting module settings and configuration",
  },
  {
    name: "accounting:dimensions:read",
    resource: "accounting:dimensions",
    action: "read",
    description: "View tracking dimensions and cost centres",
  },
  {
    name: "accounting:dimensions:manage",
    resource: "accounting:dimensions",
    action: "manage",
    description: "Create and manage tracking dimensions",
  },
  /**
   * NOT `scopable`, deliberately. A receivable has no per-person owner, and
   * both columns that look like one are worse than no restriction:
   *
   *  - `ar_documents.created_by` is who KEYED the invoice, not who owns it.
   *    Narrowing to it empties the ledger for the AR manager who keyed none,
   *    and it is nullable / `ON DELETE SET NULL` besides.
   *  - `gl_parties` — the customer — has no `owner_user_id` at all. It reaches
   *    CRM only through the `external_refs` jsonb, deliberately ("a pointer,
   *    never a copy"), because accounting must work with CRM absent (A12).
   *    Scoping through the CRM account owner the way `lead-party-reader.ts`
   *    does would return nothing for every accounting-native party.
   *
   * `GET ar/aging` and `GET ar/open-items` are gated on this same key and are
   * BALANCE reports. `ArAgingService` already declines to assert `balanced`
   * once a query is filtered; an invisible RBAC filter would leave that
   * assertion standing over a subset and make it a lie.
   */
  {
    name: "accounting:receivables:read",
    resource: "accounting:receivables",
    action: "read",
    description: "View accounts receivable invoices and balances",
  },
  {
    name: "accounting:receivables:manage",
    resource: "accounting:receivables",
    action: "manage",
    description: "Create, edit, and void AR invoices",
  },
  {
    name: "accounting:receivables:approve",
    resource: "accounting:receivables",
    action: "approve",
    description: "Approve AR invoices for sending",
  },
  {
    name: "accounting:credit-notes:read",
    resource: "accounting:credit-notes",
    action: "read",
    description: "View credit notes",
  },
  {
    name: "accounting:credit-notes:create",
    resource: "accounting:credit-notes",
    action: "create",
    description: "Create credit notes",
  },
  {
    name: "accounting:credit-notes:manage",
    resource: "accounting:credit-notes",
    action: "manage",
    description: "Manage and apply credit notes",
  },
  {
    name: "accounting:reminders:read",
    resource: "accounting:reminders",
    action: "read",
    description: "View payment reminders and schedules",
  },
  {
    name: "accounting:reminders:manage",
    resource: "accounting:reminders",
    action: "manage",
    description: "Configure and send payment reminders",
  },
  {
    name: "accounting:collections:read",
    resource: "accounting:collections",
    action: "read",
    description: "View collections queue and overdue accounts",
  },
  {
    name: "accounting:collections:manage",
    resource: "accounting:collections",
    action: "manage",
    description: "Manage collections actions and escalations",
  },
  /**
   * NOT `scopable`, deliberately — the payables half of the reasoning on
   * `accounting:receivables:read` above. `ap_documents.created_by` is the
   * clerk who entered the bill, and the vendor (`gl_parties`) carries no
   * owner. Nothing on either row answers "whose bill is this".
   */
  {
    name: "accounting:payables:read",
    resource: "accounting:payables",
    action: "read",
    description: "View accounts payable bills and balances",
  },
  {
    name: "accounting:payables:manage",
    resource: "accounting:payables",
    action: "manage",
    description: "Create, edit, and void AP bills",
  },
  {
    name: "accounting:payables:approve",
    resource: "accounting:payables",
    action: "approve",
    description: "Approve AP bills for payment",
  },
  {
    name: "accounting:vendor-credits:read",
    resource: "accounting:vendor-credits",
    action: "read",
    description: "View vendor credits",
  },
  {
    name: "accounting:vendor-credits:create",
    resource: "accounting:vendor-credits",
    action: "create",
    description: "Create vendor credits",
  },
  {
    name: "accounting:vendor-credits:manage",
    resource: "accounting:vendor-credits",
    action: "manage",
    description: "Manage and apply vendor credits",
  },
  {
    name: "accounting:payment-runs:read",
    resource: "accounting:payment-runs",
    action: "read",
    description: "View payment runs",
  },
  {
    name: "accounting:payment-runs:manage",
    resource: "accounting:payment-runs",
    action: "manage",
    description: "Create and manage payment runs",
  },
  {
    name: "accounting:payment-runs:approve",
    resource: "accounting:payment-runs",
    action: "approve",
    description: "Approve payment runs for execution",
  },
  {
    name: "accounting:banking:read",
    resource: "accounting:banking",
    action: "read",
    description: "View bank accounts and transactions",
  },
  {
    name: "accounting:banking:manage",
    resource: "accounting:banking",
    action: "manage",
    description: "Manage bank accounts and categorise transactions",
  },
  {
    name: "accounting:banking:import",
    resource: "accounting:banking",
    action: "import",
    description: "Import bank statements",
  },
  {
    name: "accounting:banking:reconcile",
    resource: "accounting:banking",
    action: "reconcile",
    description: "Reconcile bank accounts",
  },
  {
    // One pair covers every document family. `document_type` is a path segment,
    // so a static @RequirePermission cannot vary per family, and splitting the
    // key per family would gate the same file differently depending on which
    // route reached it.
    name: "accounting:attachments:read",
    resource: "accounting:attachments",
    action: "read",
    description: "List and download files attached to accounting documents",
  },
  {
    name: "accounting:attachments:manage",
    resource: "accounting:attachments",
    action: "manage",
    description: "Attach files to accounting documents, and remove them",
  },
  {
    name: "accounting:taxes:read",
    resource: "accounting:taxes",
    action: "read",
    description: "View tax rates, returns, and filings",
  },
  {
    name: "accounting:taxes:manage",
    resource: "accounting:taxes",
    action: "manage",
    description: "Manage tax rates and prepare tax returns",
  },
  {
    name: "accounting:taxes:pay",
    resource: "accounting:taxes",
    action: "pay",
    description: "Submit and pay tax returns",
  },
  {
    name: "accounting:reports:read",
    resource: "accounting:reports",
    action: "read",
    description: "View accounting reports",
  },
  {
    name: "accounting:reports:export",
    resource: "accounting:reports",
    action: "export",
    description: "Export accounting reports",
  },
  {
    name: "accounting:budgets:read",
    resource: "accounting:budgets",
    action: "read",
    description: "View budgets and actuals",
  },
  {
    name: "accounting:budgets:create",
    resource: "accounting:budgets",
    action: "create",
    description: "Create budgets",
  },
  {
    name: "accounting:budgets:update",
    resource: "accounting:budgets",
    action: "update",
    description: "Update budgets",
  },
  {
    name: "accounting:budgets:approve",
    resource: "accounting:budgets",
    action: "approve",
    description: "Approve budgets",
  },
  {
    name: "accounting:forecast:read",
    resource: "accounting:forecast",
    action: "read",
    description: "View financial forecasts",
  },
  {
    name: "accounting:forecast:manage",
    resource: "accounting:forecast",
    action: "manage",
    description: "Create and manage financial forecasts",
  },
  {
    name: "accounting:assets:read",
    resource: "accounting:assets",
    action: "read",
    description: "View fixed assets register",
  },
  {
    name: "accounting:assets:create",
    resource: "accounting:assets",
    action: "create",
    description: "Register new fixed assets",
  },
  {
    name: "accounting:assets:update",
    resource: "accounting:assets",
    action: "update",
    description: "Update fixed asset details",
  },
  {
    name: "accounting:assets:manage",
    resource: "accounting:assets",
    action: "manage",
    description: "Manage depreciation, disposals, and revaluations",
  },
  {
    name: "accounting:reimbursements:read",
    resource: "accounting:reimbursements",
    action: "read",
    description: "View reimbursement requests",
  },
  {
    name: "accounting:reimbursements:manage",
    resource: "accounting:reimbursements",
    action: "manage",
    description: "Process and manage reimbursements",
  },
  {
    name: "accounting:reimbursements:approve",
    resource: "accounting:reimbursements",
    action: "approve",
    description: "Approve reimbursement requests",
  },
  /**
   * NOT `scopable`, and it has no route of its own.
   *
   * The approval instances live in HR's workflow tables. Its sibling
   * `accounting:approvals:decide` is used by `hr-workflow-engine.service.ts`
   * purely as a ROLE MARKER: the `finance_role` assignee rule resolves it
   * through `membersWithPermission` to find who counts as finance. This read
   * half has no surface. If one is ever built it will read
   * `hr_workflow_instances`, and the "approvals assigned to me" narrowing
   * belongs there, on HR's key, against HR's assignee column — not here.
   *
   * Kept rather than retired because organisations may already hold it; that
   * is a separate decision from whether it promises a scope.
   */
  {
    name: "accounting:approvals:read",
    resource: "accounting:approvals",
    action: "read",
    description: "View accounting approval workflows",
  },
  {
    name: "accounting:approvals:decide",
    resource: "accounting:approvals",
    action: "decide",
    description: "Approve or reject accounting approval requests",
  },
  {
    name: "accounting:audit:read",
    resource: "accounting:audit",
    action: "read",
    description: "View accounting audit trail",
  },
  {
    name: "accounting:audit:export",
    resource: "accounting:audit",
    action: "export",
    description: "Export accounting audit trail",
  },
  {
    name: "accounting:recurring:read",
    resource: "accounting:recurring",
    action: "read",
    description: "View recurring transaction templates",
  },
  {
    name: "accounting:recurring:manage",
    resource: "accounting:recurring",
    action: "manage",
    description: "Create and manage recurring transaction templates",
  },
  {
    name: "accounting:ai:use",
    resource: "accounting:ai",
    action: "use",
    description:
      "Use AI features in the accounting module (variance narration, reconciliation explanation, document extraction)",
  },
];
