import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  organizationMembers,
  roleAssignments,
  roles,
  rolePermissionGrants,
} from "../../../db/schema";
import { ROLE_DEFAULT_PERMISSIONS } from "../../rbac/permissions";

@Injectable()
export class PayrollApproverResolverService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  async resolveApprovers(orgId: string, requiredPermission: string): Promise<string[]> {
    const slugsWithPerm = Object.entries(ROLE_DEFAULT_PERMISSIONS)
      .filter(([, perms]) => (perms as string[]).includes(requiredPermission))
      .map(([slug]) => slug);

    const [grantRows, defaultRoleRows, ownerRows] = await Promise.all([
      this.db
        .select({ userId: organizationMembers.userId })
        .from(rolePermissionGrants)
        .innerJoin(
          roleAssignments,
          and(
            eq(roleAssignments.roleId, rolePermissionGrants.roleId),
            eq(roleAssignments.orgId, orgId),
          ),
        )
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.orgId, roleAssignments.orgId),
            eq(organizationMembers.id, roleAssignments.organizationMembershipId),
          ),
        )
        .where(
          and(
            eq(rolePermissionGrants.orgId, orgId),
            eq(rolePermissionGrants.permissionKey, requiredPermission),
          ),
        ),
      slugsWithPerm.length > 0
        ? this.db
            .select({ userId: organizationMembers.userId })
            .from(roleAssignments)
            .innerJoin(roles, eq(roleAssignments.roleId, roles.id))
            .innerJoin(
              organizationMembers,
              and(
                eq(organizationMembers.orgId, roleAssignments.orgId),
                eq(organizationMembers.id, roleAssignments.organizationMembershipId),
              ),
            )
            .where(and(eq(roleAssignments.orgId, orgId), inArray(roles.slug, slugsWithPerm)))
        : Promise.resolve<{ userId: string }[]>([]),
      this.db
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.isOwner, true))),
    ]);

    const ids = new Set<string>();
    for (const row of [...grantRows, ...defaultRoleRows, ...ownerRows]) {
      if (row.userId) ids.add(row.userId);
    }
    return Array.from(ids);
  }
}
