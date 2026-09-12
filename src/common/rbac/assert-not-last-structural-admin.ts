import { ForbiddenException } from "@nestjs/common";
import { and, eq, or } from "drizzle-orm";
import { organizationMembers } from "../../db/schema";
import type { DbOrTx } from "./access-invalidate";
import { ORG_MEMBER_ROLES } from "./org-roles";

/**
 * Structural authority lives on the membership row, so demoting the last
 * ORG_ADMIN of an owner-less organisation is the one operation that can leave
 * it with nobody able to administer it.
 */
export async function assertNotLastStructuralAdmin(
  tx: DbOrTx,
  orgId: string,
  membershipId: number,
  currentRole: string,
  nextRole: string,
): Promise<void> {
  if (currentRole !== ORG_MEMBER_ROLES.ORG_ADMIN) return;
  if (nextRole === ORG_MEMBER_ROLES.ORG_ADMIN) return;

  const adminRows = await tx
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.status, "ACTIVE"),
        or(
          eq(organizationMembers.isOwner, true),
          eq(organizationMembers.role, ORG_MEMBER_ROLES.ORG_ADMIN),
        ),
      ),
    )
    .orderBy(organizationMembers.id)
    .for("update");

  const remaining = adminRows.filter((row) => row.id !== membershipId).length;

  if (remaining === 0)
    throw new ForbiddenException(
      "This is the organization's last administrator; appoint another before changing this role",
    );
}
