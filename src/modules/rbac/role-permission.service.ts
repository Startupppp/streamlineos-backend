import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  rolePermissionGrants,
  roles,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";
import {
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSIONS,
} from "./permissions";
import { setRolePermissions, type RoleWriteDeps } from "./lib/role-permission-writes";
import type { SetRolePermissionsInput } from "./dto/rbac.schemas";

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

  /** @see lib/role-permission-writes.ts */
  async setRolePermissions(
    actor: CurrentUserContext,
    roleId: number,
    input: SetRolePermissionsInput,
  ): Promise<{ success: true; version: number }> {
    return setRolePermissions(this.roleWriteDeps, actor, roleId, input);
  }

  private get roleWriteDeps(): RoleWriteDeps {
    return {
      db: this.db,
      cache: this.cache,
      access: this.access,
      getRole: (orgId, roleId) => this.getRole(orgId, roleId),
    };
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
