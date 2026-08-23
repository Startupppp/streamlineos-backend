import { BadRequestException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { roleAssignments, roles } from "../../db/schema";
import type { DbOrTx } from "../../common/rbac/access-invalidate";

function moduleOwnerSlug(moduleKey: string): string {
  return `${moduleKey.toUpperCase()}_MODULE_OWNER`;
}

/** Returns false when the module's owner role is not seeded, so the caller decides the severity. */
export async function assignModuleOwnerRole(
  tx: DbOrTx,
  orgId: string,
  moduleKey: string,
  membershipId: number,
): Promise<boolean> {
  const slug = moduleOwnerSlug(moduleKey);
  const [role] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.slug, slug)))
    .limit(1);

  if (!role) return false;

  await tx
    .insert(roleAssignments)
    .values({
      orgId,
      organizationMembershipId: membershipId,
      roleId: role.id,
      assignedByMembershipId: null,
    })
    .onConflictDoNothing();
  return true;
}

export async function assertModuleOwnerRoleAssigned(
  tx: DbOrTx,
  orgId: string,
  moduleKey: string,
  membershipId: number,
): Promise<void> {
  if (!(await assignModuleOwnerRole(tx, orgId, moduleKey, membershipId)))
    throw new BadRequestException(
      `Role "${moduleKey.toUpperCase()}_MODULE_OWNER" is not seeded for this organisation; ownership transfer cannot complete`,
    );
}

export async function revokeModuleOwnerRole(
  tx: DbOrTx,
  orgId: string,
  moduleKey: string,
  membershipId: number,
): Promise<void> {
  const slug = moduleOwnerSlug(moduleKey);
  const [role] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.slug, slug)))
    .limit(1);

  if (!role)
    throw new BadRequestException(
      `Role "${slug}" is not seeded for this organisation; ownership transfer cannot complete`,
    );

  await tx
    .delete(roleAssignments)
    .where(
      and(
        eq(roleAssignments.orgId, orgId),
        eq(roleAssignments.roleId, role.id),
        eq(roleAssignments.organizationMembershipId, membershipId),
      ),
    );
}
