import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { roles } from "../../db/schema";
import { MembershipStateService } from "../../common/auth/membership-state.service";
import { isDelegablePermission } from "../../common/rbac/grantability";
import { ORG_MEMBER_ROLES, type OrgMemberRole } from "../../common/rbac/org-roles";
import { administeringModuleOf } from "../../common/rbac/module-vocabulary";
import {
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSION_GRANTS,
  moduleScopedPermissions,
} from "../rbac/permissions";
import type { DataScope } from "./access.types";
import {
  EMPLOYEE_SELF_SERVICE_GRANTS,
  allCatalogScopes,
  platformCapabilityScopes,
} from "./access-policy";
import {
  drainDelegatedPermissionGrants,
  drainGroupRoleAssignments,
  drainModuleOwnerships,
  drainPrincipalGroupMemberships,
  drainRoleAssignments,
  drainRolePermissionGrants,
  drainUserPermissionGrants,
  type ReadAccessTable,
} from "./access-grant-drains";
import {
  ProvenanceWalk,
  moduleStandingOf,
  orgStandingOf,
  ownsOrAdministers,
  type AccessExplanation,
  type ExplainedModuleStanding,
  type ExplainedPermission,
} from "./access-explain-provenance";
import { EntitlementsService } from "./entitlements.service";
import { type Clock, SYSTEM_CLOCK } from "./snapshot-validity";

/**
 * Why the target person's rights resolve the way they do.
 *
 * `computeUserPermissions` folds every grant path into one
 * `Record<string, DataScope>` and discards attribution, and it is the hot cached
 * path on every request — so it is left alone. This walks the SAME tables with
 * the SAME imported drains and the SAME merge rule to recover the attribution,
 * and `access-explain.resolver.spec.ts` asserts the two produce an identical
 * effective map over one fixture. Without that assertion the screen would
 * eventually explain rights the API does not grant.
 */
@Injectable()
export class AccessExplainResolver {
  private readonly readAccessTable: ReadAccessTable = (read) =>
    Promise.resolve(read());
  private readonly clock: Clock = SYSTEM_CLOCK;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly membershipState: MembershipStateService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async explain(orgId: string, userId: string): Promise<AccessExplanation> {
    const member = await this.membershipState.resolve(userId, orgId);
    const standing = orgStandingOf(member);
    if (!member.active)
      return { standing, active: false, permissions: [], moduleStandings: [] };

    const membershipId = member.membershipId ?? 0;
    const ownedModules = await this.readOwnedModules(orgId, membershipId);
    const permissions = ownsOrAdministers(member)
      ? this.explainOrgStanding(standing, userId)
      : await this.explainGrantPaths(orgId, userId, membershipId, ownedModules);
    const moduleStandings = await this.describeModuleStandings(
      orgId,
      standing,
      ownedModules,
      permissions,
    );
    return { standing, active: true, permissions, moduleStandings };
  }

  /**
   * The owner/org-admin short-circuit, attributed.
   *
   * `computeUserPermissions` answers these two standings with
   * `{ ...allCatalogScopes(), ...platformCapabilityScopes(userId) }` and returns
   * before any grant table is read, so every key's provenance is the standing
   * itself. Platform-only keys are excluded from `allCatalogScopes` by
   * construction, so the two never collide on one key.
   */
  private explainOrgStanding(
    standing: OrgMemberRole,
    userId: string,
  ): ExplainedPermission[] {
    const walk = new ProvenanceWalk();
    const label =
      standing === ORG_MEMBER_ROLES.OWNER
        ? "Organization owner"
        : "Organization admin";
    for (const [permissionKey, scope] of Object.entries(allCatalogScopes()))
      walk.merge(permissionKey, scope, {
        kind: "org-standing",
        label,
        scope,
        moduleKey: administeringModuleOf(permissionKey),
        expiresAt: null,
      });
    this.mergePlatformCapabilities(walk, userId);
    return walk.collect();
  }

  /**
   * Every grant path a member holds, attributed, in the order the real resolver
   * folds them. The drains are imported from `access-grant-drains.ts` rather
   * than re-queried here: they carry the keyset paging that a plain
   * `.limit(500)` got wrong three times, and a private copy would lose it.
   */
  private async explainGrantPaths(
    orgId: string,
    userId: string,
    membershipId: number,
    ownedModules: ReadonlySet<string>,
  ): Promise<ExplainedPermission[]> {
    const now = this.clock.now();
    const walk = new ProvenanceWalk();

    for (const grant of UNIVERSAL_MEMBER_PERMISSION_GRANTS)
      walk.merge(grant.permissionKey, grant.scope, {
        kind: "universal-member",
        label: "Every active member",
        scope: grant.scope,
        moduleKey: administeringModuleOf(grant.permissionKey),
        expiresAt: null,
      });
    for (const grant of EMPLOYEE_SELF_SERVICE_GRANTS)
      walk.merge(grant.permissionKey, grant.scope, {
        kind: "employee-self-service",
        label: "Employee self-service",
        scope: grant.scope,
        moduleKey: administeringModuleOf(grant.permissionKey),
        expiresAt: null,
      });

    const [assignmentRows, groupMemberRows, personalGrantRows] =
      await Promise.all([
        drainRoleAssignments(
          this.db,
          this.readAccessTable,
          orgId,
          membershipId,
          now,
        ),
        drainPrincipalGroupMemberships(
          this.db,
          this.readAccessTable,
          orgId,
          membershipId,
        ),
        drainUserPermissionGrants(
          this.db,
          this.readAccessTable,
          orgId,
          membershipId,
        ),
      ]);

    // A role reached through a principal group has no assignment row, so it has
    // no `expiresAt` of its own — only the direct assignment is time-bounded.
    const expiryByRole = new Map<number, Date | null>();
    for (const row of assignmentRows) expiryByRole.set(row.roleId, row.expiresAt);
    const roleIds = new Set<number>(assignmentRows.map((row) => row.roleId));
    const groupIds = groupMemberRows.map((row) => row.principalGroupId);
    if (groupIds.length > 0) {
      const groupRoleRows = await drainGroupRoleAssignments(
        this.db,
        this.readAccessTable,
        orgId,
        groupIds,
      );
      for (const row of groupRoleRows) roleIds.add(row.roleId);
    }

    const roleIdList = Array.from(roleIds);
    if (roleIdList.length > 0)
      await this.mergeRoleGrants(walk, orgId, roleIdList, expiryByRole);

    const delegatedRows = await drainDelegatedPermissionGrants(
      this.db,
      this.readAccessTable,
      orgId,
      membershipId,
      now,
    );
    for (const row of delegatedRows) {
      if (row.startsAt.getTime() > now.getTime()) continue;
      walk.mergeIfKnown(row.permissionKey, "all", {
        kind: "delegation",
        label: "Delegation",
        scope: "all",
        moduleKey: administeringModuleOf(row.permissionKey),
        expiresAt: row.endsAt,
      });
    }

    for (const row of personalGrantRows)
      walk.mergeIfKnown(row.permissionKey, row.scope, {
        kind: "user-grant",
        label: "Direct grant to this person",
        scope: row.scope,
        moduleKey: administeringModuleOf(row.permissionKey),
        expiresAt: null,
      });

    for (const moduleKey of ownedModules)
      for (const permissionKey of moduleScopedPermissions(moduleKey)) {
        if (!isDelegablePermission(permissionKey)) continue;
        walk.merge(permissionKey, "all", {
          kind: "module-ownership",
          label: "Module ownership",
          scope: "all",
          moduleKey,
          expiresAt: null,
        });
      }

    this.mergePlatformCapabilities(walk, userId);
    walk.applyAccessViewImplication();
    return walk.collect();
  }

  private mergePlatformCapabilities(walk: ProvenanceWalk, userId: string): void {
    for (const [permissionKey, scope] of Object.entries(
      platformCapabilityScopes(userId),
    ))
      walk.merge(permissionKey, scope, {
        kind: "platform-capability",
        label: "Platform operator",
        scope,
        moduleKey: administeringModuleOf(permissionKey),
        expiresAt: null,
      });
  }

  private async mergeRoleGrants(
    walk: ProvenanceWalk,
    orgId: string,
    roleIdList: readonly number[],
    expiryByRole: ReadonlyMap<number, Date | null>,
  ): Promise<void> {
    const roleRecords = await this.db
      .select({ id: roles.id, slug: roles.slug, name: roles.name })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), inArray(roles.id, [...roleIdList])))
      .limit(roleIdList.length);
    const roleById = new Map(roleRecords.map((record) => [record.id, record]));

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
      const record = roleById.get(roleId);
      const label = record ? record.name : `Role #${roleId}`;
      const expiresAt = expiryByRole.get(roleId) ?? null;
      const grants = grantsByRole.get(roleId);
      if (grants && grants.length > 0) {
        for (const grant of grants)
          walk.mergeIfKnown(grant.permissionKey, grant.scope, {
            kind: "role-grant",
            label,
            scope: grant.scope,
            moduleKey: administeringModuleOf(grant.permissionKey),
            expiresAt,
          });
        continue;
      }
      const defaults = record ? (ROLE_DEFAULT_PERMISSIONS[record.slug] ?? []) : [];
      for (const permissionKey of defaults)
        walk.merge(permissionKey, "all", {
          kind: "role-default",
          label,
          scope: "all",
          moduleKey: administeringModuleOf(permissionKey),
          expiresAt,
        });
    }
  }

  private async readOwnedModules(
    orgId: string,
    membershipId: number,
  ): Promise<ReadonlySet<string>> {
    const rows = await drainModuleOwnerships(
      this.db,
      this.readAccessTable,
      orgId,
      membershipId,
    );
    return new Set(rows.map((row) => row.moduleKey));
  }

  /**
   * `available` is entitlement, not authority: a person can hold
   * `inventory:items:view` while the org never bought inventory, and the request
   * still 403s at `ModuleGuard`. That is the UNAVAILABLE state the screen has to
   * distinguish from DENIED, so it is resolved here rather than inferred.
   */
  private async describeModuleStandings(
    orgId: string,
    standing: OrgMemberRole,
    ownedModules: ReadonlySet<string>,
    permissions: readonly ExplainedPermission[],
  ): Promise<ExplainedModuleStanding[]> {
    const counts = new Map<string, number>();
    for (const entry of permissions)
      counts.set(entry.moduleKey, (counts.get(entry.moduleKey) ?? 0) + 1);
    for (const moduleKey of ownedModules)
      if (!counts.has(moduleKey)) counts.set(moduleKey, 0);

    const moduleMap = await this.entitlements.getModuleMap(orgId);
    const administersOrg = standing !== ORG_MEMBER_ROLES.MEMBER;
    const held = new Set(permissions.map((entry) => entry.permissionKey));

    return Array.from(counts.entries())
      .map(([moduleKey, permissionCount]) => ({
        moduleKey,
        permissionCount,
        available:
          this.entitlements.isCoreModule(moduleKey) ||
          (moduleMap[moduleKey] ?? false),
        standing: moduleStandingOf(
          moduleKey,
          ownedModules,
          administersOrg,
          held,
          permissionCount,
        ),
      }))
      .sort((left, right) => left.moduleKey.localeCompare(right.moduleKey));
  }
}
