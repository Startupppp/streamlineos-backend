import { and, eq, isNull, lte, sql } from "drizzle-orm";
import {
  kbSpaceMembers,
  kbSpaces,
  moduleOwnerships,
  roleAssignments,
  roles,
} from "../../../db/schema";
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

/**
 * `kb_space_members.membership_id` cascades on membership delete, and KB reads a space with no
 * members as unrestricted — so letting a space's only admin depart would publish that space to
 * the whole organisation. `KbMembersService.remove` refuses the same thing at the other door.
 */
export async function querySoleAdminSpaceNames(
  db: DbOrTx,
  orgId: string,
  membershipId: number,
): Promise<string[]> {
  const rows = await db
    .select({ name: kbSpaces.name })
    .from(kbSpaceMembers)
    .innerJoin(
      kbSpaces,
      and(eq(kbSpaces.id, kbSpaceMembers.spaceId), eq(kbSpaces.orgId, kbSpaceMembers.orgId)),
    )
    .where(
      and(
        eq(kbSpaceMembers.orgId, orgId),
        eq(kbSpaceMembers.membershipId, membershipId),
        eq(kbSpaceMembers.spaceRole, "admin"),
        isNull(kbSpaces.deletedAt),
        sql`NOT EXISTS (
          SELECT 1 FROM ${kbSpaceMembers} AS other_admin
          WHERE other_admin.org_id = ${orgId}
            AND other_admin.space_id = ${kbSpaceMembers.spaceId}
            AND other_admin.space_role = 'admin'
            AND other_admin.id <> ${kbSpaceMembers.id}
        )`,
      ),
    )
    .limit(100);
  return rows.map((r) => r.name);
}
