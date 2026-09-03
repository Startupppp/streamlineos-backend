import type { CacheNamespaceEntry } from "./cache-invalidation-types";

export const RBAC_AUTH_CACHE_ENTRIES: readonly CacheNamespaceEntry[] = [
  {
    namespace: "rbac:matrix:<orgId>:v<version>",
    description: "RBAC permission matrix (versioned, no namespace needed)",
    invalidation: {
      kind: "write",
      events: ["AccessService: bumpPermissionsVersion on any role/grant mutation"],
    },
    dimensions: ["orgId", "version"] as const,
    staleToleranceSeconds: 0,
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
    dimensions: ["userId"] as const,
    staleToleranceSeconds: 0,
  },
  {
    namespace: "access:perms:<orgId>:<userId>:v<version>",
    description: "Resolved permission set per user per access-version. In-process only (Map keyed by orgId:userId:version); CACHE_KEYS.accessPerms is the canonical key format. Cross-instance invalidation: bumpPermissionsVersion clears the shared access:version:<orgId> Redis key; other instances re-read the version from DB and compute a new permsKey that is a cache miss.",
    invalidation: {
      kind: "write",
      events: ["bumpPermissionsVersion in any role/grant/delegation mutation"],
    },
    dimensions: ["orgId", "userId", "version"] as const,
    staleToleranceSeconds: 1,
  },
  {
    namespace: "feature-flags:all",
    description: "Feature flags (global, not tenant-scoped by design)",
    invalidation: { kind: "ttl-only", reason: "Global config; 5-min TTL acceptable" },
  },
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
    namespace: "membership:status:<userId>",
    description:
      "Per-user generation counter over MembershipStateService.resolve(userId, orgId), which JwtAuthGuard consults on every request to decide whether the caller's membership is still active. Read as cachedVersioned('membership:status:<userId>', orgId) with a 15s TTL; one counter per user covers every organisation that user belongs to. This entry was missing while the namespace was bumped through a module-local helper, which is also why check:namespace-coverage could not see the bump.",
    invalidation: {
      kind: "write",
      events: [
        "bustMembershipStatusCache / bustMembershipStatusCacheMany (common/auth/membership-state.service.ts) on any membership status change",
        "OrgMembershipService.updateMember and OrgMemberDepartureService (leave/remove/deactivate)",
        "InvitationAcceptanceService.accept",
        "OrgLifecycleService, OrgPurgeService and CronOrgPurgeWorkerService (whole-org suspension/purge, batched)",
        "GdprSubjectErasureService.erase",
      ],
    },
    dimensions: ["userId"] as const,
    staleToleranceSeconds: 0,
  },
  {
    namespace: "mfa:org-policy:<orgId>",
    description: "Organisation-level MFA enforcement policy (cachedForOrg, actual key: <orgId>:mfa:org-policy)",
    invalidation: {
      kind: "write",
      events: ["MfaPolicyService.invalidateOrg (called by OrganizationSettingsService on MFA policy update)"],
    },
    dimensions: ["orgId"] as const,
    staleToleranceSeconds: 0,
  },
  {
    namespace: "mfa:user-totp:<userId>",
    description: "Whether a user has a TOTP secret enrolled",
    invalidation: {
      kind: "write",
      events: ["MfaPolicyService.invalidateUser (called on TOTP enrollment or removal)"],
    },
    dimensions: ["userId"] as const,
    staleToleranceSeconds: 0,
  },
  {
    namespace: "access:version:<orgId>",
    description: "Permission-resolution version counter. Incremented on every role/grant/delegation/ownership mutation; drives per-user permission cache invalidation. This is the cross-instance invalidation signal: clearing it forces all instances to re-read the durable version from DB.",
    invalidation: {
      kind: "write",
      events: [
        "bumpPermissionsVersion(tx, orgId) in any role/grant/delegation/ownership mutation",
        "OrgProfileService.switchOrg (clears outgoing-org version)",
      ],
    },
    dimensions: ["orgId"] as const,
    staleToleranceSeconds: 1,
  },
  {
    namespace: "access:members-with-perm:<orgId>:<permKey>:v<version>",
    description: "Paginated members-with-permission list (version embedded in key; old entries go unreachable on bump)",
    invalidation: {
      kind: "write",
      events: ["bumpPermissionsVersion — new version makes all prior generation keys unreachable; TTL reclaims them"],
    },
    dimensions: ["orgId", "permKey", "version"] as const,
    staleToleranceSeconds: 1,
  },
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
    dimensions: ["orgId", "roleId", "version"] as const,
    staleToleranceSeconds: 1,
  },
  {
    namespace: "rbac:members:<orgId>",
    description: "Discovery-member list for RBAC screens (RbacService.getDiscoveryMembers). Read uses cachedForOrg(orgId,'rbac:members') → key '<orgId>:rbac:members'. Invalidation uses invalidateForOrg(orgId,'rbac:members') → same key. Both formats match.",
    invalidation: {
      kind: "write",
      events: [
        "AccessService.subscribeVersionBump → invalidateForOrg(orgId,'rbac:members') on any bumpPermissionsVersion call",
      ],
    },
  },
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
    description: "Candidate members list for module access assignment (cachedForOrg; actual key: <orgId>:module-access:candidates). The canonical key is owned by cachedForOrg; no parallel factory exists.",
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
];
