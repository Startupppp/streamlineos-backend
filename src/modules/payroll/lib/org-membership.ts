import { ForbiddenException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { organizationMembers } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";

/**
 * Ensures the target user is a member of the organization.
 * Throws ForbiddenException when membership is missing (BOLA guard).
 */
export async function assertOrgMember(
  db: Db,
  orgId: string,
  userId: string,
  message = "Employee is not a member of this organization",
): Promise<void> {
  const membership = await db.query.organizationMembers.findFirst({
    where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)),
    columns: { id: true },
  });
  if (!membership) throw new ForbiddenException(message);
}
