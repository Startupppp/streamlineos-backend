import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import {
  organizationMembers,
  roleAssignments,
  rolePermissionGrants,
  roles,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import {
  assertPermissionsGrantable,
  buildPermissionModuleMap,
  ROLE_RANK,
  toGrantableSet,
} from "../../common/rbac/grantability";
import {
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSION_GRANTS,
  UNIVERSAL_MEMBER_PERMISSIONS,
  type Permission,
  isScopable,
} from "./permissions";
import type {
  AssignRolePermissionInput,
  DiscoveryGrantableResult,
  DiscoveryMemberEntry,
  DiscoveryPermissionEntry,
  DiscoveryTemplateEntry,
  RevokeRolePermissionInput,
} from "./dto/rbac.schemas";
import { AccessService } from "../access/access.service";
import { RolesService } from "./roles.service";
import { ROLE_TEMPLATES } from "./role-templates.constants";

const RBAC_MANAGE_KEY = "settings:rbac:manage";
const CATALOG_KEYS = new Set(PERMISSIONS.map((p) => p.name));
const UNIVERSAL_PERMISSION_KEYS = new Set<string>(
  UNIVERSAL_MEMBER_PERMISSIONS,
);
const UNIVERSAL_PERMISSION_SCOPE_BY_KEY = new Map<
  string,
  "own" | "all"
>();
for (const grant of UNIVERSAL_MEMBER_PERMISSION_GRANTS) {
  UNIVERSAL_PERMISSION_SCOPE_BY_KEY.set(grant.permissionKey, grant.scope);
}
const DISCOVERABLE_PERMISSIONS: Permission[] = PERMISSIONS.map((permission) => {
  const baselineScope = UNIVERSAL_PERMISSION_SCOPE_BY_KEY.get(permission.name);
  return baselineScope ? { ...permission, baselineScope } : permission;
});

@Injectable()
export class RbacService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly rolesService: RolesService,
    private readonly cache: CacheService,
  ) {}

  getAllPermissions(): Permission[] {
    return DISCOVERABLE_PERMISSIONS;
  }

  async getUserPermissions(userId: string, orgId: string): Promise<string[]> {
    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgId)),
      columns: { role: true, status: true },
    });
    if (membership?.status !== "ACTIVE") return [];
    const role = membership?.role;

    const rolePerms = role ? await this.grantsForRoleSlug(role, orgId) : [];
    const defaultPerms = role ? (ROLE_DEFAULT_PERMISSIONS[role] ?? []) : [];

    const permissionSet = new Set<string>();

    UNIVERSAL_MEMBER_PERMISSIONS.forEach((key) => permissionSet.add(key));
    rolePerms.forEach((key) => permissionSet.add(key));
    defaultPerms.forEach((perm) => permissionSet.add(perm));

    return Array.from(permissionSet);
  }

  async getRolePermissions(role: string, orgId: string): Promise<string[]> {
    const keys = await this.grantsForRoleSlug(role, orgId);
    return Array.from(new Set([...UNIVERSAL_MEMBER_PERMISSIONS, ...keys]));
  }

  private async grantsForRoleSlug(role: string, orgId: string): Promise<string[]> {
    const rows = await this.db
      .select({ permissionKey: rolePermissionGrants.permissionKey })
      .from(rolePermissionGrants)
      .innerJoin(roles, eq(rolePermissionGrants.roleId, roles.id))
      .where(
        and(
          eq(rolePermissionGrants.orgId, orgId),
          eq(roles.orgId, orgId),
          eq(roles.slug, role),
        ),
      )
      .limit(500);

    return rows.map((row) => row.permissionKey);
  }

  async assignRolePermission(
    actor: CurrentUserContext,
    input: AssignRolePermissionInput,
  ): Promise<{ success: true }> {
    const hasAccess = await this.checkActorAccess(actor);
    if (!hasAccess) throw new ForbiddenException("Permission denied");

    if (!CATALOG_KEYS.has(input.permissionKey)) {
      throw new BadRequestException(`Unknown permission key: ${input.permissionKey}`);
    }
    if (UNIVERSAL_PERMISSION_KEYS.has(input.permissionKey)) {
      throw new BadRequestException(
        `Permission ${input.permissionKey} is included for every active member`,
      );
    }

    if (!actor.isOrgOwner) {
      const resolved = await this.access.resolveUserPermissions(
        actor.orgId,
        actor.userId,
      );
      assertPermissionsGrantable(
        { isOrgOwner: false, grantable: toGrantableSet(resolved) },
        [input.permissionKey],
      );
    }

    await runInTenantTransaction(this.db, async (tx) => {
      await tx
        .insert(rolePermissionGrants)
        .values({
          orgId: actor.orgId,
          roleId: input.roleId,
          permissionKey: input.permissionKey,
          scope: input.scope,
        })
        .onConflictDoUpdate({
          target: [
            rolePermissionGrants.orgId,
            rolePermissionGrants.roleId,
            rolePermissionGrants.permissionKey,
          ],
          set: { scope: input.scope },
        });
      await bumpPermissionsVersion(tx, actor.orgId);
    }, { orgId: actor.orgId });

    return { success: true };
  }

  async revokeRolePermission(
    actor: CurrentUserContext,
    input: RevokeRolePermissionInput,
  ): Promise<{ success: true }> {
    const hasAccess = await this.checkActorAccess(actor);
    if (!hasAccess) throw new ForbiddenException("Permission denied");

    if (UNIVERSAL_PERMISSION_KEYS.has(input.permissionKey)) {
      throw new BadRequestException(
        `Permission ${input.permissionKey} is included for every active member`,
      );
    }

    if (input.permissionKey === RBAC_MANAGE_KEY) {
      const willLockOut = await this.rolesService.wouldLockOutLastAdmin(
        actor.orgId,
        undefined,
        input.roleId,
        RBAC_MANAGE_KEY,
      );
      if (willLockOut) {
        throw new ForbiddenException(
          "Cannot revoke the last settings:rbac:manage permission grant",
        );
      }
    }

    await runInTenantTransaction(this.db, async (tx) => {
      await tx
        .delete(rolePermissionGrants)
        .where(
          and(
            eq(rolePermissionGrants.orgId, actor.orgId),
            eq(rolePermissionGrants.roleId, input.roleId),
            eq(rolePermissionGrants.permissionKey, input.permissionKey),
          ),
        );
      await bumpPermissionsVersion(tx, actor.orgId);
    }, { orgId: actor.orgId });

    return { success: true };
  }

  private async checkActorAccess(actor: CurrentUserContext): Promise<boolean> {
    if (actor.isOrgOwner) return true;
    const resolved = await this.access.resolveUserPermissions(actor.orgId, actor.userId);
    const scope = resolved.get(RBAC_MANAGE_KEY);
    return !!scope && scope !== "none";
  }

  private async resolveActorRankContext(
    orgId: string,
    userId: string,
  ): Promise<{ bestRank: number; allowedModules: Set<string> | null }> {
    const rows = await this.db
      .select({ rank: roles.rank, moduleKey: roles.moduleKey })
      .from(roleAssignments)
      .innerJoin(
        organizationMembers,
        and(
          eq(roleAssignments.organizationMembershipId, organizationMembers.id),
          eq(roleAssignments.orgId, organizationMembers.orgId),
        ),
      )
      .innerJoin(
        roles,
        and(eq(roleAssignments.roleId, roles.id), eq(roles.orgId, orgId)),
      )
      .where(
        and(
          eq(roleAssignments.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .limit(100);

    if (rows.length === 0) {
      return { bestRank: ROLE_RANK.FUNCTIONAL, allowedModules: null };
    }

    let bestRank: number = ROLE_RANK.FUNCTIONAL;
    for (const row of rows) {
      if (row.rank < bestRank) bestRank = row.rank;
    }

    const topRankRoles = rows.filter((r) => r.rank === bestRank);
    const hasOrgWideRole = topRankRoles.some((r) => r.moduleKey === null);
    if (hasOrgWideRole) {
      return { bestRank, allowedModules: null };
    }

    const modules = new Set(
      topRankRoles
        .map((r) => r.moduleKey)
        .filter((m): m is string => m !== null),
    );
    return { bestRank, allowedModules: modules };
  }

  async getDiscoveryPermissions(
    actor: CurrentUserContext,
  ): Promise<DiscoveryPermissionEntry[]> {
    if (actor.isOrgOwner) {
      return PERMISSIONS.map((p) => ({
        name: p.name,
        resource: p.resource,
        action: p.action,
        description: p.description,
        moduleKey: p.name.indexOf(":") === -1 ? null : p.name.slice(0, p.name.indexOf(":")),
        scopable: isScopable(p.name),
      }));
    }

    const { allowedModules } = await this.resolveActorRankContext(actor.orgId, actor.userId);
    return PERMISSIONS
      .filter((p) => {
        if (allowedModules === null) return true;
        const mod = p.name.indexOf(":") === -1 ? null : p.name.slice(0, p.name.indexOf(":"));
        return mod !== null && allowedModules.has(mod);
      })
      .map((p) => ({
        name: p.name,
        resource: p.resource,
        action: p.action,
        description: p.description,
        moduleKey: p.name.indexOf(":") === -1 ? null : p.name.slice(0, p.name.indexOf(":")),
        scopable: isScopable(p.name),
      }));
  }

  async getDiscoveryGrantable(
    actor: CurrentUserContext,
  ): Promise<DiscoveryGrantableResult> {
    if (actor.isOrgOwner) {
      return {
        grantableKeys: PERMISSIONS.map((p) => p.name),
        assignableRanks: [ROLE_RANK.MODULE_ADMIN, ROLE_RANK.MODULE_CUSTOM, ROLE_RANK.FUNCTIONAL],
        allowedModules: null,
      };
    }

    const [resolved, { bestRank, allowedModules }] = await Promise.all([
      this.access.resolveUserPermissions(actor.orgId, actor.userId),
      this.resolveActorRankContext(actor.orgId, actor.userId),
    ]);

    const grantable = toGrantableSet(resolved);
    const permMeta = buildPermissionModuleMap(PERMISSIONS.map((p) => p.name));

    const grantableKeys = PERMISSIONS
      .map((p) => p.name)
      .filter((key) => {
        if (!grantable.has(key)) return false;
        if (allowedModules !== null) {
          const mod = permMeta.get(key);
          if (!mod || !allowedModules.has(mod)) return false;
        }
        return true;
      });

    const assignableRanks = ([ROLE_RANK.MODULE_ADMIN, ROLE_RANK.MODULE_CUSTOM, ROLE_RANK.FUNCTIONAL] as number[])
      .filter((rank) => rank > bestRank);

    return {
      grantableKeys,
      assignableRanks,
      allowedModules: allowedModules !== null ? Array.from(allowedModules) : null,
    };
  }

  getDiscoveryTemplates(actor: CurrentUserContext): DiscoveryTemplateEntry[] {
    if (actor.isOrgOwner) {
      return ROLE_TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        permissionCount: t.permissions.length,
      }));
    }

    return ROLE_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      permissionCount: t.permissions.length,
    }));
  }

  async getDiscoveryMembers(orgId: string): Promise<DiscoveryMemberEntry[]> {
    return this.cache.cached(
      CACHE_KEYS.rbacDiscoveryMembers(orgId),
      () => this.fetchDiscoveryMembers(orgId),
      CACHE_TTL.MEDIUM,
    );
  }

  private async fetchDiscoveryMembers(orgId: string): Promise<DiscoveryMemberEntry[]> {
    const rows = await this.db
      .select({
        userId: organizationMembers.userId,
        name: users.name,
        email: users.email,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .orderBy(users.name)
      .limit(500);

    return rows.map((r) => ({
      userId: r.userId,
      name: r.name,
      email: r.email,
    }));
  }
}
