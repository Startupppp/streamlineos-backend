import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import {
  groupRoleAssignments,
  moduleOwnerships,
  principalGroupMembers,
  roleAssignments,
  roles,
} from "../../db/schema";
import { logger } from "../../common/logger/logger.service";
import { isDelegablePermission } from "../../common/rbac/grantability";
import { ORG_MEMBER_ROLES } from "../../common/rbac/org-roles";
import type { MembershipState } from "../../common/auth/membership-state.service";
import {
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSION_GRANTS,
  moduleScopedPermissions,
} from "../rbac/permissions";
import type { DataScope } from "./access.types";
import {
  allCatalogScopes,
  broadest,
  CATALOG_KEY_SET,
  deriveAccessViewImplication,
  EMPLOYEE_SELF_SERVICE_GRANTS,
  platformCapabilityScopes,
} from "./access-policy";
import {
  type Clock,
  type GrantTransitions,
  NO_TRANSITIONS,
  SYSTEM_CLOCK,
} from "./snapshot-validity";
import {
  drainDelegatedPermissionGrants,
  drainRolePermissionGrants,
  drainUserPermissionGrants,
  type ReadAccessTable,
} from "./access-grant-drains";

export type { ReadAccessTable };

export interface ResolvedPermissions {
  perms: Record<string, DataScope>;
  transitions: GrantTransitions;
}

export interface MembershipAccessState {
  active: boolean;
  isOwnerOrAdmin: boolean;
  expiresAt: number;
}

/** The one liveness authority, or a request context that already holds its answer. */
export type MembershipReader = (
  orgId: string,
  userId: string,
) => Promise<MembershipState>;

function ownsOrAdministers(member: MembershipState): boolean {
  return (
    member.active &&
    (member.isOwner || member.role === ORG_MEMBER_ROLES.ORG_ADMIN)
  );
}

/**
 * Keyed by the access version so a bump on another instance invalidates it too.
 * Without the version this cache was the one access cache a bump could not
 * reach across a process boundary.
 */
export function membershipCacheKey(
  orgId: string,
  userId: string,
  version: number,
): string {
  return `${orgId}:${userId}:${version}`;
}

function earliestAfter(
  now: Date,
  candidates: readonly (Date | null | undefined)[],
): Date | null {
  const cutoff = now.getTime();
  const future = candidates
    .filter((candidate): candidate is Date => Boolean(candidate))
    .map((candidate) => candidate.getTime())
    .filter((instant) => instant > cutoff);
  return future.length === 0 ? null : new Date(Math.min(...future));
}

export class AccessPermissionResolver {
  constructor(
    private readonly getDatabase: () => Db,
    private readonly readAccessTable: ReadAccessTable,
    private readonly warnedUnknownKeys: Set<string>,
    private readonly membershipAccessCache: Map<string, MembershipAccessState>,
    private readonly deniedModulesTtlMs: number,
    private readonly resolveMembership: MembershipReader,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  private get db(): Db {
    return this.getDatabase();
  }

  async computeUserPermissions(
    orgId: string,
    userId: string,
    version: number,
    membership?: MembershipReader,
  ): Promise<ResolvedPermissions> {
    const member = await (membership ?? this.resolveMembership)(orgId, userId);
    this.membershipAccessCache.set(membershipCacheKey(orgId, userId, version), {
      active: member.active,
      isOwnerOrAdmin: ownsOrAdministers(member),
      expiresAt: Date.now() + this.deniedModulesTtlMs,
    });
    if (!member.active) return { perms: {}, transitions: NO_TRANSITIONS };
    const platformScopes = platformCapabilityScopes(userId);
    if (ownsOrAdministers(member))
      return {
        perms: { ...allCatalogScopes(), ...platformScopes },
        transitions: NO_TRANSITIONS,
      };

    const membershipId = member.membershipId ?? 0;
    const now = this.clock.now();

    const [assignmentRows, groupMemberRows, ownershipRows, personalGrantRows] =
      await Promise.all([
      this.readAccessTable(
        () =>
          this.db
            .select({
              roleId: roleAssignments.roleId,
              expiresAt: roleAssignments.expiresAt,
            })
            .from(roleAssignments)
            .where(
              and(
                eq(roleAssignments.orgId, orgId),
                eq(roleAssignments.organizationMembershipId, membershipId),
                or(
                  isNull(roleAssignments.expiresAt),
                  gt(roleAssignments.expiresAt, now),
                ),
              ),
            )
            .limit(500),
      ),
      this.readAccessTable(
        () =>
          this.db
            .select({
              principalGroupId: principalGroupMembers.principalGroupId,
            })
            .from(principalGroupMembers)
            .where(
              and(
                eq(principalGroupMembers.orgId, orgId),
                eq(
                  principalGroupMembers.organizationMembershipId,
                  membershipId,
                ),
              ),
            )
            .limit(500),
      ),
      this.readAccessTable(
        () =>
          this.db
            .select({ moduleKey: moduleOwnerships.moduleKey })
            .from(moduleOwnerships)
            .where(
              and(
                eq(moduleOwnerships.orgId, orgId),
                eq(moduleOwnerships.ownerMembershipId, membershipId),
              ),
            )
            .limit(100),
      ),
      drainUserPermissionGrants(
        this.db,
        this.readAccessTable,
        orgId,
        membershipId,
      ),
    ]);

    const roleIds = new Set<number>(assignmentRows.map((row) => row.roleId));

    const groupIds = groupMemberRows.map((row) => row.principalGroupId);

    if (groupIds.length > 0) {
      const groupRoleRows = await this.readAccessTable(
        () =>
          this.db
            .select({ roleId: groupRoleAssignments.roleId })
            .from(groupRoleAssignments)
            .where(
              and(
                eq(groupRoleAssignments.orgId, orgId),
                inArray(groupRoleAssignments.principalGroupId, groupIds),
              ),
            )
            .limit(500),
      );
      for (const row of groupRoleRows) roleIds.add(row.roleId);
    }

    const result: Record<string, DataScope> = {};
    const merge = (key: string, scope: DataScope): void => {
      const existing = result[key];
      result[key] = existing ? broadest(existing, scope) : scope;
    };
    const mergeIfKnown = (
      key: string,
      scope: DataScope,
      source: string,
    ): void => {
      const canonicalKey =
        key === "hr:employees:read" ? "hr:employees:view" : key;
      // The write-time guard only covers the API grant paths, so a migration can
      // still seat an org-only key in a grant table (0437 did). Owners and org
      // admins returned the whole catalog above and never reach here.
      if (!isDelegablePermission(canonicalKey)) {
        if (!this.warnedUnknownKeys.has(canonicalKey)) {
          this.warnedUnknownKeys.add(canonicalKey);
          logger.warn(
            "access: org-only permission key found in a grant - dropped from resolved permissions",
            { orgId, key: canonicalKey, source },
          );
        }
        return;
      }
      if (CATALOG_KEY_SET.has(canonicalKey)) {
        merge(canonicalKey, scope);
        return;
      }
      if (!this.warnedUnknownKeys.has(key)) {
        this.warnedUnknownKeys.add(key);
        logger.warn(
          "access: unknown permission key in grant - absent from catalog, omitted from resolved permissions",
          {
            orgId,
            key,
            source,
          },
        );
      }
    };

    for (const grant of UNIVERSAL_MEMBER_PERMISSION_GRANTS) {
      merge(grant.permissionKey, grant.scope);
    }
    for (const grant of EMPLOYEE_SELF_SERVICE_GRANTS) {
      merge(grant.permissionKey, grant.scope);
    }

    const roleIdList = Array.from(roleIds);
    if (roleIdList.length > 0) {
      // The bound is the id list itself, not a constant. `roleIds` unions the
      // 500 direct assignments read above with the 500 group-derived ones, so a
      // fixed `.limit(500)` truncated a 1000-id lookup with no `ORDER BY`: the
      // roles that fell off resolved to no slug record and lost every
      // ROLE_DEFAULT_PERMISSIONS key, silently and non-deterministically.
      const roleRecords = await this.db
        .select({ id: roles.id, slug: roles.slug })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), inArray(roles.id, roleIdList)))
        .limit(roleIdList.length);
      const roleById = new Map(
        roleRecords.map((record) => [record.id, record]),
      );

      const grantRows = await drainRolePermissionGrants(
        this.db,
        this.readAccessTable,
        orgId,
        roleIdList,
      );
      const grantsByRole = new Map<
        number,
        { permissionKey: string; scope: DataScope }[]
      >();
      for (const grant of grantRows) {
        const list = grantsByRole.get(grant.roleId) ?? [];
        list.push({ permissionKey: grant.permissionKey, scope: grant.scope });
        grantsByRole.set(grant.roleId, list);
      }

      for (const roleId of roleIdList) {
        const grants = grantsByRole.get(roleId);
        if (grants && grants.length > 0) {
          for (const grant of grants)
            mergeIfKnown(grant.permissionKey, grant.scope, "role-grant");
          continue;
        }
        const record = roleById.get(roleId);
        const defaults = record
          ? (ROLE_DEFAULT_PERMISSIONS[record.slug] ?? [])
          : [];
        for (const key of defaults) merge(key, "all");
      }
    }

    const delegatedPermissionRows = await drainDelegatedPermissionGrants(
      this.db,
      this.readAccessTable,
      orgId,
      membershipId,
      now,
    );
    for (const row of delegatedPermissionRows) {
      if (row.startsAt.getTime() > now.getTime()) continue;
      mergeIfKnown(row.permissionKey, "all", "delegation");
    }

    for (const row of personalGrantRows) {
      mergeIfKnown(row.permissionKey, row.scope, "user-grant");
    }

    // Ownership expansion is not a grant path, so the org-only bar has to bite here too.
    for (const { moduleKey } of ownershipRows) {
      for (const key of moduleScopedPermissions(moduleKey)) {
        if (!isDelegablePermission(key)) continue;
        merge(key, "all");
      }
    }

    for (const [key, scope] of Object.entries(platformScopes)) merge(key, scope);

    deriveAccessViewImplication(result);
    return {
      perms: result,
      transitions: {
        roleAssignmentExpiry: earliestAfter(
          now,
          assignmentRows.map((row) => row.expiresAt),
        ),
        delegationStart: earliestAfter(
          now,
          delegatedPermissionRows.map((row) => row.startsAt),
        ),
        delegationEnd: earliestAfter(
          now,
          delegatedPermissionRows.map((row) => row.endsAt),
        ),
      },
    };
  }

  async getMembershipAccessState(
    orgId: string,
    userId: string,
    version: number,
    membership?: MembershipReader,
  ): Promise<{ active: boolean; isOwnerOrAdmin: boolean }> {
    const cacheKey = membershipCacheKey(orgId, userId, version);
    const cached = this.membershipAccessCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const member = await (membership ?? this.resolveMembership)(orgId, userId);
    const active = member.active;
    const isOwnerOrAdmin = ownsOrAdministers(member);
    this.membershipAccessCache.set(cacheKey, {
      active,
      isOwnerOrAdmin,
      expiresAt: Date.now() + this.deniedModulesTtlMs,
    });
    return { active, isOwnerOrAdmin };
  }
}
