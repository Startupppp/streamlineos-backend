import { Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { roleAssignments, roles } from "../../db/schema";
import { bumpPermissionsVersion, type DbOrTx } from "./access-invalidate";
import { ORG_MEMBER_ROLES } from "./org-roles";

const logger = new Logger("StructuralRoleAssignment");

/**
 * Keeps `role_assignments` in step with a membership's structural role.
 *
 * `organization_members.role` is a label; it is NOT read by
 * `AccessService.computeUserPermissions`, which resolves permissions from
 * `role_assignments`, groups, module ownership and `user_permissions`. So a
 * membership created or updated with `ORG_ADMIN` and no matching assignment row
 * resolves to ZERO permissions — silently, with no error. Every path that
 * creates a membership or changes its role must call this.
 *
 * Only `ORG_ADMIN` is backed by a seeded role: `OWNER` bypasses permission
 * resolution entirely, and `MEMBER` intentionally carries no base grants
 * (module role groups provide them).
 */
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

  if (!adminRole) {
    if (role === ORG_MEMBER_ROLES.ORG_ADMIN) {
      logger.warn(
        "ORG_ADMIN role row missing for org; the member will resolve to zero permissions until system roles are seeded",
        { orgId, organizationMembershipId },
      );
    }
    return;
  }

  if (role === ORG_MEMBER_ROLES.ORG_ADMIN) {
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

  await bumpPermissionsVersion(tx, orgId);
}
