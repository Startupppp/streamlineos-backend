export type { CacheNamespaceEntry } from "./cache-invalidation-types";
import type { CacheNamespaceEntry } from "./cache-invalidation-types";
import { FINANCE_CACHE_ENTRIES } from "./cache-invalidation-finance";
import { INVENTORY_CACHE_ENTRIES } from "./cache-invalidation-inventory";
import { RBAC_AUTH_CACHE_ENTRIES } from "./cache-invalidation-rbac-auth";
import { CRM_CACHE_ENTRIES } from "./cache-invalidation-crm";

export const CACHE_INVALIDATION_MATRIX: readonly CacheNamespaceEntry[] = [
  ...FINANCE_CACHE_ENTRIES,
  ...INVENTORY_CACHE_ENTRIES,
  ...RBAC_AUTH_CACHE_ENTRIES,
  ...CRM_CACHE_ENTRIES,

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
    namespace: "dashboard:announcements:<orgId>",
    description: "Active announcements list",
    invalidation: {
      kind: "write",
      events: [
        "DashboardAnnouncementsService.create",
        "DashboardAnnouncementsService.delete",
      ],
    },
  },
  {
    namespace: "org:settings:<orgId>",
    description: "Organisation settings (timezone, locale, features). Canonical key: <orgId>:org:settings via cachedForOrg(orgId,'org:settings'). invalidateForOrg(orgId,'org:settings') matches exactly.",
    invalidation: {
      kind: "write",
      events: ["OrganizationSettingsService.updateSettings (invalidateForOrg(orgId,'org:settings'))"],
    },
  },
  {
    namespace: "org:profile:<orgId>:<userId>",
    description: "Per-user org profile (cachedVersionedForOrg with namespace 'org:profile')",
    invalidation: {
      kind: "write",
      events: [
        "OrganizationSettingsService.updateSettings (invalidateNamespaceForOrg(orgId,'org:profile'))",
        "OrgMembershipService.updateRole (invalidateNamespaceForOrg)",
        "OrgMemberDepartureService (invalidateNamespaceForOrg)",
      ],
    },
  },
  {
    namespace: "org:members:list:<orgId>",
    description: "Paginated org members list (cachedVersionedForOrg or invalidateNamespaceForOrg pattern)",
    invalidation: {
      kind: "write",
      events: [
        "InvitationAcceptanceService.accept (invalidateNamespaceForOrg(orgId,'org:members:list'))",
        "OrgMemberDepartureService (invalidateNamespaceForOrg)",
        "OrgMembershipService.updateMember (invalidateNamespaceForOrg)",
      ],
    },
  },
  {
    namespace: "org:members:<orgId>",
    description: "Flat org members list (CACHE_KEYS.orgMembers factory). Note: Factory never called in any service — this key family is dead code. The live namespace is org:members:list:<orgId> (CACHE_KEYS.orgMembersListNamespace).",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed; document to trigger removal" },
  },
  {
    namespace: "users:stats:<orgId>",
    description: "Org-level user stats (active/inactive counts). Note: CACHE_KEYS.usersStats produces users:stats:<orgId> but service uses cachedForOrg(orgId,'users:stats',…) = <orgId>:users:stats. Factory is dead code.",
    invalidation: {
      kind: "write",
      events: [
        "UsersService.invalidateMembershipCaches (invalidateForOrg(orgId,'users:stats'))",
        "InvitationAcceptanceService.accept",
        "OrgMemberDepartureService",
        "OrgMembershipService",
      ],
    },
  },
  {
    namespace: "org:units:<orgId>",
    description: "Org unit list by kind (cachedForOrg; actual key: <orgId>:org:units:<kind>). The canonical key is owned by cachedForOrg; no parallel factory exists.",
    invalidation: {
      kind: "write",
      events: [
        "BranchesService (invalidateForOrg(orgId,'org:units:BRANCH'))",
        "OrgHierarchyBranchesService (invalidateForOrg(orgId,'org:units:BRANCH'))",
        "OrgHierarchyCacheService.invalidateAfterMutation (any hierarchy mutation)",
      ],
    },
  },
  {
    namespace: "branches:list:<orgId>",
    description: "Branch list (cachedForOrg; actual key: <orgId>:branches:list). The canonical key is owned by cachedForOrg; no parallel factory exists.",
    invalidation: {
      kind: "write",
      events: [
        "BranchesService.create/update/archive (invalidateForOrg(orgId,'branches:list'))",
        "OrgHierarchyBranchesService.create/update/archive",
      ],
    },
  },
  {
    namespace: "tasks:list:<orgId>",
    description: "Task list. The list key is built at the owning read seam; no parallel factory exists.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "tasks:detail:<orgId>:<id>",
    description: "Task detail. CACHE_KEYS.taskDetail factory is dead code — never called in any service.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "support:list:<orgId>",
    description: "Support ticket list. CACHE_KEYS.supportTicketsList factory is dead code — never called in any service.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "support:detail:<orgId>:<id>",
    description: "Support ticket detail. CACHE_KEYS.supportTicketDetail factory is dead code — never called in any service.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "calendar:events:<orgId>",
    description: "Calendar events. CACHE_KEYS.calendarEvents factory is dead code — never called in any service. External events use externalCalendarEvents key family.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "integrations:extevents:<connectionId>",
    description: "External (third-party) calendar events per integration connection",
    invalidation: {
      kind: "ttl-only",
      reason: "External provider data; short TTL is the only mechanism — no internal write path signals external calendar mutations",
    },
  },
  {
    namespace: "mail:messages:<accountId>",
    description: "Mail messages per account (namespace-versioned via cachedVersioned('mail:messages:<accountId>',…))",
    invalidation: {
      kind: "write",
      events: ["MailService.performAction (markRead, archive, trash, star) — invalidateNamespace('mail:messages:<accountId>')"],
    },
  },
  {
    namespace: "timesheets:payroll:settings:<orgId>",
    description: "Payroll settings (namespace-versioned). PayrollSettingsService also invalidates timesheets:settings namespace since both project the same row.",
    invalidation: {
      kind: "write",
      events: ["PayrollSettingsService.update (invalidateNamespace on both payrollSettingsNamespace and timesheetSettingsNamespace)"],
    },
  },
  {
    namespace: "timesheets:settings:<orgId>",
    description: "Timesheet settings (namespace-versioned)",
    invalidation: {
      kind: "write",
      events: [
        "TimesheetSettingsService.update (invalidateNamespace)",
        "PayrollSettingsService.update (also invalidates this namespace since rows are shared)",
      ],
    },
  },
  {
    namespace: "timesheets:rates:<orgId>",
    description: "Timesheet pay rates (namespace-versioned)",
    invalidation: {
      kind: "write",
      events: ["TimesheetRatesService.create/update/delete (invalidateNamespace)"],
    },
  },
  {
    namespace: "projects:list:<orgId>",
    description: "Build workspace project list (namespace-versioned via cachedVersioned('projects:list:<orgId>',…))",
    invalidation: {
      kind: "write",
      events: [
        "ProjectsWriteService.create/update/archive (invalidateNamespace('projects:list:<orgId>'))",
        "ProjectsProvisionService.provision (invalidateNamespace('projects:list:<orgId>'))",
      ],
    },
  },
  {
    namespace: "projects:labels:<orgId>",
    description: "Project label list. CACHE_KEYS.projectLabels factory exists but no service calls it — dead factory.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "projects:customStates:<orgId>:<projectId>",
    description: "Project custom states. CACHE_KEYS.customStates factory exists but no service calls it — dead factory.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "tickets:list:<orgId>:<projectId>",
    description: "Ticket list per project. CACHE_KEYS.ticketsList factory exists but no service calls it — dead factory.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
];
