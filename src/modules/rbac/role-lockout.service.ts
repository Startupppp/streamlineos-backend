import { Inject, Injectable } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import { organizationMembers, roleAssignments, rolePermissionGrants } from "../../db/schema";
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
  ): Promise<boolean> {
    const ownerRows = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.isOwner, true)))
      .limit(1)
      .catch(() => null);
    if (ownerRows && ownerRows.length > 0) return false;

    const rows = await this.db
      .select({ userId: organizationMembers.userId })
      .from(roleAssignments)
      .innerJoin(
        rolePermissionGrants,
        and(
          eq(rolePermissionGrants.roleId, roleAssignments.roleId),
          eq(rolePermissionGrants.orgId, orgId),
          eq(rolePermissionGrants.permissionKey, RBAC_MANAGE_KEY),
          ne(rolePermissionGrants.scope, "none"),
          excludeRoleId !== undefined
            ? ne(rolePermissionGrants.roleId, excludeRoleId)
            : undefined,
        ),
      )
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, roleAssignments.orgId),
          eq(organizationMembers.id, roleAssignments.organizationMembershipId),
        ),
      )
      .where(eq(roleAssignments.orgId, orgId))
      .catch(() => null);

    if (!rows) return false;

    const holderIds = new Set(rows.map((r) => r.userId));
    if (excludeUserId) holderIds.delete(excludeUserId);

    return holderIds.size === 0;
  }
}
