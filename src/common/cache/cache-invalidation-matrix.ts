export type { CacheNamespaceEntry } from "./cache-invalidation-types";
import type { CacheNamespaceEntry } from "./cache-invalidation-types";
import { FINANCE_CACHE_ENTRIES } from "./cache-invalidation-finance";
import { INVENTORY_CACHE_ENTRIES } from "./cache-invalidation-inventory";
import { INVENTORY_FULFILLMENT_CACHE_ENTRIES } from "./cache-invalidation-inventory-fulfillment";
import { RBAC_AUTH_CACHE_ENTRIES } from "./cache-invalidation-rbac-auth";
import { CRM_CACHE_ENTRIES } from "./cache-invalidation-crm";
import { HR_CACHE_ENTRIES } from "./cache-invalidation-hr";

export const CACHE_INVALIDATION_MATRIX: readonly CacheNamespaceEntry[] = [
  ...FINANCE_CACHE_ENTRIES,
  ...INVENTORY_CACHE_ENTRIES,
  ...INVENTORY_FULFILLMENT_CACHE_ENTRIES,
  ...RBAC_AUTH_CACHE_ENTRIES,
  ...CRM_CACHE_ENTRIES,
  ...HR_CACHE_ENTRIES,

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
        "AnnouncementsService.create",
        "AnnouncementsService.update",
        "AnnouncementsService.remove",
        "BroadcastsService (any write)",
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
    description: "Org unit list by kind. Never populated: the 18 invalidateForOrg(orgId,'org:units:<KIND>') writes that suggested otherwise were removed, and no read ever produced the key. Org unit reads are cached under org:hierarchy:<orgId> instead.",
    invalidation: { kind: "ttl-only", reason: "Dead namespace — key never produced or consumed; document to trigger removal" },
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
    description:
      "Build workspace project list — DELIBERATELY UNCACHED, and it must stay that way. Until 2026-09-09 this row claimed a cachedVersioned('projects:list:<orgId>') reader that has never existed, while four writers (projects-write.service.ts x3, projects-provision.service.ts x1) bumped the generation counter. check:cache-invalidation reported all four as namespace-mismatch: the bump reached nothing. The bumps and the CACHE_KEYS.projectsList factory were removed rather than a reader added, because ProjectsQueryService.listProjects resolves a per-caller DataScope (all/team/own/none) plus membershipId and userId, then filters on search/status/afterId/limit/pmWorkspaceId. An org-keyed entry would serve one member's scoped project set to another — the cross-user leak backend/CLAUDE.md section 6 forbids. Caching this read requires every one of those discriminators in the key, which is a design change, not an invalidation fix.",
    invalidation: {
      kind: "ttl-only",
      reason:
        "No reader exists and none may be added under an org-only key; nothing to invalidate",
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
