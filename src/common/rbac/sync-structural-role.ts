import { Logger } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { roleAssignments, roles } from "../../db/schema";
import { bumpPermissionsVersion, type DbOrTx } from "./access-invalidate";
import { ORG_MEMBER_ROLES } from "./org-roles";

const logger = new Logger("StructuralRoleAssignment");

const STRUCTURAL_ROLE_SLUGS = [ORG_MEMBER_ROLES.ORG_ADMIN, ORG_MEMBER_ROLES.MEMBER];

/** Keeps `role_assignments` in step with a membership's structural role. */
export function syncStructuralRoleAssignment(
  tx: DbOrTx,
  orgId: string,
  organizationMembershipId: number,
  role: string,
): Promise<void> {
  return syncStructuralRoleAssignments(tx, orgId, [organizationMembershipId], role);
}

/** The same sync for many memberships that share one role — four statements for any count. */
export async function syncStructuralRoleAssignments(
  tx: DbOrTx,
  orgId: string,
  organizationMembershipIds: readonly number[],
  role: string,
): Promise<void> {
  const membershipIds = [...new Set(organizationMembershipIds)];
  if (membershipIds.length === 0) return;

  const structuralRoles = await tx
    .select({ id: roles.id, slug: roles.slug })
    .from(roles)
    .where(and(eq(roles.orgId, orgId), inArray(roles.slug, STRUCTURAL_ROLE_SLUGS)))
    .limit(STRUCTURAL_ROLE_SLUGS.length);

  const adminRoleId = structuralRoles.find(
    (row) => row.slug === ORG_MEMBER_ROLES.ORG_ADMIN,
  )?.id;
  const memberRoleId = structuralRoles.find(
    (row) => row.slug === ORG_MEMBER_ROLES.MEMBER,
  )?.id;

  if (adminRoleId === undefined && memberRoleId === undefined) {
    if (role === ORG_MEMBER_ROLES.ORG_ADMIN || role === ORG_MEMBER_ROLES.MEMBER)
      logger.warn(
        "Structural role rows missing for org; the member will resolve to zero permissions until system roles are seeded",
        { orgId, organizationMembershipIds: membershipIds, role },
      );
    return;
  }

  const grantRoleId =
    role === ORG_MEMBER_ROLES.ORG_ADMIN
      ? adminRoleId
      : role === ORG_MEMBER_ROLES.MEMBER
        ? memberRoleId
        : undefined;

  if (grantRoleId === undefined) {
    if (role === ORG_MEMBER_ROLES.ORG_ADMIN)
      logger.warn(
        "ORG_ADMIN role row missing for org; the member will resolve to limited permissions until system roles are seeded",
        { orgId, organizationMembershipIds: membershipIds },
      );
    else if (role === ORG_MEMBER_ROLES.MEMBER)
      logger.warn(
        "MEMBER role row missing for org; the member will resolve to zero permissions until system roles are seeded",
        { orgId, organizationMembershipIds: membershipIds },
      );
  }

  const revokeRoleIds = [adminRoleId, memberRoleId].filter(
    (roleId): roleId is number => roleId !== undefined && roleId !== grantRoleId,
  );

  if (grantRoleId !== undefined)
    await tx
      .insert(roleAssignments)
      .values(
        membershipIds.map((organizationMembershipId) => ({
          orgId,
          organizationMembershipId,
          roleId: grantRoleId,
          assignedByMembershipId: null,
        })),
      )
      .onConflictDoNothing();

  if (revokeRoleIds.length > 0)
    await tx
      .delete(roleAssignments)
      .where(
        and(
          eq(roleAssignments.orgId, orgId),
          inArray(roleAssignments.organizationMembershipId, membershipIds),
          inArray(roleAssignments.roleId, revokeRoleIds),
        ),
      );

  await bumpPermissionsVersion(tx, orgId);
}
