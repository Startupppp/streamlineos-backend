import { ForbiddenException } from "@nestjs/common";
import { and, eq, ne, or, sql } from "drizzle-orm";
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

  const [remaining] = await tx
    .select({ value: sql<number>`count(*)` })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.status, "ACTIVE"),
        ne(organizationMembers.id, membershipId),
        or(
          eq(organizationMembers.isOwner, true),
          eq(organizationMembers.role, ORG_MEMBER_ROLES.ORG_ADMIN),
        ),
      ),
    );

  if (Number(remaining?.value ?? 0) === 0)
    throw new ForbiddenException(
      "This is the organization's last administrator; appoint another before changing this role",
    );
}
