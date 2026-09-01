import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  organizationMembers,
  roleAssignments,
  rolePermissionGrants,
  roles,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import {
  assertPermissionsGrantable,
  buildPermissionModuleMap,
  isImmutableSystemRole,
  toGrantableSet,
  type RoleGrantTarget,
} from "../../common/rbac/grantability";
import { resolveActorRankContext } from "../../common/rbac/resolve-actor-rank";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import {
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSIONS,
} from "./permissions";
import type { SetRolePermissionsInput } from "./dto/rbac.schemas";

const CATALOG_KEYS = new Set(PERMISSIONS.map((permission) => permission.name));
const UNIVERSAL_PERMISSION_KEYS = new Set<string>(
  UNIVERSAL_MEMBER_PERMISSIONS,
);
const ROLES_PAGE_LIMIT = 100;

export interface RolePermissionMatrixEntry {
  roleId: number;
  roleName: string;
  roleSlug: string;
  permissions: string[];
}

@Injectable()
export class RolePermissionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  private async invalidateRoleHolderSessions(
    orgId: string,
    roleId: number,
  ): Promise<void> {
    const assignees = await this.db
      .select({ userId: organizationMembers.userId })
      .from(roleAssignments)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, roleAssignments.orgId),
          eq(organizationMembers.id, roleAssignments.organizationMembershipId),
        ),
      )
      .where(
        and(
          eq(roleAssignments.orgId, orgId),
          eq(roleAssignments.roleId, roleId),
        ),
      )
      .limit(500);
    await Promise.all(
      assignees.map((a) =>
        this.cache.invalidate(CACHE_KEYS.userSession(a.userId)),
      ),
    );
  }

  private async assertGrantable(
    actor: CurrentUserContext,
    requestedKeys: readonly string[],
    target?: RoleGrantTarget,
  ): Promise<void> {
    if (actor.isOrgOwner) return;
    const [resolved, { bestRank, allowedModules }] = await Promise.all([
      this.access.resolveUserPermissions(actor.orgId, actor.userId),
      resolveActorRankContext(this.db, actor.orgId, actor.userId),
    ]);
    const permMeta = buildPermissionModuleMap(requestedKeys);
    assertPermissionsGrantable(
      {
        isOrgOwner: false,
        grantable: toGrantableSet(resolved),
        bestRank,
        allowedModules,
      },
      requestedKeys,
      target,
      permMeta,
    );
  }

  private async getRole(orgId: string, roleId: number) {
    const role = await this.db.query.roles.findFirst({
      where: and(eq(roles.id, roleId), eq(roles.orgId, orgId)),
    });
    if (!role) throw new NotFoundException("Role not found");
    return role;
  }

  async getRolePermissions(
    orgId: string,
    roleId: number,
  ): Promise<{ permissionKey: string; scope: DataScope }[]> {
    const version = await this.access.getPermissionsVersion(orgId);
    return this.cache.cached(
      CACHE_KEYS.rolePerms(orgId, roleId, version),
      () => this.fetchRolePermissions(orgId, roleId),
      CACHE_TTL.VERY_LONG,
    );
  }

  private async fetchRolePermissions(
    orgId: string,
    roleId: number,
  ): Promise<{ permissionKey: string; scope: DataScope }[]> {
    const role = await this.getRole(orgId, roleId);

    const grants = await this.db
      .select({
        permissionKey: rolePermissionGrants.permissionKey,
        scope: rolePermissionGrants.scope,
      })
      .from(rolePermissionGrants)
      .where(
        and(
          eq(rolePermissionGrants.orgId, orgId),
          eq(rolePermissionGrants.roleId, roleId),
        ),
      )
      .limit(500);
    if (grants.length > 0) return grants;

    return (ROLE_DEFAULT_PERMISSIONS[role.slug] ?? []).map((permissionKey) => ({
      permissionKey,
      scope: "all" as DataScope,
    }));
  }

  async setRolePermissions(
    actor: CurrentUserContext,
    roleId: number,
    input: SetRolePermissionsInput,
  ): Promise<{ success: true; version: number }> {
    const existingRole = await this.getRole(actor.orgId, roleId);

    if (isImmutableSystemRole(existingRole))
      throw new ForbiddenException(
        "Organization-level system roles cannot be modified",
      );

    const deduped = new Map<string, DataScope>();
    for (const item of input.items) {
      if (!CATALOG_KEYS.has(item.permissionKey)) {
        throw new BadRequestException(
          `Unknown permission key: ${item.permissionKey}`,
        );
      }
      if (UNIVERSAL_PERMISSION_KEYS.has(item.permissionKey)) continue;
      deduped.set(item.permissionKey, item.scope);
    }

    const target: RoleGrantTarget = {
      rank: existingRole.rank,
      moduleKey: existingRole.moduleKey,
    };
    await this.assertGrantable(actor, Array.from(deduped.keys()), target);

    const nextVersion = existingRole.version + 1;

    await runInTenantTransaction(this.db, async (tx): Promise<void> => {
      const updated = await tx
        .update(roles)
        .set({ version: nextVersion })
        .where(
          and(
            eq(roles.id, roleId),
            eq(roles.orgId, actor.orgId),
            eq(roles.version, input.version),
          ),
        )
        .returning({ id: roles.id });

      if (updated.length === 0) {
        throw new ConflictException(
          "This role was changed by someone else. Reload and try again.",
        );
      }

      await tx
        .delete(rolePermissionGrants)
        .where(
          and(
            eq(rolePermissionGrants.orgId, actor.orgId),
            eq(rolePermissionGrants.roleId, roleId),
          ),
        );

      if (deduped.size > 0) {
        await tx.insert(rolePermissionGrants).values(
          Array.from(deduped, ([permissionKey, scope]) => ({
            orgId: actor.orgId,
            roleId,
            permissionKey,
            scope,
          })),
        );
      }

      await bumpPermissionsVersion(tx, actor.orgId);
    }, { orgId: actor.orgId });

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));
    await this.invalidateRoleHolderSessions(actor.orgId, roleId);

    this.audit.log({
      action: "role.permissions.set",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(roleId),
      targetType: "role",
      metadata: { count: deduped.size },
    });

    return { success: true, version: nextVersion };
  }

  async getPermissionsMatrix(
    orgId: string,
  ): Promise<RolePermissionMatrixEntry[]> {
    const version = await this.access.getPermissionsVersion(orgId);
    return this.cache.cached(
      CACHE_KEYS.permissionsMatrix(orgId, version),
      () => this.fetchPermissionsMatrix(orgId),
      CACHE_TTL.VERY_LONG,
    );
  }

  private async fetchPermissionsMatrix(
    orgId: string,
  ): Promise<RolePermissionMatrixEntry[]> {
    const orgRoles = await this.db
      .select({
        id: roles.id,
        name: roles.name,
        slug: roles.slug,
      })
      .from(roles)
      .where(eq(roles.orgId, orgId))
      .orderBy(asc(roles.name))
      .limit(ROLES_PAGE_LIMIT);

    if (orgRoles.length === 0) return [];

    const roleIds = orgRoles.map((r) => r.id);

    const allGrants = await this.db
      .select({
        roleId: rolePermissionGrants.roleId,
        permissionKey: rolePermissionGrants.permissionKey,
      })
      .from(rolePermissionGrants)
      .where(
        and(
          eq(rolePermissionGrants.orgId, orgId),
          inArray(rolePermissionGrants.roleId, roleIds),
        ),
      )
      .limit(500);

    const grantsByRole = new Map<number, string[]>();
    for (const grant of allGrants) {
      const existing = grantsByRole.get(grant.roleId) ?? [];
      existing.push(grant.permissionKey);
      grantsByRole.set(grant.roleId, existing);
    }

    return orgRoles.map((role) => {
      const explicit = grantsByRole.get(role.id);
      const rolePermissions =
        explicit ?? ROLE_DEFAULT_PERMISSIONS[role.slug] ?? [];
      const permissions = Array.from(
        new Set([...UNIVERSAL_MEMBER_PERMISSIONS, ...rolePermissions]),
      );
      return {
        roleId: role.id,
        roleName: role.name,
        roleSlug: role.slug,
        permissions,
      };
    });
  }
}
