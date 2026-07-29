import { and, eq } from "drizzle-orm";
import { roleAssignments, roles } from "../../db/schema";
import type { DbOrTx } from "../../common/rbac/access-invalidate";
import { logger } from "../../common/logger/logger.service";

function moduleOwnerSlug(moduleKey: string): string {
  return `${moduleKey.toUpperCase()}_MODULE_OWNER`;
}

export async function assignModuleOwnerRole(
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

  if (!role) {
    logger.warn(`[module-owner-role] "${slug}" not seeded for org ${orgId}; skipping assignment`);
    return;
  }

  await tx
    .insert(roleAssignments)
    .values({
      orgId,
      organizationMembershipId: membershipId,
      roleId: role.id,
      assignedByMembershipId: null,
    })
    .onConflictDoNothing();
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

  if (!role) {
    return;
  }

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
