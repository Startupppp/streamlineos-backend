/**
 * Cache invalidation matrix — every namespace or key pattern listed here must
 * carry either a list of writes that invalidate it or an explicit TTL-only
 * designation.  A new cached read without a row in this file is caught in
 * review.
 *
 * This file tracks INVALIDATION, not call-site style.  It used to carry a
 * `migrated` flag per entry counting call sites moved onto the `*ForOrg`
 * cache wrappers; that flag has been removed and the migration reverted.
 * A `CACHE_KEYS.*` factory already takes `orgId` as a required typed
 * parameter, so omitting the tenant is already a compile error — the safety
 * property the wrappers were meant to add.  Swapping a factory for a literal
 * passed to `*ForOrg` only moves the key into a magic string repeated at every
 * call site, so a reader and its invalidator must independently agree on that
 * string: the exact writer/invalidator divergence this matrix exists to catch.
 * Use `CACHE_KEYS` for anything with a factory; reach for a `*ForOrg` wrapper
 * only for a genuinely new key that has no registry entry.
 *
 * Redis memory budget (volatile-lru, operator must set in Upstash console):
 *   Permission sets       1 M users × ~5 KB each          ≈  5 GB
 *   RBAC matrices         ~100 K orgs × ~10 KB each        ≈  1 GB
 *   Dashboards + KPIs     ~100 K orgs × ~50 KB each        ≈  5 GB
 *   Inventory + reports   heavy modules × ~100 KB each     ≈ 10 GB
 *   Finance reports       ~50 K orgs × ~50 KB each         ≈  3 GB
 *   Misc lists + details  all other orgs                   ≈ 11 GB
 *                                                Total ≈ 35 GB ceiling
 *
 * Eviction policy: volatile-lru
 *   All cache data keys carry a TTL (set via { ex: ttlSeconds }).
 *   Namespace version counters carry NO TTL by design — volatile-lru never
 *   evicts them, which is correct (evicting a counter would silently reset the
 *   version and allow stale entries to resurface).
 *   Session-revocation tombstones also carry NO TTL, for the same reason.
 *
 * Session-revocation safety:
 *   Tombstones at revoked:session:<id> carry NO TTL, so volatile-lru — which
 *   only evicts keys that have one — can never drop a live revocation. This is
 *   the same protection namespace version counters get above. They are reclaimed
 *   by SessionsService.pruneExpiredRevocations, driven by the companion sorted
 *   set revoked:sessions:index (scored by expiry), via the
 *   POST /cron/session-revocation-prune sweep rather than by Redis expiry.
 *
 *   Do NOT "fix" this by falling back to the database on a null lookup: null is
 *   also what every non-revoked session returns, and JwtAuthGuard is a global
 *   APP_GUARD, so that turns a rare edge case into a database round trip on
 *   effectively all traffic. That was tried on 2026-08-26 and reverted.
 */

export type InvalidationTrigger =
  | { kind: "write"; events: string[] }
  | { kind: "ttl-only"; reason: string };

export interface CacheNamespaceEntry {
  namespace: string;
  description: string;
  invalidation: InvalidationTrigger;
}

export const CACHE_INVALIDATION_MATRIX: readonly CacheNamespaceEntry[] = [
  {
    namespace: "acc:settings:<orgId>",
    description: "Accounting settings (currency, fiscal year, basis)",
    invalidation: {
      kind: "write",
      events: [
        "AccountingSettingsService.updateSettings",
        "AccountingSettingsService.updatePaymentTerms",
        "CoaService.applyTemplate",
        "SystemAccountsService.upsertSystemAccount",
        "OpeningBalancesService.postOpeningBalances",
      ],
    },
  },
  {
    namespace: "acc:setup-status:<orgId>",
    description: "Accounting wizard setup completion status",
    invalidation: {
      kind: "write",
      events: ["AccountingSettingsService.updateSettings"],
    },
  },
  {
    namespace: "acc:coa:tree:<orgId>",
    description: "Chart of accounts tree",
    invalidation: {
      kind: "write",
      events: [
        "CoaService.createAccount",
        "CoaService.updateAccount",
        "CoaService.deleteAccount",
        "CoaService.applyTemplate",
      ],
    },
  },
  {
    namespace: "acc:dimensions:<orgId>",
    description: "Accounting dimensions (cost centres, projects, etc.)",
    invalidation: {
      kind: "write",
      events: [
        "DimensionsService.createDimension",
        "DimensionsService.updateDimension",
        "DimensionsService.createDimensionValue",
      ],
    },
  },
  {
    namespace: "accounting:periods:<orgId>",
    description: "Accounting periods list",
    invalidation: {
      kind: "write",
      events: [
        "PeriodsService.generatePeriods",
        "PeriodsService.closePeriod",
        "PeriodsService.lockPeriod",
        "PeriodsService.reopenPeriod",
      ],
    },
  },
  {
    namespace: "acc:statements:<orgId>",
    description: "Financial statements: balance sheet, trial balance, P&L, cash flow",
    invalidation: {
      kind: "write",
      events: [
        "FinancePostingService.postJournal",
        "FinancePostingService.reverseJournal",
        "AccountingLedgerService.postJournalEntry",
        "AccountingLedgerService.reverseJournalEntry",
      ],
    },
  },
  {
    namespace: "fin:reports:<orgId>",
    description: "Finance overview, vendor/customer statements, analytics, project profitability",
    invalidation: {
      kind: "write",
      events: [
        "FinancePostingService.postJournal",
        "FinancePostingService.reverseJournal",
        "AccountingLedgerService.postJournalEntry",
        "AccountingLedgerService.reverseJournalEntry",
        "InvoicesWriteService.createInvoice",
        "InvoicesWriteService.updateInvoice",
        "InvoicesWriteService.voidInvoice",
        "TransfersService (bank transfers)",
      ],
    },
  },
  {
    namespace: "fin:bva:<orgId>:<budgetId>",
    description: "Budget-vs-actual report per budget",
    invalidation: {
      kind: "write",
      events: ["FinancePostingService.postJournal", "InvoicesWriteService (any invoice write)"],
    },
  },
  {
    namespace: "fin:forecast:<orgId>",
    description: "Finance planning forecast",
    invalidation: {
      kind: "write",
      events: ["InvoicesWriteService (any invoice write)", "TransfersService (any transfer)"],
    },
  },
  {
    namespace: "fin:banking:accounts:<orgId>",
    description: "Bank accounts list/detail",
    invalidation: {
      kind: "write",
      events: ["BankAccountsService (any write)"],
    },
  },
  {
    namespace: "fin:assets:list:<orgId>",
    description: "Fixed assets list",
    invalidation: {
      kind: "write",
      events: ["AssetsService (any write)"],
    },
  },
  {
    namespace: "fin:asset-categories:<orgId>",
    description: "Asset categories",
    invalidation: { kind: "ttl-only", reason: "Low-churn reference data; TTL 5 min is acceptable" },
  },
  {
    namespace: "fin:tax-codes:<orgId>",
    description: "Tax codes",
    invalidation: { kind: "ttl-only", reason: "Low-churn reference data; TTL 5 min is acceptable" },
  },
  {
    namespace: "fin:tax-payments:<orgId>",
    description: "Tax payments",
    invalidation: {
      kind: "write",
      events: ["TaxService (any write)"],
    },
  },
  {
    namespace: "fin:tax-dashboard:<orgId>",
    description: "Tax summary dashboard",
    invalidation: {
      kind: "write",
      events: ["InvoicesWriteService (any invoice write)"],
    },
  },
  {
    namespace: "fin:tax-reports:<orgId>",
    description: "Tax reports",
    invalidation: {
      kind: "write",
      events: ["InvoicesWriteService (any invoice write)"],
    },
  },
  {
    namespace: "fin:expense-policies:<orgId>",
    description: "Expense policies",
    invalidation: {
      kind: "write",
      events: ["ExpensePoliciesService (any write)"],
    },
  },
  {
    namespace: "org:hierarchy:<orgId>",
    description: "Organisation hierarchy tree (all shapes)",
    invalidation: {
      kind: "write",
      events: ["OrgHierarchyCacheService.invalidateAfterMutation (any hierarchy mutation)"],
    },
  },
  {
    namespace: "hr:headcount:<orgId>",
    description: "HR headcount aggregate",
    invalidation: {
      kind: "write",
      events: ["OrgHierarchyCacheService.invalidateAfterMutation (any hierarchy mutation)"],
    },
  },
  {
    namespace: "hr:leave-analytics:<orgId>",
    description: "Leave analytics (scope+year sub-keyed)",
    invalidation: {
      kind: "write",
      events: [
        "LeavesWriteService (create/cancel)",
        "LeaveDecisionEffectsService (approve/reject)",
      ],
    },
  },
  {
    namespace: "hr:expenses:<orgId>",
    description: "Expense list (user+admin-flag+filters sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["ExpensesService (any write)"],
    },
  },
  {
    namespace: "sales:kpis:<orgId>",
    description: "Sales KPIs (from+to+repId sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["DealsService.updateDeal (stage change)"],
    },
  },
  {
    namespace: "crm:contacts:list:<orgId>",
    description: "CRM contacts list",
    invalidation: {
      kind: "write",
      events: ["ContactsService (any write)"],
    },
  },
  {
    namespace: "crm:organizations:list:<orgId>",
    description: "CRM organizations list",
    invalidation: {
      kind: "write",
      events: ["CrmOrganizationsService (any write)"],
    },
  },
  {
    namespace: "crm:organizations:detail:<orgId>",
    description: "CRM organization detail (id sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["CrmOrganizationsService (any write)"],
    },
  },
  {
    namespace: "inv:products:list:<orgId>",
    description: "Inventory products list",
    invalidation: {
      kind: "write",
      events: ["InventoryProductsService (any write)"],
    },
  },
  {
    namespace: "inv:po:list:<orgId>",
    description: "Purchase orders list",
    invalidation: {
      kind: "write",
      events: ["PurchaseOrdersService (any write)"],
    },
  },
  {
    namespace: "inv:grn:list:<orgId>",
    description: "Goods-received notes list",
    invalidation: {
      kind: "write",
      events: ["GrnService (any write)"],
    },
  },
  {
    namespace: "inv:vendors:list:<orgId>",
    description: "Vendor list",
    invalidation: {
      kind: "write",
      events: ["VendorsService (any write)"],
    },
  },
  {
    namespace: "inv:so:list:<orgId>",
    description: "Sales orders list",
    invalidation: {
      kind: "write",
      events: ["SalesOrdersService (any write)"],
    },
  },
  {
    namespace: "inv:stock:summary:<orgId>",
    description: "Inventory stock summary",
    invalidation: {
      kind: "write",
      events: ["StockService (any write)"],
    },
  },
  {
    namespace: "inv:dashboard:<orgId>",
    description: "Inventory dashboard",
    invalidation: {
      kind: "ttl-only",
      reason: "Aggregate; TTL-only is a deliberate decision — staleness < 5 min is acceptable",
    },
  },
  {
    namespace: "inv:replenishment:suggestions:<orgId>",
    description: "Replenishment suggestions",
    invalidation: { kind: "ttl-only", reason: "Computationally expensive aggregate; 5-min TTL accepted" },
  },
  {
    namespace: "rbac:matrix:<orgId>:v<version>",
    description: "RBAC permission matrix (versioned, no namespace needed)",
    invalidation: {
      kind: "write",
      events: ["AccessService: bumpPermissionsVersion on any role/grant mutation"],
    },
  },
  {
    namespace: "module-access:roles:<orgId>",
    description: "Module role list (version sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["ModuleAccessService (any write)"],
    },
  },
  {
    namespace: "module-access:members:<orgId>",
    description: "Module member list (version sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["ModuleAccessService (any write)"],
    },
  },
  {
    namespace: "user:session:<userId>",
    description: "User session aggregate (cross-org, not tenant-scoped by design)",
    invalidation: {
      kind: "write",
      events: ["SessionsService (login/logout/revoke)"],
    },
  },
  {
    namespace: "dashboard:stats:<orgId>",
    description: "Dashboard statistics",
    invalidation: { kind: "ttl-only", reason: "Aggregate; short TTL acceptable" },
  },
  {
    namespace: "dashboard:executive:<orgId>",
    description: "Executive dashboard",
    invalidation: { kind: "ttl-only", reason: "Aggregate; TTL-only is a deliberate decision" },
  },
  {
    namespace: "support:dashboard:<orgId>",
    description: "Support dashboard",
    invalidation: { kind: "ttl-only", reason: "Aggregate; TTL-only is a deliberate decision" },
  },
  {
    namespace: "support:reports:overview:<orgId>",
    description: "Support reports overview",
    invalidation: { kind: "ttl-only", reason: "Aggregate; TTL-only is a deliberate decision" },
  },
  {
    namespace: "timesheets:payroll:summary:<orgId>",
    description: "Payroll summary (hash sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["PayrollService (any run/post)"],
    },
  },
  {
    namespace: "timesheets:payroll:exports:<orgId>",
    description: "Payroll exports list",
    invalidation: {
      kind: "write",
      events: ["PayrollExportsService (any write)"],
    },
  },
  {
    namespace: "search:<orgId>:<userId>",
    description: "Global search results (hash sub-keyed, user-scoped)",
    invalidation: { kind: "ttl-only", reason: "Short TTL; index-based; acceptable staleness" },
  },
  {
    namespace: "access:perms:<orgId>:<userId>:v<version>",
    description: "Resolved permission set per user per access-version",
    invalidation: {
      kind: "write",
      events: ["bumpPermissionsVersion in any role/grant/delegation mutation"],
    },
  },
  {
    namespace: "feature-flags:all",
    description: "Feature flags (global, not tenant-scoped by design)",
    invalidation: { kind: "ttl-only", reason: "Global config; 5-min TTL acceptable" },
  },
];
