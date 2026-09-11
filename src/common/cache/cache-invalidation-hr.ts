import type { CacheNamespaceEntry } from "./cache-invalidation-types";

export const HR_CACHE_ENTRIES: readonly CacheNamespaceEntry[] = [
  {
    namespace: "org:hierarchy:<orgId>",
    description: "Every organisation hierarchy read, version-keyed via cachedVersionedForOrg. Sub-keys: overview and tree:<strategy> carry the caller's ScopedRead discriminator because those reads are actor-scoped; units:list:<kind>:<filters> and units:get:<kind>:<id> carry none, because the per-kind handlers pass only (orgId, query) and no rbacScope reaches OrgUnitCrudService. Giving those reads a DataScope means adding the discriminator to their keys in the same change.",
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
    namespace: "hr:directory:<orgId>",
    description: "Employee directory (actor+scope sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["OrgHierarchyCacheService.invalidateAfterMutation (any hierarchy mutation)"],
    },
    dimensions: ["orgId"] as const,
  },
  {
    namespace: "hr:celebrations:<orgId>",
    description: "Birthday and work-anniversary feed (actor+scope+day sub-keyed)",
    invalidation: {
      kind: "write",
      events: [
        "EmployeeOnboardingService.invalidateHrDashboardCache",
        "TerminationLifecycleService.invalidateHrDashboardCache",
      ],
    },
    dimensions: ["orgId"] as const,
  },
  {
    namespace: "hr:analytics:<orgId>",
    description: "HR analytics overview, attendance and attrition",
    invalidation: {
      kind: "write",
      events: [
        "EmployeeOnboardingService.invalidateHrDashboardCache",
        "TerminationLifecycleService.invalidateHrDashboardCache",
      ],
    },
    dimensions: ["orgId"] as const,
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
];
