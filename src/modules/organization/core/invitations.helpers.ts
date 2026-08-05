import { BadRequestException, ConflictException } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import { invitations, organizationMembers, organizations } from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { Db } from "../../../db/drizzle.module";

export function findActorMembershipId(
  db: Db,
  orgId: string,
  actorUserId: string,
) {
  return db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.orgId, orgId),
      eq(organizationMembers.userId, actorUserId),
    ),
    columns: { id: true },
  });
}

export async function requireActiveOrg(
  db: DbOrTx,
  orgId: string,
): Promise<{ name: string }> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, orgId),
    columns: { name: true, status: true, deletedAt: true },
  });
  if (!org || org.status !== "ACTIVE" || org.deletedAt !== null) {
    throw new BadRequestException(
      "This organization is archived or unavailable. Restore it before inviting or accepting members.",
    );
  }
  return { name: org.name };
}

/**
 * Row-locks a still-pending invitation. Every terminal transition must go
 * through this or a status-predicated conditional update — an id-only update
 * would revive an accepted or revoked invitation.
 */
export async function lockPendingInvitation(
  tx: DbOrTx,
  invitationId: string,
  tokenHash: string,
) {
  const [invitation] = await tx
    .select({
      id: invitations.id,
      orgId: invitations.orgId,
      email: invitations.email,
      role: invitations.role,
      invitedBy: invitations.invitedBy,
    })
    .from(invitations)
    .where(
      and(
        eq(invitations.id, invitationId),
        eq(invitations.tokenHash, tokenHash),
        eq(invitations.status, "PENDING"),
        gt(invitations.expiresAt, new Date()),
        isNull(invitations.acceptedAt),
      ),
    )
    .for("update")
    .limit(1);
  if (!invitation) {
    throw new ConflictException("Invitation has already been accepted");
  }
  return invitation;
}
