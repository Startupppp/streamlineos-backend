import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  groupRoleAssignments,
  moduleOwnerships,
  principalGroupMembers,
  roleAssignments,
  roles,
} from "../../db/schema";
import { MembershipStateService } from "../../common/auth/membership-state.service";
import type { MembershipState } from "../../common/auth/membership-state.service";
import { isDelegablePermission } from "../../common/rbac/grantability";
import {
  ORG_MEMBER_ROLES,
  isOrgMemberRole,
  type OrgMemberRole,
} from "../../common/rbac/org-roles";
import { administeringModuleOf } from "../../common/rbac/module-vocabulary";
import {
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSION_GRANTS,
  moduleScopedPermissions,
} from "../rbac/permissions";
import type { DataScope } from "./access.types";
import {
  CATALOG_KEY_SET,
  EMPLOYEE_SELF_SERVICE_GRANTS,
  allCatalogScopes,
  broadest,
  deriveAccessViewImplication,
  platformCapabilityScopes,
} from "./access-policy";
import {
  drainDelegatedPermissionGrants,
  drainRolePermissionGrants,
  drainUserPermissionGrants,
  type ReadAccessTable,
} from "./access-grant-drains";
import { EntitlementsService } from "./entitlements.service";
import { type Clock, SYSTEM_CLOCK } from "./snapshot-validity";

export const GRANT_SOURCE_KINDS = [
  "org-standing",
  "universal-member",
  "employee-self-service",
  "role-grant",
  "role-default",
  "delegation",
  "user-grant",
  "module-ownership",
  "platform-capability",
  "access-view-implication",
] as const;

export type GrantSourceKind = (typeof GRANT_SOURCE_KINDS)[number];

export const MODULE_STANDINGS = ["owner", "admin", "member", "none"] as const;

export type ModuleStanding = (typeof MODULE_STANDINGS)[number];

export interface GrantSource {
  kind: GrantSourceKind;
  label: string;
  scope: DataScope;
  moduleKey: string | null;
  expiresAt: Date | null;
}

export interface ExplainedPermission {
  permissionKey: string;
  moduleKey: string;
  scope: DataScope;
  expiresAt: Date | null;
  sources: GrantSource[];
}

export interface ExplainedModuleStanding {
  moduleKey: string;
  standing: ModuleStanding;
  available: boolean;
  permissionCount: number;
}

export interface AccessExplanation {
  standing: OrgMemberRole;
  active: boolean;
  permissions: ExplainedPermission[];
  moduleStandings: ExplainedModuleStanding[];
}

/**
 * The effective scope map implied by a provenance walk.
 *
 * This exists so `access-explain.resolver.spec.ts` can put the walk and
 * `AccessPermissionResolver.computeUserPermissions` over one fixture and assert
 * the two maps are identical. A provenance view that drifts from the resolver
 * shows rights the API does not grant, so the derivation has to be checkable
 * from outside the class.
 */
export function effectiveScopesOf(
  permissions: readonly ExplainedPermission[],
): Record<string, DataScope> {
  const scopes: Record<string, DataScope> = {};
  for (const entry of permissions) scopes[entry.permissionKey] = entry.scope;
  return scopes;
}

/**
 * Attribution laid over an authoritative scope map, never the other way round.
 *
 * `AccessService.resolveUserPermissions` is what every guard enforces, and it
 * also strips the person's denied modules — something the provenance walk does
 * not model, because a denial removes a key rather than granting one. Anything
 * the authority dropped is dropped here too, and the surviving keys take the
 * authority's scope, so a displayed right cannot outrun the API.
 */
export function restrictExplanationTo(
  explanation: AccessExplanation,
  effective: Readonly<Record<string, DataScope>>,
): Pick<AccessExplanation, "permissions" | "moduleStandings"> {
  const permissions = explanation.permissions
    .filter((entry) => effective[entry.permissionKey] !== undefined)
    .map((entry) => ({
      ...entry,
      scope: effective[entry.permissionKey] ?? entry.scope,
    }));
  const counts = new Map<string, number>();
  for (const entry of permissions)
    counts.set(entry.moduleKey, (counts.get(entry.moduleKey) ?? 0) + 1);
  const moduleStandings = explanation.moduleStandings
    .filter(
      (standing) =>
        counts.has(standing.moduleKey) || standing.standing === "owner",
    )
    .map((standing) => ({
      ...standing,
      permissionCount: counts.get(standing.moduleKey) ?? 0,
    }));
  return { permissions, moduleStandings };
}

export function orgStandingOf(member: MembershipState): OrgMemberRole {
  if (member.isOwner) return ORG_MEMBER_ROLES.OWNER;
  if (isOrgMemberRole(member.role)) return member.role;
  return ORG_MEMBER_ROLES.MEMBER;
}

function ownsOrAdministers(member: MembershipState): boolean {
  return (
    member.active &&
    (member.isOwner || member.role === ORG_MEMBER_ROLES.ORG_ADMIN)
  );
}

function canonicalKeyOf(permissionKey: string): string {
  return permissionKey === "hr:employees:read"
    ? "hr:employees:view"
    : permissionKey;
}

function earliestExpiry(sources: readonly GrantSource[]): Date | null {
  if (sources.length === 0) return null;
  let earliest: Date | null = null;
  for (const source of sources) {
    if (source.expiresAt === null) return null;
    if (earliest === null || source.expiresAt < earliest)
      earliest = source.expiresAt;
  }
  return earliest;
}

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
      : await this.explainGrantPaths(
          orgId,
          userId,
          membershipId,
          ownedModules,
        );
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
        this.readAccessTable(() =>
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
            .orderBy(asc(roleAssignments.id))
            .limit(500),
        ),
        this.readAccessTable(() =>
          this.db
            .select({ principalGroupId: principalGroupMembers.principalGroupId })
            .from(principalGroupMembers)
            .where(
              and(
                eq(principalGroupMembers.orgId, orgId),
                eq(principalGroupMembers.organizationMembershipId, membershipId),
              ),
            )
            .orderBy(asc(principalGroupMembers.id))
            .limit(500),
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
      const groupRoleRows = await this.readAccessTable(() =>
        this.db
          .select({ roleId: groupRoleAssignments.roleId })
          .from(groupRoleAssignments)
          .where(
            and(
              eq(groupRoleAssignments.orgId, orgId),
              inArray(groupRoleAssignments.principalGroupId, groupIds),
            ),
          )
          .orderBy(asc(groupRoleAssignments.id))
          .limit(500),
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

    walk.applyAccessViewImplication();
    return walk.collect();
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
    const rows = await this.readAccessTable(() =>
      this.db
        .select({ moduleKey: moduleOwnerships.moduleKey })
        .from(moduleOwnerships)
        .where(
          and(
            eq(moduleOwnerships.orgId, orgId),
            eq(moduleOwnerships.ownerMembershipId, membershipId),
          ),
        )
        .orderBy(asc(moduleOwnerships.id))
        .limit(100),
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

function moduleStandingOf(
  moduleKey: string,
  ownedModules: ReadonlySet<string>,
  administersOrg: boolean,
  held: ReadonlySet<string>,
  permissionCount: number,
): ModuleStanding {
  if (ownedModules.has(moduleKey)) return "owner";
  if (administersOrg || held.has(`${moduleKey}:access:manage`)) return "admin";
  return permissionCount > 0 ? "member" : "none";
}

/**
 * The merge rule, kept in one place so the two entry points above cannot answer
 * a key differently. `merge` and `mergeIfKnown` mirror the two folds in
 * `AccessPermissionResolver.computeUserPermissions` exactly, including the
 * `hr:employees:read` canonicalisation and the org-only bar: a key that never
 * reaches the effective map must never appear as displayed provenance either.
 */
class ProvenanceWalk {
  private readonly scopes: Record<string, DataScope> = {};
  private readonly sources = new Map<string, GrantSource[]>();

  merge(permissionKey: string, scope: DataScope, source: GrantSource): void {
    const existing = this.scopes[permissionKey];
    this.scopes[permissionKey] = existing ? broadest(existing, scope) : scope;
    const list = this.sources.get(permissionKey) ?? [];
    list.push(source);
    this.sources.set(permissionKey, list);
  }

  mergeIfKnown(
    permissionKey: string,
    scope: DataScope,
    source: GrantSource,
  ): void {
    const canonicalKey = canonicalKeyOf(permissionKey);
    if (!isDelegablePermission(canonicalKey)) return;
    if (!CATALOG_KEY_SET.has(canonicalKey)) return;
    this.merge(canonicalKey, scope, source);
  }

  applyAccessViewImplication(): void {
    const before: Record<string, DataScope> = { ...this.scopes };
    deriveAccessViewImplication(this.scopes);
    for (const [permissionKey, scope] of Object.entries(this.scopes)) {
      if (before[permissionKey] === scope) continue;
      const list = this.sources.get(permissionKey) ?? [];
      list.push({
        kind: "access-view-implication",
        label: "Implied by the module's manage permission",
        scope,
        moduleKey: administeringModuleOf(permissionKey),
        expiresAt: null,
      });
      this.sources.set(permissionKey, list);
    }
  }

  collect(): ExplainedPermission[] {
    return Object.entries(this.scopes)
      .map(([permissionKey, scope]) => {
        const sources = this.sources.get(permissionKey) ?? [];
        return {
          permissionKey,
          moduleKey: administeringModuleOf(permissionKey),
          scope,
          expiresAt: earliestExpiry(sources),
          sources,
        };
      })
      .sort((left, right) =>
        left.permissionKey.localeCompare(right.permissionKey),
      );
  }
}
