import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import {
  groupRoleAssignments,
  moduleOwnerships,
  organizationMembers,
  principalGroupMembers,
  roleAssignments,
  rolePermissionGrants,
  roles,
  userDelegationPermissions,
  userDelegations,
} from "../../db/schema";
import { logger } from "../../common/logger/logger.service";
import { ORG_MEMBER_ROLES } from "../../common/rbac/org-roles";
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
  evaluateMembershipGate,
} from "./access-policy";

export type SafeAccessTableRead = <Result>(
  read: () => PromiseLike<Result>,
  fallback: Result,
) => Promise<Result>;

export interface MembershipAccessState {
  exists: boolean;
  active: boolean;
  isOwnerOrAdmin: boolean;
  expiresAt: number;
}

export class AccessPermissionResolver {
  constructor(
    private readonly getDatabase: () => Db,
    private readonly safeAccessTableRead: SafeAccessTableRead,
    private readonly warnedUnknownKeys: Set<string>,
    private readonly membershipAccessCache: Map<string, MembershipAccessState>,
    private readonly deniedModulesTtlMs: number,
  ) {}

  private get db(): Db {
    return this.getDatabase();
  }

  async computeUserPermissions(
    orgId: string,
    userId: string,
  ): Promise<Record<string, DataScope>> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.orgId, orgId),
      ),
      columns: { isOwner: true, status: true, id: true, role: true },
    });
    const gate = evaluateMembershipGate(member);
    this.membershipAccessCache.set(`${orgId}:${userId}`, {
      exists: Boolean(member),
      active: gate.active,
      isOwnerOrAdmin:
        gate.active &&
        (gate.isOwner || member?.role === ORG_MEMBER_ROLES.ORG_ADMIN),
      expiresAt: Date.now() + this.deniedModulesTtlMs,
    });
    if (!gate.active) return {};
    if (gate.isOwner) return allCatalogScopes();
    if (member?.role === ORG_MEMBER_ROLES.ORG_ADMIN) return allCatalogScopes();

    const membershipId = member?.id ?? 0;
    const now = new Date();

    const [assignmentRows, groupMemberRows, ownershipRows] = await Promise.all([
      this.safeAccessTableRead(
        () =>
          this.db
            .select({ roleId: roleAssignments.roleId })
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
            ),
        [] as { roleId: number }[],
      ),
      this.safeAccessTableRead(
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
            ),
        [] as { principalGroupId: string }[],
      ),
      this.safeAccessTableRead(
        () =>
          this.db
            .select({ moduleKey: moduleOwnerships.moduleKey })
            .from(moduleOwnerships)
            .where(
              and(
                eq(moduleOwnerships.orgId, orgId),
                eq(moduleOwnerships.ownerMembershipId, membershipId),
              ),
            ),
        [] as { moduleKey: string }[],
      ),
    ]);

    const roleIds = new Set<number>(assignmentRows.map((row) => row.roleId));

    const groupIds = groupMemberRows.map((row) => row.principalGroupId);

    if (groupIds.length > 0) {
      const groupRoleRows = await this.safeAccessTableRead(
        () =>
          this.db
            .select({ roleId: groupRoleAssignments.roleId })
            .from(groupRoleAssignments)
            .where(
              and(
                eq(groupRoleAssignments.orgId, orgId),
                inArray(groupRoleAssignments.principalGroupId, groupIds),
              ),
            ),
        [] as { roleId: number }[],
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
      const roleRecords = await this.db
        .select({ id: roles.id, slug: roles.slug })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), inArray(roles.id, roleIdList)));
      const roleById = new Map(
        roleRecords.map((record) => [record.id, record]),
      );

      const grantRows = await this.safeAccessTableRead(
        () =>
          this.db
            .select({
              roleId: rolePermissionGrants.roleId,
              permissionKey: rolePermissionGrants.permissionKey,
              scope: rolePermissionGrants.scope,
            })
            .from(rolePermissionGrants)
            .where(
              and(
                eq(rolePermissionGrants.orgId, orgId),
                inArray(rolePermissionGrants.roleId, roleIdList),
              ),
            ),
        [],
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

    const delegatedPermissionRows = await this.safeAccessTableRead(
      () =>
        this.db
          .select({
            permissionKey: userDelegationPermissions.permissionKey,
          })
          .from(userDelegationPermissions)
          .innerJoin(
            userDelegations,
            and(
              eq(userDelegations.orgId, userDelegationPermissions.orgId),
              eq(userDelegations.id, userDelegationPermissions.delegationId),
            ),
          )
          .where(
            and(
              eq(userDelegations.orgId, orgId),
              eq(userDelegations.delegateeId, userId),
              eq(userDelegations.status, "ACTIVE"),
              lte(userDelegations.startsAt, now),
              gt(userDelegations.endsAt, now),
            ),
          ),
      [] as { permissionKey: string }[],
    );
    for (const row of delegatedPermissionRows) {
      mergeIfKnown(row.permissionKey, "all", "delegation");
    }

    for (const { moduleKey } of ownershipRows) {
      for (const key of moduleScopedPermissions(moduleKey)) {
        merge(key, "all");
      }
    }

    deriveAccessViewImplication(result);
    return result;
  }
}
