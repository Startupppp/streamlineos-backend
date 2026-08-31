import type { CacheNamespaceEntry } from "./cache-invalidation-types";

export const FINANCE_CACHE_ENTRIES: readonly CacheNamespaceEntry[] = [
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
    namespace: "fin:insights:anomalies:<orgId>",
    description: "AI-computed spending anomalies (from/to sub-keyed)",
    invalidation: {
      kind: "ttl-only",
      reason: "AI-computed aggregate; expensive to regenerate on every write; ANOMALY_TTL governs freshness",
    },
  },
  {
    namespace: "fin:insights:digest:<orgId>",
    description: "AI-generated financial digest headline",
    invalidation: {
      kind: "ttl-only",
      reason: "AI-computed aggregate; ANOMALY_TTL governs freshness",
    },
  },
  {
    namespace: "fin:cat-suggest:<orgId>",
    description: "Expense category suggestion by merchant (ML, content-addressed by normalized merchant name)",
    invalidation: {
      kind: "ttl-only",
      reason: "Computed from historical patterns; SUGGEST_TTL governs freshness; merchant normalization is the discriminator",
    },
  },
];
