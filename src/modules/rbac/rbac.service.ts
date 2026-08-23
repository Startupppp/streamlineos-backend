import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import {
  organizationMembers,
  rolePermissionGrants,
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
  isDelegablePermission,
  ORG_ADMIN_PERMISSION_KEY,
  RESERVED_PROPAGATION_KEYS,
  ROLE_RANK,
  toGrantableSet,
} from "../../common/rbac/grantability";
import { resolveActorRankContext } from "../../common/rbac/resolve-actor-rank";
import { isStructuralOrgAdmin } from "../../common/rbac/is-structural-org-admin";
import {
  PERMISSIONS,
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
import { ROLE_TEMPLATES } from "./role-templates.constants";

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
    private readonly cache: CacheService,
  ) {}

  getAllPermissions(): Permission[] {
    return DISCOVERABLE_PERMISSIONS;
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
    return isStructuralOrgAdmin(this.db, actor);
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

    const { allowedModules } = await resolveActorRankContext(this.db, actor.orgId, actor.userId);
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
        grantableKeys: PERMISSIONS.map((p) => p.name).filter(isDelegablePermission),
        assignableRanks: [ROLE_RANK.MODULE_ADMIN, ROLE_RANK.MODULE_CUSTOM, ROLE_RANK.FUNCTIONAL],
        allowedModules: null,
      };
    }

    const [resolved, { bestRank, allowedModules }] = await Promise.all([
      this.access.resolveUserPermissions(actor.orgId, actor.userId),
      resolveActorRankContext(this.db, actor.orgId, actor.userId),
    ]);

    const grantable = toGrantableSet(resolved);
    const canPropagateReserved = grantable.has(ORG_ADMIN_PERMISSION_KEY);
    const permMeta = buildPermissionModuleMap(PERMISSIONS.map((p) => p.name));

    const grantableKeys = PERMISSIONS
      .map((p) => p.name)
      .filter((key) => {
        if (!isDelegablePermission(key)) return false;
        if (!grantable.has(key)) return false;
        if (!canPropagateReserved && RESERVED_PROPAGATION_KEYS.has(key)) {
          return false;
        }
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
