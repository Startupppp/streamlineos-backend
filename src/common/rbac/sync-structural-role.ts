import { Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { roleAssignments, roles } from "../../db/schema";
import { bumpPermissionsVersion, type DbOrTx } from "./access-invalidate";
import { ORG_MEMBER_ROLES } from "./org-roles";

const logger = new Logger("StructuralRoleAssignment");

/** Keeps `role_assignments` in step with a membership's structural role. */
export async function syncStructuralRoleAssignment(
  tx: DbOrTx,
  orgId: string,
  organizationMembershipId: number,
  role: string,
): Promise<void> {
  const [adminRole] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.slug, ORG_MEMBER_ROLES.ORG_ADMIN)))
    .limit(1);

  const [memberRole] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.slug, ORG_MEMBER_ROLES.MEMBER)))
    .limit(1);

  if (!adminRole && !memberRole) {
    if (role === ORG_MEMBER_ROLES.ORG_ADMIN || role === ORG_MEMBER_ROLES.MEMBER) {
      logger.warn(
        "Structural role rows missing for org; the member will resolve to zero permissions until system roles are seeded",
        { orgId, organizationMembershipId, role },
      );
    }
    return;
  }

  if (role === ORG_MEMBER_ROLES.ORG_ADMIN) {
    if (adminRole) {
      await tx
        .insert(roleAssignments)
        .values({
          orgId,
          organizationMembershipId,
          roleId: adminRole.id,
          assignedByMembershipId: null,
        })
        .onConflictDoNothing();
    } else {
      logger.warn(
        "ORG_ADMIN role row missing for org; the member will resolve to limited permissions until system roles are seeded",
        { orgId, organizationMembershipId },
      );
    }
    if (memberRole) {
      await tx
        .delete(roleAssignments)
        .where(
          and(
            eq(roleAssignments.orgId, orgId),
            eq(roleAssignments.organizationMembershipId, organizationMembershipId),
            eq(roleAssignments.roleId, memberRole.id),
          ),
        );
    }
  } else if (role === ORG_MEMBER_ROLES.MEMBER) {
    if (memberRole) {
      await tx
        .insert(roleAssignments)
        .values({
          orgId,
          organizationMembershipId,
          roleId: memberRole.id,
          assignedByMembershipId: null,
        })
        .onConflictDoNothing();
    } else {
      logger.warn(
        "MEMBER role row missing for org; the member will resolve to zero permissions until system roles are seeded",
        { orgId, organizationMembershipId },
      );
    }
    if (adminRole) {
      await tx
        .delete(roleAssignments)
        .where(
          and(
            eq(roleAssignments.orgId, orgId),
            eq(roleAssignments.organizationMembershipId, organizationMembershipId),
            eq(roleAssignments.roleId, adminRole.id),
          ),
        );
    }
  } else {
    if (adminRole) {
      await tx
        .delete(roleAssignments)
        .where(
          and(
            eq(roleAssignments.orgId, orgId),
            eq(roleAssignments.organizationMembershipId, organizationMembershipId),
            eq(roleAssignments.roleId, adminRole.id),
          ),
        );
    }
    if (memberRole) {
      await tx
        .delete(roleAssignments)
        .where(
          and(
            eq(roleAssignments.orgId, orgId),
            eq(roleAssignments.organizationMembershipId, organizationMembershipId),
            eq(roleAssignments.roleId, memberRole.id),
          ),
        );
    }
  }

  await bumpPermissionsVersion(tx, orgId);
}
