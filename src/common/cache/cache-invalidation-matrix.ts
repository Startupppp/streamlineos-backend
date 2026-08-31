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

  // ─── Auth / membership ────────────────────────────────────────────────────
  {
    namespace: "membership:account:<userId>",
    description: "Membership state cache (active/suspended) used by JwtAuthGuard",
    invalidation: {
      kind: "write",
      events: [
        "bustMembershipStatusCache (common/auth/membership-state.service.ts) on any membership status change",
        "InvitationAcceptanceService.accept",
        "OrgMemberDepartureService (leave/remove member)",
        "OrgMembershipService.updateMember",
      ],
    },
  },
  {
    namespace: "mfa:org-policy:<orgId>",
    description: "Organisation-level MFA enforcement policy (cachedForOrg, actual key: <orgId>:mfa:org-policy)",
    invalidation: {
      kind: "write",
      events: ["MfaPolicyService.invalidateOrg (called by OrganizationSettingsService on MFA policy update)"],
    },
  },
  {
    namespace: "mfa:user-totp:<userId>",
    description: "Whether a user has a TOTP secret enrolled",
    invalidation: {
      kind: "write",
      events: ["MfaPolicyService.invalidateUser (called on TOTP enrollment or removal)"],
    },
  },

  // ─── RBAC version counters ────────────────────────────────────────────────
  {
    namespace: "access:version:<orgId>",
    description: "Permission-resolution version counter. Incremented on every role/grant/delegation/ownership mutation; drives per-user permission cache invalidation.",
    invalidation: {
      kind: "write",
      events: [
        "bumpPermissionsVersion(tx, orgId) in any role/grant/delegation/ownership mutation",
        "OrgProfileService.switchOrg (clears outgoing-org version)",
      ],
    },
  },
  {
    namespace: "access:members-with-perm:<orgId>:<permKey>:v<version>",
    description: "Paginated members-with-permission list (version embedded in key; old entries go unreachable on bump)",
    invalidation: {
      kind: "write",
      events: ["bumpPermissionsVersion — new version makes all prior generation keys unreachable; TTL reclaims them"],
    },
  },

  // ─── RBAC lists (non-versioned) ───────────────────────────────────────────
  {
    namespace: "org:roles:<orgId>",
    description: "Flat org roles list shown in the RBAC admin UI",
    invalidation: {
      kind: "write",
      events: [
        "RoleMemberService (add/remove role assignment)",
        "RolePermissionService (grant/revoke permission)",
        "ModuleAccessFlatMembersService (add/remove module member)",
        "ModuleStandingMutationsService (promote/demote standing)",
        "ModuleAccessGroupCrudService (create/rename/delete group)",
        "ModuleAccessGroupMembersService (add/remove group member)",
        "ModuleRolePermissions (grant/revoke module role permission)",
      ],
    },
  },
  {
    namespace: "rbac:role-perms:<orgId>:<roleId>:v<version>",
    description: "Role permissions list (version-gated; versioned along with org access version)",
    invalidation: {
      kind: "write",
      events: ["bumpPermissionsVersion — new version makes all prior keys unreachable"],
    },
  },
  {
    namespace: "rbac:members:<orgId>",
    description: "Discovery-member list for RBAC screens (RbacService.getDiscoveryMembers). Read and invalidation both use the org-scoped namespace form, so membership changes evict it.",
    invalidation: {
      kind: "write",
      events: [
        "bumpPermissionsVersion (targets wrong key — see description)",
        "OrgMembershipService, InvitationAcceptanceService, OrgMemberDepartureService (all via invalidateForOrg which also targets wrong key)",
      ],
    },
  },

  // ─── Module access ────────────────────────────────────────────────────────
  {
    namespace: "module-access:groups:<orgId>:<moduleKey>:v<version>",
    description: "Module role-group list (version-gated)",
    invalidation: {
      kind: "write",
      events: ["bumpPermissionsVersion — new version makes all prior keys unreachable"],
    },
  },
  {
    namespace: "module-access:group-members:<orgId>:<moduleKey>:<groupId>:v<version>",
    description: "Module group member list (version-gated)",
    invalidation: {
      kind: "write",
      events: ["bumpPermissionsVersion — new version makes all prior keys unreachable"],
    },
  },
  {
    namespace: "module-access:candidates:<orgId>",
    description: "Candidate members list for module access assignment (cachedForOrg; actual key: <orgId>:module-access:candidates). Note: CACHE_KEYS.moduleAccessCandidates factory produces module-access:candidates:<orgId> and is dead code — the service uses cachedForOrg with a raw localKey.",
    invalidation: {
      kind: "write",
      events: [
        "bumpPermissionsVersion (via AccessService.onVersionBump → invalidateForOrg(orgId,'module-access:candidates'))",
        "UsersService.invalidateMembershipCaches",
        "InvitationAcceptanceService.accept",
        "OrgMemberDepartureService",
        "OrgMembershipService",
      ],
    },
  },
  {
    namespace: "module-access:ownership:<orgId>:<moduleKey>",
    description: "Module ownership detail for the access ownership screen",
    invalidation: {
      kind: "write",
      events: [
        "ModuleAccessOwnershipService (initiate/cancel/accept transfer)",
        "ModuleStandingMutationsService.setOwner",
      ],
    },
  },

  // ─── Ownership / transfers ────────────────────────────────────────────────
  {
    namespace: "ownership:modules:<orgId>",
    description: "List of all module ownerships for this org",
    invalidation: {
      kind: "write",
      events: ["ModuleStandingMutationsService.setOwner"],
    },
  },
  {
    namespace: "ownership:module:<orgId>:<moduleKey>",
    description: "Detail of a single module ownership",
    invalidation: {
      kind: "write",
      events: ["ModuleStandingMutationsService.setOwner"],
    },
  },
  {
    namespace: "ownership:transfers:<orgId>",
    description: "Ownership transfer list/history (namespace-versioned)",
    invalidation: {
      kind: "write",
      events: [
        "ModuleAccessOwnershipService.initiateTransfer",
        "ModuleStandingMutationsService.setOwner",
        "OwnershipTransferResponseService (accept/decline)",
      ],
    },
  },
  {
    namespace: "ownership:incoming:<orgId>:<userId>",
    description: "Incoming ownership transfer requests for a user",
    invalidation: {
      kind: "ttl-only",
      reason: "Short TTL; invalidation at transfer acceptance is handled via ownership:transfers namespace bump which covers the incoming view",
    },
  },

  // ─── Org settings / profile / members ────────────────────────────────────
  {
    namespace: "org:settings:<orgId>",
    description: "Organisation settings (timezone, locale, features). Note: CACHE_KEYS.orgSettings factory produces org:settings:<orgId> but the service uses cachedForOrg(orgId,'org:settings',…) producing key <orgId>:org:settings. Factory is dead code.",
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

  // ─── Dashboard ────────────────────────────────────────────────────────────
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

  // ─── Org units / branches ─────────────────────────────────────────────────
  {
    namespace: "org:units:<orgId>",
    description: "Org unit list by kind (cachedForOrg; actual key: <orgId>:org:units:<kind>). CACHE_KEYS.orgUnits factory produces org:units:<orgId>:…, so factory key format diverges from actual key. Factory is dead code.",
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
    description: "Branch list (cachedForOrg; actual key: <orgId>:branches:list). CACHE_KEYS.branchesList factory produces branches:list:<orgId> — format diverges. Factory is dead code.",
    invalidation: {
      kind: "write",
      events: [
        "BranchesService.create/update/archive (invalidateForOrg(orgId,'branches:list'))",
        "OrgHierarchyBranchesService.create/update/archive",
      ],
    },
  },

  // ─── CRM / Sales dashboards ───────────────────────────────────────────────
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
    description: "Client health list (read appends :<userId>:<scope> — scope-qualified key). ⚠ NO INVALIDATION EXISTS: the read key is clientsHealth(orgId)+':'+userId+':'+scope but no service calls invalidate/del/invalidateNamespace on this family when deals or client data changes. Effective TTL-only until a namespace-invalidation write path is added.",
    invalidation: {
      kind: "ttl-only",
      reason: "No write-invalidation path exists; short TTL mitigates staleness. Scope-qualified key pattern means a base-key del would also be a no-op.",
    },
  },
  {
    namespace: "clients:churn:<orgId>",
    description: "Churn-alert list (read appends :<userId>:<scope> — scope-qualified). Same missing-invalidation gap as clients:health.",
    invalidation: {
      kind: "ttl-only",
      reason: "No write-invalidation path exists; short TTL mitigates staleness.",
    },
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

  // ─── Quotes ───────────────────────────────────────────────────────────────
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

  // ─── Invoices ─────────────────────────────────────────────────────────────
  {
    namespace: "invoices:list:<orgId>",
    description: "Invoice list (raw cached() with 30-second TTL; not namespace-versioned). InvoicesWriteService does NOT invalidate this key — only fin:reports/tax/forecast. Effective TTL-only.",
    invalidation: {
      kind: "ttl-only",
      reason: "30-second TTL; InvoicesWriteService only invalidates fin:* keys, not the list cache. CACHE_KEYS.invoicesList factory is also dead code (key format differs from actual literal).",
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

  // ─── Tasks ────────────────────────────────────────────────────────────────
  {
    namespace: "tasks:list:<orgId>",
    description: "Task list. CACHE_KEYS.tasksList factory is dead code — never called in any service.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },
  {
    namespace: "tasks:detail:<orgId>:<id>",
    description: "Task detail. CACHE_KEYS.taskDetail factory is dead code — never called in any service.",
    invalidation: { kind: "ttl-only", reason: "Dead factory — key never produced or consumed" },
  },

  // ─── Support tickets ──────────────────────────────────────────────────────
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

  // ─── Leads ────────────────────────────────────────────────────────────────
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

  // ─── Targets ──────────────────────────────────────────────────────────────
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

  // ─── Calendar ─────────────────────────────────────────────────────────────
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

  // ─── Mail ─────────────────────────────────────────────────────────────────
  {
    namespace: "mail:messages:<accountId>",
    description: "Mail messages per account (namespace-versioned via cachedVersioned('mail:messages:<accountId>',…))",
    invalidation: {
      kind: "write",
      events: ["MailService.performAction (markRead, archive, trash, star) — invalidateNamespace('mail:messages:<accountId>')"],
    },
  },

  // ─── Timesheets ───────────────────────────────────────────────────────────
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

  // ─── Finance insights ─────────────────────────────────────────────────────
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

  // ─── Inventory — detail / scoped keys ────────────────────────────────────
  {
    namespace: "inv:products:detail:<orgId>:<id>",
    description: "Inventory product detail",
    invalidation: {
      kind: "write",
      events: ["InvProductCrudService.update/delete/updateVariant (del+invalidateNamespace(invProductsNamespace))"],
    },
  },
  {
    namespace: "inv:low-stock:<orgId>",
    description: "Low-stock alert list",
    invalidation: {
      kind: "write",
      events: ["StockEngineService.invalidateCaches", "StockEngineBatchService.invalidateCaches"],
    },
  },
  {
    namespace: "inv:warehouses:detail:<orgId>:<id>",
    description: "Warehouse detail (plus namespace-versioned list via inv:warehouses namespace)",
    invalidation: {
      kind: "write",
      events: ["InvWarehousesService.update (del detail + invalidateNamespaceForOrg('inv:warehouses'))"],
    },
  },
  {
    namespace: "inv:po:detail:<orgId>:<id>",
    description: "Purchase order detail",
    invalidation: {
      kind: "write",
      events: ["PoService.update/send/close/cancel", "GrnService.receive", "GrnReceiveService.receive"],
    },
  },
  {
    namespace: "inv:vret:list:<orgId>",
    description: "Vendor returns list",
    invalidation: {
      kind: "write",
      events: ["VendorReturnsService (any write)"],
    },
  },
  {
    namespace: "inv:vret:detail:<orgId>:<id>",
    description: "Vendor return detail",
    invalidation: {
      kind: "write",
      events: ["VendorReturnsService (any write)"],
    },
  },
  {
    namespace: "inv:cret:list:<orgId>",
    description: "Customer returns list",
    invalidation: {
      kind: "write",
      events: ["CustomerReturnsService (any write)"],
    },
  },
  {
    namespace: "inv:cret:detail:<orgId>:<id>",
    description: "Customer return detail",
    invalidation: {
      kind: "write",
      events: ["CustomerReturnsService (any write)"],
    },
  },
  {
    namespace: "inv:so:detail:<orgId>:<id>",
    description: "Sales order detail",
    invalidation: {
      kind: "write",
      events: ["SoLifecycleService", "SoFulfillmentService", "SoCoreService (all del detail + invalidateNamespace(invSoNamespace))"],
    },
  },
  {
    namespace: "inv:reorder:<orgId>",
    description: "Inventory reorder report",
    invalidation: {
      kind: "write",
      events: ["StockEngineService.invalidateCaches", "StockEngineBatchService.invalidateCaches"],
    },
  },
  {
    namespace: "inv:reorder:paged:<orgId>",
    description: "Paged inventory reorder report (hash sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["StockEngineService.invalidateCaches (implicitly via inv:reorder parent)"],
    },
  },
  {
    namespace: "inv:stock:summary-report:<orgId>",
    description: "Stock summary report (paged, hash sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["StockEngineService.invalidateCaches (stock movement events)"],
    },
  },
  {
    namespace: "inv:valuation:report:<orgId>",
    description: "Inventory valuation report (hash sub-keyed)",
    invalidation: {
      kind: "write",
      events: ["StockEngineService.invalidateCaches (on any stock adjustment affecting valuation)"],
    },
  },
  {
    namespace: "inv:slow-moving:<orgId>",
    description: "Slow-moving inventory report (hash sub-keyed)",
    invalidation: {
      kind: "ttl-only",
      reason: "Aggregate report; acceptable staleness; computed on demand with TTL",
    },
  },
  {
    namespace: "inv:expiry:report:<orgId>",
    description: "Expiry-approaching inventory report (hash sub-keyed)",
    invalidation: {
      kind: "ttl-only",
      reason: "Time-bounded aggregate; TTL is the natural invalidation mechanism as expiry is date-driven",
    },
  },
  {
    namespace: "inv:cycle-counts:list:<orgId>",
    description: "Cycle count sessions list",
    invalidation: {
      kind: "write",
      events: ["InvCycleCountsService (any write)"],
    },
  },
  {
    namespace: "inv:cycle-counts:detail:<orgId>:<id>",
    description: "Cycle count session detail",
    invalidation: {
      kind: "write",
      events: ["InvCycleCountsService (any write)"],
    },
  },
  {
    namespace: "inv:quality:inspections:<orgId>",
    description: "Quality inspections list",
    invalidation: {
      kind: "write",
      events: ["QualityInspectionsService (any write)"],
    },
  },
  {
    namespace: "inv:quality:holds:<orgId>",
    description: "Quality holds list",
    invalidation: {
      kind: "write",
      events: ["QualityInspectionsService (any write)"],
    },
  },
  {
    namespace: "inv:quality:recalls:<orgId>",
    description: "Quality recalls list",
    invalidation: {
      kind: "write",
      events: ["QualityRecallsService (any write)"],
    },
  },
  {
    namespace: "inv:packages:<orgId>",
    description: "Packages list",
    invalidation: {
      kind: "write",
      events: ["PackagesService (any write)"],
    },
  },
  {
    namespace: "inv:shipments:<orgId>",
    description: "Shipments list",
    invalidation: {
      kind: "write",
      events: ["ShipmentsService (any write)"],
    },
  },
  {
    namespace: "inv:loads:<orgId>",
    description: "Loads list",
    invalidation: {
      kind: "write",
      events: ["LoadsService (any write)"],
    },
  },
  {
    namespace: "inv:carriers:<orgId>",
    description: "Carriers list",
    invalidation: {
      kind: "write",
      events: ["CarriersService (any write)"],
    },
  },
  {
    namespace: "inv:channels:list:<orgId>",
    description: "Sales channel list",
    invalidation: {
      kind: "write",
      events: ["InvChannelsService (any write)"],
    },
  },
  {
    namespace: "inv:channels:detail:<orgId>:<id>",
    description: "Sales channel detail",
    invalidation: {
      kind: "write",
      events: ["InvChannelsService (any write)"],
    },
  },
  {
    namespace: "inv:3pl:list:<orgId>",
    description: "Third-party logistics partner list",
    invalidation: {
      kind: "write",
      events: ["Inv3plService (any write)"],
    },
  },
  {
    namespace: "inv:import-jobs:list:<orgId>",
    description: "Inventory import job list",
    invalidation: {
      kind: "write",
      events: ["InvImportService.updateJobStatus (invalidateNamespace)"],
    },
  },
  {
    namespace: "inv:export-jobs:list:<orgId>",
    description: "Inventory export job list",
    invalidation: {
      kind: "write",
      events: ["InvExportService (any write)"],
    },
  },
  {
    namespace: "inv:settings:<orgId>",
    description: "Inventory module settings",
    invalidation: {
      kind: "write",
      events: ["InvSettingsService.updateSettings (invalidate(CACHE_KEYS.invSettings(orgId)))"],
    },
  },
  {
    namespace: "inv:numseq:<orgId>",
    description: "Inventory number sequences (PO/GRN/SO/etc. reference number counters)",
    invalidation: {
      kind: "write",
      events: ["InvSettingsService.updateNumberSequence (invalidate(CACHE_KEYS.invNumberSequences(orgId)))"],
    },
  },
  {
    namespace: "inv:ai-insights:<orgId>",
    description: "Inventory AI-generated insights list",
    invalidation: {
      kind: "write",
      events: ["InvAiService.generateInsights", "InvAiService.dismissInsight"],
    },
  },

  // ─── Build (projects + tickets) ───────────────────────────────────────────
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
