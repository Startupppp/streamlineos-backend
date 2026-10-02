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
    description: "Resolved permission set per user per access-version. In-process only (Map keyed by orgId:userId:version); CACHE_KEYS.accessPerms is the canonical key format. Cross-instance invalidation: every instance re-reads access_versions.permissions_version from the DB after its 1s local version TTL, so a bump yields a new permsKey that is a cache miss; no shared cache sits in the revocation path.",
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
    description: "Account liveness (users.is_active, users.deleted_at) used by JwtAuthGuard. In-process only (MembershipStateService, 1s local TTL per instance); no shared cache sits in the revocation path, so every instance re-reads the users row within 1s of a deactivation.",
    invalidation: {
      kind: "write",
      events: [
        "membershipStandingChannel local clear published after commit by commitAccessChange revoke intents, scheduleStandingRevocation and scheduleStandingChange (common/rbac/access-mutation-commit.ts)",
      ],
    },
    dimensions: ["userId"] as const,
    staleToleranceSeconds: 1,
  },
  {
    namespace: "membership:status:<orgId>:<userId>",
    description:
      "MembershipStateService.resolve(userId, orgId), which JwtAuthGuard consults on every request to decide whether the caller's membership is still active. In-process only (1s local TTL per instance, keyed by user then organisation); the DB row is the authority and no shared cache sits in the revocation path, so a suspended or removed member is denied on every instance within 1s even when Redis is down.",
    invalidation: {
      kind: "write",
      events: [
        "membershipStandingChannel local clear published after commit by commitAccessChange revoke intents, scheduleStandingRevocation and scheduleStandingChange (common/rbac/access-mutation-commit.ts)",
        "MembershipMutations drain (common/org/membership-mutations.ts) for every organization_members write",
      ],
    },
    dimensions: ["orgId", "userId"] as const,
    staleToleranceSeconds: 1,
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
