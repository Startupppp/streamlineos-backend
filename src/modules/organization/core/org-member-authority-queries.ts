import { and, eq, lte } from "drizzle-orm";
import { moduleOwnerships, roleAssignments, roles } from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { ROLE_RANK } from "../../../common/rbac/grantability";

export async function queryOwnedModuleKeys(
  db: DbOrTx,
  orgId: string,
  membershipId: number,
): Promise<string[]> {
  const rows = await db
    .select({ moduleKey: moduleOwnerships.moduleKey })
    .from(moduleOwnerships)
    .where(
      and(
        eq(moduleOwnerships.orgId, orgId),
        eq(moduleOwnerships.ownerMembershipId, membershipId),
      ),
    )
    .for("update")
    .limit(100);
  return rows.map((r) => r.moduleKey);
}

export async function queryPrivilegedRoleNames(
  db: DbOrTx,
  orgId: string,
  membershipId: number,
): Promise<string[]> {
  const rows = await db
    .select({ name: roles.name })
    .from(roleAssignments)
    .innerJoin(
      roles,
      and(
        eq(roleAssignments.roleId, roles.id),
        eq(roleAssignments.orgId, roles.orgId),
      ),
    )
    .where(
      and(
        eq(roleAssignments.orgId, orgId),
        eq(roleAssignments.organizationMembershipId, membershipId),
        lte(roles.rank, ROLE_RANK.MODULE_ADMIN),
      ),
    )
    .limit(100);
  return rows.map((r) => r.name);
}
