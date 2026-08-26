/**
 * Cache invalidation matrix — every namespace or key pattern listed here must
 * carry either a list of writes that invalidate it or an explicit TTL-only
 * designation.  A new cached read without a row in this file is caught in
 * review.
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
 *   Session-revocation tombstones also carry TTL (SESSION_TTL_SECONDS).
 *
 * Session-revocation safety:
 *   The tombstone at revoked:session:<id> has a TTL matching the JWT lifetime,
 *   so an LRU eviction before expiry cannot be distinguished from "never
 *   revoked" in the current guard (jwt-auth.guard.ts) — it falls back to
 *   isRevokedInDatabase only on a Redis *error*, not on a null result, because
 *   a null result is also what every non-revoked session produces on every
 *   request. Falling back to the database on null was tried (2026-08-26) and
 *   reverted: JwtAuthGuard is a global APP_GUARD, so it turned into a
 *   mandatory database round trip on every request whose 5-second in-process
 *   cache (REVOCATION_CACHE_TTL_MS) had gone stale, for the entire platform's
 *   traffic — not just the rare evicted-tombstone case.
 *   The residual risk is bounded, not zero: an active session refreshes its
 *   tombstone's LRU position on every read, so a revoked session still being
 *   probed stays hot; the exposure is a revoked session that goes idle right
 *   as Redis is under memory pressure.
 *   The structurally correct fix is to stop relying on TTL-based eviction
 *   safety for tombstones at all: give them no TTL (matching how namespace
 *   version counters are protected from volatile-lru above) and clean them up
 *   with an explicit scheduled sweep instead of letting Redis expire them —
 *   not done here; recorded as the real follow-up rather than the null-check
 *   that was tried and reverted.
 */

export type InvalidationTrigger =
  | { kind: "write"; events: string[] }
  | { kind: "ttl-only"; reason: string };

export interface CacheNamespaceEntry {
  namespace: string;
  description: string;
  invalidation: InvalidationTrigger;
  migrated: boolean;
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
    migrated: true,
  },
  {
    namespace: "acc:setup-status:<orgId>",
    description: "Accounting wizard setup completion status",
    invalidation: {
      kind: "write",
      events: ["AccountingSettingsService.updateSettings"],
    },
    migrated: true,
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
    migrated: true,
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
    migrated: true,
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
    migrated: true,
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
    migrated: false,
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
    migrated: false,
  },
  {
    namespace: "fin:bva:<orgId>:<budgetId>",
    description: "Budget-vs-actual report per budget",
    invalidation: {
      kind: "write",
      events: ["FinancePostingService.postJournal", "InvoicesWriteService (any invoice write)"],
    },
    migrated: true,
  },
  {
    namespace: "fin:forecast:<orgId>",
    description: "Finance planning forecast",
    invalidation: {
      kind: "write",
      events: ["InvoicesWriteService (any invoice write)", "TransfersService (any transfer)"],
    },
    migrated: true,
  },
  {
    namespace: "fin:banking:accounts:<orgId>",
    description: "Bank accounts list/detail",
    invalidation: {
      kind: "write",
      events: ["BankAccountsService (any write)"],
    },
    migrated: true,
  },
  {
    namespace: "fin:assets:list:<orgId>",
    description: "Fixed assets list",
    invalidation: {
      kind: "write",
      events: ["AssetsService (any write)"],
    },
    migrated: true,
  },
  {
    namespace: "fin:asset-categories:<orgId>",
    description: "Asset categories",
    invalidation: { kind: "ttl-only", reason: "Low-churn reference data; TTL 5 min is acceptable" },
    migrated: true,
  },
  {
    namespace: "fin:tax-codes:<orgId>",
    description: "Tax codes",
    invalidation: { kind: "ttl-only", reason: "Low-churn reference data; TTL 5 min is acceptable" },
    migrated: true,
  },
  {
    namespace: "fin:tax-payments:<orgId>",
    description: "Tax payments",
    invalidation: {
      kind: "write",
      events: ["TaxService (any write)"],
    },
    migrated: true,
  },
  {
    namespace: "fin:tax-dashboard:<orgId>",
    description: "Tax summary dashboard",
    invalidation: {
      kind: "write",
      events: ["InvoicesWriteService (any invoice write)"],
    },
    migrated: true,
  },
  {
    namespace: "fin:tax-reports:<orgId>",
    description: "Tax reports",
    invalidation: {
      kind: "write",
      events: ["InvoicesWriteService (any invoice write)"],
    },
    migrated: true,
  },
  {
    namespace: "fin:expense-policies:<orgId>",
    description: "Expense policies",
    invalidation: {
      kind: "write",
      events: ["ExpensePoliciesService (any write)"],
    },
    migrated: true,
  },
  {
    namespace: "org:hierarchy:<orgId>",
    description: "Organisation hierarchy tree (all shapes)",
    invalidation: {
      kind: "write",
      events: ["OrgHierarchyCacheService.invalidateAfterMutation (any hierarchy mutation)"],
    },
    migrated: true,
  },
  {
    namespace: "hr:headcount:<orgId>",
    description: "HR headcount aggregate",
    invalidation: {
      kind: "write",
      events: ["OrgHierarchyCacheService.invalidateAfterMutation (any hierarchy mutation)"],
    },
    migrated: true,
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
    migrated: false,
  },
  {
    namespace: "hr:expenses:<orgId>",
    description: "Expense list (user+admin-flag+filters sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["ExpensesService (any write)"],
    },
    migrated: true,
  },
  {
    namespace: "sales:kpis:<orgId>",
    description: "Sales KPIs (from+to+repId sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["DealsService.updateDeal (stage change)"],
    },
    migrated: false,
  },
  {
    namespace: "crm:contacts:list:<orgId>",
    description: "CRM contacts list",
    invalidation: {
      kind: "write",
      events: ["ContactsService (any write)"],
    },
    migrated: false,
  },
  {
    namespace: "crm:organizations:list:<orgId>",
    description: "CRM organizations list",
    invalidation: {
      kind: "write",
      events: ["CrmOrganizationsService (any write)"],
    },
    migrated: true,
  },
  {
    namespace: "crm:organizations:detail:<orgId>",
    description: "CRM organization detail (id sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["CrmOrganizationsService (any write)"],
    },
    migrated: true,
  },
  {
    namespace: "inv:products:list:<orgId>",
    description: "Inventory products list",
    invalidation: {
      kind: "write",
      events: ["InventoryProductsService (any write)"],
    },
    migrated: true,
  },
  {
    namespace: "inv:po:list:<orgId>",
    description: "Purchase orders list",
    invalidation: {
      kind: "write",
      events: ["PurchaseOrdersService (any write)"],
    },
    migrated: true,
  },
  {
    namespace: "inv:grn:list:<orgId>",
    description: "Goods-received notes list",
    invalidation: {
      kind: "write",
      events: ["GrnService (any write)"],
    },
    migrated: true,
  },
  {
    namespace: "inv:vendors:list:<orgId>",
    description: "Vendor list",
    invalidation: {
      kind: "write",
      events: ["VendorsService (any write)"],
    },
    migrated: false,
  },
  {
    namespace: "inv:so:list:<orgId>",
    description: "Sales orders list",
    invalidation: {
      kind: "write",
      events: ["SalesOrdersService (any write)"],
    },
    migrated: true,
  },
  {
    namespace: "inv:stock:summary:<orgId>",
    description: "Inventory stock summary",
    invalidation: {
      kind: "write",
      events: ["StockService (any write)"],
    },
    migrated: false,
  },
  {
    namespace: "inv:dashboard:<orgId>",
    description: "Inventory dashboard",
    invalidation: {
      kind: "ttl-only",
      reason: "Aggregate; TTL-only is a deliberate decision — staleness < 5 min is acceptable",
    },
    migrated: true,
  },
  {
    namespace: "inv:replenishment:suggestions:<orgId>",
    description: "Replenishment suggestions",
    invalidation: { kind: "ttl-only", reason: "Computationally expensive aggregate; 5-min TTL accepted" },
    migrated: false,
  },
  {
    namespace: "rbac:matrix:<orgId>:v<version>",
    description: "RBAC permission matrix (versioned, no namespace needed)",
    invalidation: {
      kind: "write",
      events: ["AccessService: bumpPermissionsVersion on any role/grant mutation"],
    },
    migrated: false,
  },
  {
    namespace: "module-access:roles:<orgId>",
    description: "Module role list (version sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["ModuleAccessService (any write)"],
    },
    migrated: false,
  },
  {
    namespace: "module-access:members:<orgId>",
    description: "Module member list (version sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["ModuleAccessService (any write)"],
    },
    migrated: false,
  },
  {
    namespace: "user:session:<userId>",
    description: "User session aggregate (cross-org, not tenant-scoped by design)",
    invalidation: {
      kind: "write",
      events: ["SessionsService (login/logout/revoke)"],
    },
    migrated: false,
  },
  {
    namespace: "dashboard:stats:<orgId>",
    description: "Dashboard statistics",
    invalidation: { kind: "ttl-only", reason: "Aggregate; short TTL acceptable" },
    migrated: false,
  },
  {
    namespace: "dashboard:executive:<orgId>",
    description: "Executive dashboard",
    invalidation: { kind: "ttl-only", reason: "Aggregate; TTL-only is a deliberate decision" },
    migrated: false,
  },
  {
    namespace: "support:dashboard:<orgId>",
    description: "Support dashboard",
    invalidation: { kind: "ttl-only", reason: "Aggregate; TTL-only is a deliberate decision" },
    migrated: false,
  },
  {
    namespace: "support:reports:overview:<orgId>",
    description: "Support reports overview",
    invalidation: { kind: "ttl-only", reason: "Aggregate; TTL-only is a deliberate decision" },
    migrated: true,
  },
  {
    namespace: "timesheets:payroll:summary:<orgId>",
    description: "Payroll summary (hash sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["PayrollService (any run/post)"],
    },
    migrated: true,
  },
  {
    namespace: "timesheets:payroll:exports:<orgId>",
    description: "Payroll exports list",
    invalidation: {
      kind: "write",
      events: ["PayrollExportsService (any write)"],
    },
    migrated: true,
  },
  {
    namespace: "search:<orgId>:<userId>",
    description: "Global search results (hash sub-keyed, user-scoped)",
    invalidation: { kind: "ttl-only", reason: "Short TTL; index-based; acceptable staleness" },
    migrated: false,
  },
  {
    namespace: "access:perms:<orgId>:<userId>:v<version>",
    description: "Resolved permission set per user per access-version",
    invalidation: {
      kind: "write",
      events: ["bumpPermissionsVersion in any role/grant/delegation mutation"],
    },
    migrated: false,
  },
  {
    namespace: "feature-flags:all",
    description: "Feature flags (global, not tenant-scoped by design)",
    invalidation: { kind: "ttl-only", reason: "Global config; 5-min TTL acceptable" },
    migrated: false,
  },
];

export const CACHE_MIGRATION_STATUS = {
  migratedInThisPR: CACHE_INVALIDATION_MATRIX.filter((e) => e.migrated).length,
  pendingMigration: CACHE_INVALIDATION_MATRIX.filter((e) => !e.migrated).length,
} as const;
