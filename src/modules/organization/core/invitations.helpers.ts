import { BadRequestException, ConflictException, Logger } from "@nestjs/common";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { invitationEvents, invitations, organizationMembers, organizations } from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { Db } from "../../../db/drizzle.module";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

export interface InviteActor {
  userId: string;
  isOrgOwner: boolean;
}

export function openAdminInvitationFilter(invitationId: string, orgId: string) {
  return and(
    eq(invitations.id, invitationId),
    eq(invitations.orgId, orgId),
    eq(invitations.status, "PENDING"),
    isNull(invitations.acceptedAt),
  );
}

export function expiredByTimePredicate(now: Date) {
  return and(
    eq(invitations.status, "PENDING"),
    isNull(invitations.acceptedAt),
    lt(invitations.expiresAt, now),
  );
}

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

export async function recordDeliveryFailure(
  db: Db,
  logger: Logger,
  orgId: string,
  invitationId: string,
  err: unknown,
): Promise<void> {
  logger.error(
    `Invitation email delivery failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  try {
    await runInTenantTransaction(
      db,
      (tx) =>
        tx.insert(invitationEvents).values({
          orgId,
          invitationId,
          event: "DELIVERY_FAILED",
          actorMembershipId: null,
        }),
      { orgId },
    );
  } catch (recordErr: unknown) {
    logger.error(
      `Failed to record invitation delivery failure: ${recordErr instanceof Error ? recordErr.message : String(recordErr)}`,
    );
  }
}

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
