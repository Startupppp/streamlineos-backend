import { BadRequestException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { organizationMembers } from "../../db/schema";
import type { DbOrTx } from "./access-invalidate";

const MESSAGE =
  "The organization owner's role cannot be changed. Use the ownership transfer flow instead.";

/**
 * Refuses a role change aimed at the org owner.
 *
 * `assertMayGrantRole` guards the role being handed out; this guards the person
 * receiving it. Without it an admin can demote the owner to MEMBER, which
 * detaches `isOwner` from `organizationMembers.role` and leaves the org with an
 * owner the UI no longer shows as one.
 */
export async function assertTargetNotOwner(
  db: DbOrTx,
  orgId: string,
  targetUserId: string,
): Promise<void> {
  const [member] = await db
    .select({ isOwner: organizationMembers.isOwner })
    .from(organizationMembers)
    .where(
      and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)),
    )
    .limit(1);

  if (member?.isOwner) throw new BadRequestException(MESSAGE);
}

export async function assertNoOwnerAmongTargets(
  db: DbOrTx,
  orgId: string,
  targetUserIds: string[],
): Promise<void> {
  if (targetUserIds.length === 0) return;

  const owners = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.isOwner, true),
        inArray(organizationMembers.userId, targetUserIds),
      ),
    )
    .limit(1);

  if (owners.length > 0) throw new BadRequestException(MESSAGE);
}
