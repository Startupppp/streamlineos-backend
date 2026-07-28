import { Inject, Injectable } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import { organizationMembers, rolePermissionGrants, userRoles } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

const RBAC_MANAGE_KEY = "settings:rbac:manage";

@Injectable()
export class RoleLockoutService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async wouldLockOutLastAdmin(
    orgId: string,
    excludeUserId?: string,
    excludeRoleId?: number,
    excludePermissionKey?: string,
  ): Promise<boolean> {
    const ownerRows = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.isOwner, true)))
      .limit(1)
      .catch(() => null);
    if (ownerRows && ownerRows.length > 0) return false;

    const excludedRoleId: number | undefined =
      excludeRoleId !== undefined && excludePermissionKey === RBAC_MANAGE_KEY
        ? excludeRoleId
        : undefined;

    const rows = await this.db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(
        rolePermissionGrants,
        and(
          eq(rolePermissionGrants.roleId, userRoles.roleId),
          eq(rolePermissionGrants.orgId, orgId),
          eq(rolePermissionGrants.permissionKey, RBAC_MANAGE_KEY),
          ne(rolePermissionGrants.scope, "none"),
          excludedRoleId !== undefined
            ? ne(rolePermissionGrants.roleId, excludedRoleId)
            : undefined,
        ),
      )
      .where(eq(userRoles.orgId, orgId))
      .catch(() => null);

    if (!rows) return false;

    const holderIds = new Set(rows.map((r) => r.userId));
    if (excludeUserId) holderIds.delete(excludeUserId);

    return holderIds.size === 0;
  }
}
