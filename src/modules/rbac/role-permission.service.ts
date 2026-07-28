import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { rolePermissionGrants, roles } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import {
  assertPermissionsGrantable,
  toGrantableSet,
} from "../../common/rbac/grantability";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import { PERMISSIONS, ROLE_DEFAULT_PERMISSIONS } from "./permissions";
import type { SetRolePermissionsInput } from "./dto/rbac.schemas";

const CATALOG_KEYS = new Set(PERMISSIONS.map((permission) => permission.name));
const ROLES_PAGE_LIMIT = 100;

@Injectable()
export class RolePermissionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  private async assertGrantable(
    actor: CurrentUserContext,
    requestedKeys: readonly string[],
  ): Promise<void> {
    if (actor.isOrgOwner || actor.isPlatformAdmin) return;
    const resolved = await this.access.resolveUserPermissions(
      actor.orgId,
      actor.userId,
    );
    assertPermissionsGrantable(
      { isOrgOwner: false, isPlatformAdmin: false, grantable: toGrantableSet(resolved) },
      requestedKeys,
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
  ): Promise<{ success: true }> {
    await this.getRole(actor.orgId, roleId);

    const deduped = new Map<string, DataScope>();
    for (const item of input.items) {
      if (!CATALOG_KEYS.has(item.permissionKey)) {
        throw new BadRequestException(
          `Unknown permission key: ${item.permissionKey}`,
        );
      }
      deduped.set(item.permissionKey, item.scope);
    }

    await this.assertGrantable(actor, Array.from(deduped.keys()));

    await this.db.transaction(async (tx): Promise<void> => {
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
    });

    await this.cache.invalidate(CACHE_KEYS.rolesList(actor.orgId));

    this.audit.log({
      action: "role.permissions.set",
      userId: actor.userId,
      orgId: actor.orgId,
      targetId: String(roleId),
      targetType: "role",
      metadata: { count: deduped.size },
    });

    return { success: true };
  }

  async getPermissionsMatrix(orgId: string): Promise<
    {
      roleId: number;
      roleName: string;
      roleSlug: string;
      permissions: string[];
    }[]
  > {
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

    const allGrants = await this.db
      .select({
        roleId: rolePermissionGrants.roleId,
        permissionKey: rolePermissionGrants.permissionKey,
      })
      .from(rolePermissionGrants)
      .where(eq(rolePermissionGrants.orgId, orgId))
      .limit(10000);

    const grantsByRole = new Map<number, string[]>();
    for (const grant of allGrants) {
      const existing = grantsByRole.get(grant.roleId) ?? [];
      existing.push(grant.permissionKey);
      grantsByRole.set(grant.roleId, existing);
    }

    return orgRoles.map((role) => {
      const explicit = grantsByRole.get(role.id);
      const permissions = explicit ?? (ROLE_DEFAULT_PERMISSIONS[role.slug] ?? []);
      return {
        roleId: role.id,
        roleName: role.name,
        roleSlug: role.slug,
        permissions,
      };
    });
  }
}
