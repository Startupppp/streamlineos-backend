import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import {
  moduleOwnerships,
  organizationMembers,
  roleAssignments,
  rolePermissionGrants,
  roles,
  userPermissionGrants,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  canGrantToRank,
  ROLE_RANK,
} from "../../common/rbac/grantability";
import { resolveActorRankContext } from "../../common/rbac/resolve-actor-rank";
import { isStructuralOrgAdmin } from "../../common/rbac/is-structural-org-admin";
import { moduleDefinition } from "../../common/rbac/module-registry";
import { administeringModuleOf } from "../../common/rbac/module-vocabulary";
import {
  assertManagedModule,
  assertModuleAccessPolicy,
  moduleAccessPolicyDeps,
} from "./module-access.helpers";
import { canTransferModuleOwnership } from "./module-standing";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { SCOPE_RANK } from "../access/access-policy";
import { PERMISSIONS } from "../rbac/permissions/catalog";
import { ORG_MEMBER_ROLES } from "../../common/rbac/org-roles";

export type StandingSource =
  | "org-owner"
  | "org-admin"
  | "module-ownership"
  | "module-role"
  | "direct-grant";

const SOURCE_PRIORITY: Record<StandingSource, number> = {
  "org-owner": 0,
  "module-ownership": 1,
  "org-admin": 2,
  "module-role": 3,
  "direct-grant": 4,
};

export interface StandingEntry {
  membershipId: number;
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  rank: number;
  scope: DataScope;
  source: StandingSource;
}

export type ListStandingResult =
  | { administrable: true; entries: StandingEntry[] }
  | { administrable: false; reason: string };

export interface GrantableDescriptor {
  grantableRanks: number[];
  scopeCeiling: DataScope;
  canGrantModuleOwnership: boolean;
  isOrgOwner: boolean;
  isOrgAdmin: boolean;
}

const GRANTABLE_VIA_PERMISSIONS = [
  ROLE_RANK.MODULE_ADMIN,
  ROLE_RANK.MODULE_CUSTOM,
  ROLE_RANK.FUNCTIONAL,
] as const;

function broadestScope(a: DataScope, b: DataScope): DataScope {
  return SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b;
}

@Injectable()
export class ModuleStandingRosterService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  private async assertAccess(
    actor: CurrentUserContext,
    moduleKey: string,
    action: "view" | "manage",
  ): Promise<void> {
    assertManagedModule(moduleKey);
    await assertModuleAccessPolicy(
      moduleAccessPolicyDeps(this.db, this.access),
      actor,
      moduleKey,
      action,
    );
  }

  async listStanding(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<ListStandingResult> {
    assertManagedModule(moduleKey);

    const definition = moduleDefinition(moduleKey);
    if (!definition?.administrable) {
      await assertModuleAccessPolicy(
        moduleAccessPolicyDeps(this.db, this.access),
        actor,
        moduleKey,
        "view",
      );
      return {
        administrable: false,
        reason: `The ${definition?.displayName ?? moduleKey} module does not support role-based standing`,
      };
    }

    await this.assertAccess(actor, moduleKey, "view");
    return { administrable: true, entries: await this.fetchStanding(actor.orgId, moduleKey) };
  }

  private async fetchStanding(
    orgId: string,
    moduleKey: string,
  ): Promise<StandingEntry[]> {
    const now = new Date();
    const modulePermKeys = PERMISSIONS
      .filter(p => administeringModuleOf(p.name) === moduleKey)
      .map(p => p.name);

    const [orgLevelRows, ownershipRows, moduleRoleList] = await Promise.all([
      this.db
        .select({
          membershipId: organizationMembers.id,
          userId: organizationMembers.userId,
          name: users.name,
          email: users.email,
          image: users.image,
          isOwner: organizationMembers.isOwner,
          role: organizationMembers.role,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.status, "ACTIVE"),
            or(
              eq(organizationMembers.isOwner, true),
              eq(organizationMembers.role, ORG_MEMBER_ROLES.ORG_ADMIN),
            ),
          ),
        )
        .limit(100),
      this.db
        .select({
          membershipId: moduleOwnerships.ownerMembershipId,
          userId: organizationMembers.userId,
          name: users.name,
          email: users.email,
          image: users.image,
        })
        .from(moduleOwnerships)
        .innerJoin(
          organizationMembers,
          and(
            eq(moduleOwnerships.orgId, organizationMembers.orgId),
            eq(moduleOwnerships.ownerMembershipId, organizationMembers.id),
          ),
        )
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .where(
          and(
            eq(moduleOwnerships.orgId, orgId),
            eq(moduleOwnerships.moduleKey, moduleKey),
          ),
        )
        .limit(1),
      this.db
        .select({ id: roles.id, rank: roles.rank })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), eq(roles.moduleKey, moduleKey))),
    ]);

    const moduleRoleIds = moduleRoleList.map(r => r.id);
    const rankByRoleId = new Map(moduleRoleList.map(r => [r.id, r.rank]));

    const [assignmentRows, directGrantRows, grantScopeRows, rolesWithAnyGrantRows] =
      await Promise.all([
        moduleRoleIds.length > 0
          ? this.db
              .select({
                membershipId: roleAssignments.organizationMembershipId,
                roleId: roleAssignments.roleId,
                userId: organizationMembers.userId,
                name: users.name,
                email: users.email,
                image: users.image,
              })
              .from(roleAssignments)
              .innerJoin(
                organizationMembers,
                and(
                  eq(organizationMembers.orgId, roleAssignments.orgId),
                  eq(organizationMembers.id, roleAssignments.organizationMembershipId),
                ),
              )
              .innerJoin(users, eq(organizationMembers.userId, users.id))
              .where(
                and(
                  eq(roleAssignments.orgId, orgId),
                  inArray(roleAssignments.roleId, moduleRoleIds),
                  eq(organizationMembers.status, "ACTIVE"),
                  or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, now)),
                ),
              )
              .limit(100)
          : Promise.resolve([]),
        this.db
          .select({
            membershipId: userPermissionGrants.organizationMembershipId,
            userId: organizationMembers.userId,
            name: users.name,
            email: users.email,
            image: users.image,
            scope: userPermissionGrants.scope,
          })
          .from(userPermissionGrants)
          .innerJoin(
            organizationMembers,
            and(
              eq(userPermissionGrants.orgId, organizationMembers.orgId),
              eq(userPermissionGrants.organizationMembershipId, organizationMembers.id),
            ),
          )
          .innerJoin(users, eq(organizationMembers.userId, users.id))
          .where(
            and(
              eq(userPermissionGrants.orgId, orgId),
              eq(userPermissionGrants.moduleKey, moduleKey),
              eq(organizationMembers.status, "ACTIVE"),
            ),
          )
          .limit(100),
        moduleRoleIds.length > 0 && modulePermKeys.length > 0
          ? this.db
              .select({
                roleId: rolePermissionGrants.roleId,
                scope: rolePermissionGrants.scope,
              })
              .from(rolePermissionGrants)
              .where(
                and(
                  eq(rolePermissionGrants.orgId, orgId),
                  inArray(rolePermissionGrants.roleId, moduleRoleIds),
                  inArray(rolePermissionGrants.permissionKey, modulePermKeys),
                ),
              )
          : Promise.resolve([]),
        moduleRoleIds.length > 0
          ? this.db
              .selectDistinct({ roleId: rolePermissionGrants.roleId })
              .from(rolePermissionGrants)
              .where(
                and(
                  eq(rolePermissionGrants.orgId, orgId),
                  inArray(rolePermissionGrants.roleId, moduleRoleIds),
                ),
              )
          : Promise.resolve([]),
      ]);

    const rolesWithAnyGrant = new Set(rolesWithAnyGrantRows.map(r => r.roleId));
    const scopeByRoleId = new Map<number, DataScope>();
    for (const g of grantScopeRows) {
      const current = scopeByRoleId.get(g.roleId) ?? "none";
      scopeByRoleId.set(g.roleId, broadestScope(current, g.scope));
    }

    const ownerMembershipId = ownershipRows[0]?.membershipId ?? null;
    const entries = new Map<number, StandingEntry>();

    const upsert = (entry: StandingEntry) => {
      const existing = entries.get(entry.membershipId);
      if (!existing || SOURCE_PRIORITY[entry.source] < SOURCE_PRIORITY[existing.source])
        entries.set(entry.membershipId, entry);
    };

    for (const row of orgLevelRows) {
      const isOwner = row.isOwner === true;
      upsert({
        membershipId: row.membershipId,
        userId: row.userId,
        displayName: row.name ?? row.email ?? row.userId,
        email: row.email ?? "",
        avatarUrl: row.image,
        rank: isOwner ? ROLE_RANK.ORG_OWNER : ROLE_RANK.ORG_ADMIN,
        scope: "all",
        source: isOwner ? "org-owner" : "org-admin",
      });
    }

    if (ownershipRows[0]) {
      const row = ownershipRows[0];
      upsert({
        membershipId: row.membershipId,
        userId: row.userId,
        displayName: row.name ?? row.email ?? row.userId,
        email: row.email ?? "",
        avatarUrl: row.image,
        rank: ROLE_RANK.MODULE_OWNER,
        scope: "all",
        source: "module-ownership",
      });
    }

    for (const row of assignmentRows) {
      if (row.membershipId === ownerMembershipId) continue;
      const rank = rankByRoleId.get(row.roleId) ?? ROLE_RANK.FUNCTIONAL;
      const roleHasAnyGrant = rolesWithAnyGrant.has(row.roleId);
      const scope: DataScope = roleHasAnyGrant
        ? (scopeByRoleId.get(row.roleId) ?? "none")
        : "all";
      upsert({
        membershipId: row.membershipId,
        userId: row.userId,
        displayName: row.name ?? row.email ?? row.userId,
        email: row.email ?? "",
        avatarUrl: row.image,
        rank,
        scope,
        source: "module-role",
      });
    }

    const directScopeByMembership = new Map<number, DataScope>();
    for (const row of directGrantRows) {
      const current = directScopeByMembership.get(row.membershipId) ?? "none";
      directScopeByMembership.set(row.membershipId, broadestScope(current, row.scope));
    }
    for (const row of directGrantRows) {
      if (entries.has(row.membershipId)) continue;
      const scope = directScopeByMembership.get(row.membershipId) ?? "none";
      upsert({
        membershipId: row.membershipId,
        userId: row.userId,
        displayName: row.name ?? row.email ?? row.userId,
        email: row.email ?? "",
        avatarUrl: row.image,
        rank: ROLE_RANK.FUNCTIONAL,
        scope,
        source: "direct-grant",
      });
    }

    return Array.from(entries.values()).sort(
      (a, b) => a.rank - b.rank || a.displayName.localeCompare(b.displayName),
    );
  }

  async describeGrantable(
    actor: CurrentUserContext,
    moduleKey: string,
  ): Promise<GrantableDescriptor> {
    await this.assertAccess(actor, moduleKey, "view");

    const [isOrgAdmin, { bestRank, allowedModules }, resolved, canTransferOwnership] =
      await Promise.all([
        isStructuralOrgAdmin(this.db, actor),
        resolveActorRankContext(this.db, actor.orgId, actor.userId),
        this.access.resolveUserPermissions(actor.orgId, actor.userId),
        canTransferModuleOwnership(this.db, actor, moduleKey),
      ]);

    if (actor.isOrgOwner || isOrgAdmin) {
      return {
        grantableRanks: [...GRANTABLE_VIA_PERMISSIONS],
        scopeCeiling: "all",
        canGrantModuleOwnership: actor.isOrgOwner,
        isOrgOwner: actor.isOrgOwner,
        isOrgAdmin,
      };
    }

    const modulePermKeys = PERMISSIONS
      .filter(p => administeringModuleOf(p.name) === moduleKey)
      .map(p => p.name);

    let scopeCeiling: DataScope = "none";
    for (const key of modulePermKeys) {
      const s = resolved.get(key);
      if (s && SCOPE_RANK[s] > SCOPE_RANK[scopeCeiling]) scopeCeiling = s;
    }

    const grantableRanks = GRANTABLE_VIA_PERMISSIONS.filter(rank =>
      canGrantToRank(bestRank, allowedModules, rank, moduleKey),
    );

    return {
      grantableRanks,
      scopeCeiling,
      canGrantModuleOwnership: canTransferOwnership,
      isOrgOwner: false,
      isOrgAdmin: false,
    };
  }
}
