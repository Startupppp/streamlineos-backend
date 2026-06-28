import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, or } from "drizzle-orm";
import { organizationMembers, rolePermissions, roles, userPermissions, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { PERMISSIONS, ROLE_DEFAULT_PERMISSIONS, type Permission } from "./permissions.constants";
import type { AssignRolePermissionInput } from "./dto/rbac.schemas";

@Injectable()
export class RbacService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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
    });

    const rolePerms = role
      ? await this.db.query.rolePermissions.findMany({
          where: and(eq(rolePermissions.role, role), eq(rolePermissions.orgId, orgId)),
          with: { permission: true },
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
    const hasAccess =
      actor.isPlatformAdmin ||
      actor.isOrgOwner ||
      (await this.checkPermission(actor.userId, actor.orgId, actor.role, "settings:rbac:manage"));

    if (!hasAccess) throw new ForbiddenException("Permission denied");

    await this.db.transaction(async (tx) => {
      await tx.insert(rolePermissions).values({
        role: input.role,
        permissionId: input.permissionId,
        orgId: actor.orgId,
      });
      await bumpPermissionsVersion(tx, actor.orgId);
    });

    return { success: true };
  }

  private async checkPermission(
    userId: string,
    orgId: string,
    role: string | undefined,
    permissionName: string,
  ): Promise<boolean> {
    const member = await this.db.query.organizationMembers
      .findFirst({
        where: and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgId)),
        columns: { isOwner: true },
      })
      .catch(() => null);
    if (member?.isOwner) return true;

    const userPerms = await this.db.query.userPermissions.findMany({
      where: and(eq(userPermissions.userId, userId), eq(userPermissions.orgId, orgId)),
      with: { permission: true },
    });

    const matchingUserPerm = userPerms.find((up) => up.permission?.name === permissionName);
    if (matchingUserPerm) return matchingUserPerm.granted;

    if (role) {
      const rolePerms = await this.db.query.rolePermissions.findMany({
        where: and(
          eq(rolePermissions.role, role),
          or(eq(rolePermissions.orgId, orgId), isNull(rolePermissions.orgId)),
        ),
        with: { permission: true },
      });
      if (rolePerms.some((rp) => rp.permission?.name === permissionName)) return true;
    }

    if (role) {
      const dbRole = await this.db.query.roles.findFirst({
        where: and(eq(roles.slug, role), eq(roles.orgId, orgId)),
      });
      if (dbRole?.permissions && Array.isArray(dbRole.permissions)) {
        if (dbRole.permissions.includes(permissionName)) return true;
      }
    }

    return false;
  }
}
