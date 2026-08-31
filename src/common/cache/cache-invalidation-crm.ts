import type { CacheNamespaceEntry } from "./cache-invalidation-types";

export const CRM_CACHE_ENTRIES: readonly CacheNamespaceEntry[] = [
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
    namespace: "sales:dashboard:<orgId>",
    description: "Sales pipeline dashboard aggregate",
    invalidation: {
      kind: "write",
      events: [
        "LeadStatusService (lead status change)",
        "DealsCrudService.create/update/delete",
        "DealsService.updateDeal (stage change)",
      ],
    },
  },
  {
    namespace: "ce:dashboard:<orgId>",
    description: "Customer-executive dashboard aggregate",
    invalidation: {
      kind: "write",
      events: [
        "SupportTicketsService.invalidateCaches",
        "SupportTicketOperationsService.invalidateCaches",
      ],
    },
  },
  {
    namespace: "deals:list:<orgId>",
    description: "Deals list (namespace-versioned via cachedVersioned('deals:list:<orgId>',…))",
    invalidation: {
      kind: "write",
      events: [
        "DealsCrudService.create/update/delete (invalidateNamespace('deals:list:<orgId>'))",
        "DealsService.updateDeal (invalidateNamespace)",
      ],
    },
  },
  {
    namespace: "deals:forecast:<orgId>",
    description: "Deal forecast aggregate",
    invalidation: {
      kind: "write",
      events: ["DealsCrudService.create/update/delete"],
    },
  },
  {
    namespace: "deals:approvals:<orgId>",
    description: "Deal approvals list",
    invalidation: {
      kind: "write",
      events: ["DealsApprovalsService.create/update"],
    },
  },
  {
    namespace: "clients:health:<orgId>",
    description: "Client health list (cachedVersionedForOrg with namespace 'clients:health', sub-keyed by userId:scope:status:limit)",
    invalidation: {
      kind: "write",
      events: ["CrmScoringService.analyzeChurnRisk (invalidateNamespaceForOrg(orgId,'clients:health'))"],
    },
    dimensions: ["orgId"] as const,
    staleToleranceSeconds: 300,
  },
  {
    namespace: "clients:churn:<orgId>",
    description: "Churn-alert list (cachedVersionedForOrg with namespace 'clients:churn', sub-keyed by userId:scope)",
    invalidation: {
      kind: "write",
      events: ["CrmScoringService.analyzeChurnRisk (invalidateNamespaceForOrg(orgId,'clients:churn'))"],
    },
    dimensions: ["orgId"] as const,
    staleToleranceSeconds: 300,
  },
  {
    namespace: "sales:quotas:<orgId>",
    description: "Sales quotas (namespace-versioned via cachedVersioned('sales:quotas:<orgId>',…))",
    invalidation: {
      kind: "write",
      events: ["SalesService.upsertQuota (invalidateNamespace('sales:quotas:<orgId>'))"],
    },
  },
  {
    namespace: "sales:commissions:<orgId>",
    description: "Sales commissions (namespace-versioned via cachedVersioned('sales:commissions:<orgId>',…))",
    invalidation: {
      kind: "write",
      events: ["SalesService.updateCommission (invalidateNamespace('sales:commissions:<orgId>'))"],
    },
  },
  {
    namespace: "quotes:list:<orgId>",
    description: "Quotes list (namespace-versioned via cachedVersioned('quotes:list:<orgId>',…))",
    invalidation: {
      kind: "write",
      events: [
        "QuotesService.create/update/delete (invalidateNamespace('quotes:list:<orgId>'))",
        "QuotesLifecycleService.send/accept/decline/createInvoice/sign",
      ],
    },
  },
  {
    namespace: "quotes:detail:<orgId>:<id>",
    description: "Quote detail. Note: CACHE_KEYS.quoteDetail factory exists but is never used in any service — key is dead code.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "invoices:list:<orgId>",
    description: "Invoice list (cachedVersionedForOrg with namespace 'invoices:list', sub-keyed by status:clientId:limit:offset)",
    invalidation: {
      kind: "write",
      events: [
        "InvoicesWriteService.createInvoice (invalidateNamespaceForOrg(orgId,'invoices:list'))",
        "InvoicesWriteService.updateInvoice (invalidateNamespaceForOrg(orgId,'invoices:list'))",
        "InvoicesWriteService.voidInvoice (invalidateNamespaceForOrg(orgId,'invoices:list'))",
      ],
    },
  },
  {
    namespace: "invoices:detail:<orgId>:<id>",
    description: "Invoice detail. CACHE_KEYS.invoiceDetail factory is dead code — never called in any service.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "invoices:stats:<orgId>",
    description: "Invoice stats. CACHE_KEYS.invoiceStats factory is dead code — never called in any service.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "leads:list:<orgId>",
    description: "Leads list. CACHE_KEYS.leadsList factory is dead code — never called in any service.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "leads:detail:<orgId>:<id>",
    description: "Lead detail. CACHE_KEYS.leadDetail factory is dead code — never called in any service.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "leads:board:<orgId>",
    description: "Lead board view. CACHE_KEYS.leadBoard factory is dead code — never called in any service.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "leads:stats:<orgId>",
    description: "Lead stats. CACHE_KEYS.leadStats factory is dead code — never called in any service.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "targets:list:<orgId>",
    description: "Targets list. CACHE_KEYS.targetsList factory is dead code — never called in any service.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "targets:leaderboard:<orgId>",
    description: "Targets leaderboard. CACHE_KEYS.targetLeaderboard factory is dead code — never called in any service.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
];
