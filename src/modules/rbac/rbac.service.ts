import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  rolePermissionGrants,
  rolePermissions,
  roles,
  userPermissions,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { PERMISSIONS, ROLE_DEFAULT_PERMISSIONS, type Permission } from "./permissions.constants";
import type { AssignRolePermissionInput, RevokeRolePermissionInput } from "./dto/rbac.schemas";
import { AccessService } from "../access/access.service";
import { RolesService } from "./roles.service";

const RBAC_MANAGE_KEY = "settings:rbac:manage";
const CATALOG_KEYS = new Set(PERMISSIONS.map((p) => p.name));

@Injectable()
export class RbacService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly rolesService: RolesService,
  ) {}

  getAllPermissions(): Permission[] {
    return PERMISSIONS;
  }

  async getUserPermissions(userId: string, orgId: string): Promise<string[]> {
    const user = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    const role = user?.role;

    const userPerms = await this.db.query.userPermissions.findMany({
      where: and(
        eq(userPermissions.userId, userId),
        eq(userPermissions.orgId, orgId),
        eq(userPermissions.granted, true),
      ),
      with: { permission: true },
      limit: 500,
    });

    const rolePerms = role
      ? await this.db.query.rolePermissions.findMany({
          where: and(eq(rolePermissions.role, role), eq(rolePermissions.orgId, orgId)),
          with: { permission: true },
          limit: 500,
        })
      : [];

    const customRole = role
      ? await this.db.query.roles.findFirst({
          where: and(eq(roles.slug, role), eq(roles.orgId, orgId)),
          columns: { permissions: true },
        })
      : null;

    const defaultPerms = role ? ROLE_DEFAULT_PERMISSIONS[role] ?? [] : [];

    const permissionSet = new Set<string>();

    userPerms.forEach((up) => {
      if (up.permission?.name) permissionSet.add(up.permission.name);
    });

    rolePerms.forEach((rp) => {
      if (rp.permission?.name) permissionSet.add(rp.permission.name);
    });

    if (customRole?.permissions && Array.isArray(customRole.permissions)) {
      for (const perm of customRole.permissions) permissionSet.add(perm);
    }

    defaultPerms.forEach((perm) => permissionSet.add(perm));

    return Array.from(permissionSet);
  }

  async getRolePermissions(role: string, orgId: string): Promise<string[]> {
    const perms = await this.db.query.rolePermissions.findMany({
      where: and(eq(rolePermissions.role, role), eq(rolePermissions.orgId, orgId)),
      with: { permission: true },
      limit: 500,
    });

    const customRole = await this.db.query.roles.findFirst({
      where: and(eq(roles.slug, role), eq(roles.orgId, orgId)),
      columns: { permissions: true },
    });

    const result = new Set<string>();
    for (const rp of perms) {
      if (rp.permission?.name) result.add(rp.permission.name);
    }
    if (customRole?.permissions && Array.isArray(customRole.permissions)) {
      for (const p of customRole.permissions) result.add(p);
    }
    return Array.from(result);
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

    await this.db.transaction(async (tx) => {
      await tx
        .insert(rolePermissionGrants)
        .values({
          orgId: actor.orgId,
          roleId: input.roleId,
          permissionKey: input.permissionKey,
          scope: input.scope,
        })
        .onConflictDoUpdate({
          target: [rolePermissionGrants.roleId, rolePermissionGrants.permissionKey],
          set: { scope: input.scope },
        });
      await bumpPermissionsVersion(tx, actor.orgId);
    });

    return { success: true };
  }

  async revokeRolePermission(
    actor: CurrentUserContext,
    input: RevokeRolePermissionInput,
  ): Promise<{ success: true }> {
    const hasAccess = await this.checkActorAccess(actor);
    if (!hasAccess) throw new ForbiddenException("Permission denied");

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

    await this.db.transaction(async (tx) => {
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
    });

    return { success: true };
  }

  private async checkActorAccess(actor: CurrentUserContext): Promise<boolean> {
    if (actor.isPlatformAdmin || actor.isOrgOwner) return true;
    const resolved = await this.access.resolveUserPermissions(actor.orgId, actor.userId);
    const scope = resolved.get(RBAC_MANAGE_KEY);
    return !!scope && scope !== "none";
  }
}
