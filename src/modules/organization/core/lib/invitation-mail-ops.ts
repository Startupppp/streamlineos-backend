import { Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { addDays } from "date-fns";
import { hashToken } from "../../../../common/security/token.util";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { AccessService } from "../../../access/access.service";
import { assertMayManageOrganizationMembership } from "../../../../common/rbac/assert-may-grant-role";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { EmailService } from "../../../email/email.service";
import { SeatLedgerService } from "../../../billing/core/seat-ledger.service";
import { invitationEvents, invitations, users } from "../../../../db/schema";
import {
  findActorMembershipId,
  recordDeliveryFailure,
  requireActiveOrg,
  type InviteActor,
} from "../invitations.helpers";

/**
 * The invitation operation that SENDS MAIL.
 *
 * Split from `changeRole` and `revokeAllPending` on that line, because it is the
 * line that decides how each can fail. This one mints a token and then hands a
 * message to a provider that may be down — hence `recordDeliveryFailure` and the
 * `ServiceUnavailableException`, and hence a logger. The others change a row and
 * are finished.
 *
 * A deps bag and free functions rather than a second `@Injectable`, the
 * `so-ship.ts` shape: the DI graph and every caller stay unchanged.
 */
export interface InvitationMailDeps {
  readonly db: Db;
  readonly audit: AuditService;
  readonly cache: CacheService;
  readonly email: EmailService;
  readonly seatLedger: SeatLedgerService;
  readonly access: AccessService;
  readonly logger: Logger;
}

export async function resendInvitation(
  deps: InvitationMailDeps,
  orgId: string,
  invitationId: string,
  actor: InviteActor,
): Promise<{ success: true }> {
  const actorUserId = actor.userId;
  const org = await requireActiveOrg(deps.db, orgId);

  const invitation = await deps.db.query.invitations.findFirst({
    where: and(
      eq(invitations.id, invitationId),
      eq(invitations.orgId, orgId),
      eq(invitations.status, "PENDING"),
      isNull(invitations.acceptedAt),
    ),
  });
  if (!invitation)
    throw new NotFoundException("Invitation not found or already accepted");

  await assertMayManageOrganizationMembership(deps.access, orgId, actor);

  const rawToken = randomBytes(32).toString("hex");
  const newExpiresAt = addDays(new Date(), 7);

  const actorMembership = await findActorMembershipId(deps.db, orgId, actorUserId);

  await runInTenantTransaction(
    deps.db,
    async (tx) => {
      const updated = await tx
        .update(invitations)
        .set({
          tokenHash: hashToken(rawToken),
          expiresAt: newExpiresAt,
          status: "PENDING",
          revokedAt: null,
          revokedByMembershipId: null,
          declinedAt: null,
        })
        .where(
          and(
            eq(invitations.id, invitationId),
            eq(invitations.orgId, orgId),
            eq(invitations.status, invitation.status),
            isNull(invitations.acceptedAt),
          ),
        )
        .returning({ id: invitations.id });
      if (updated.length === 0) {
        throw new NotFoundException("Invitation not found or already accepted");
      }
      await tx.insert(invitationEvents).values({
        orgId,
        invitationId,
        event: "RESENT",
        actorMembershipId: actorMembership?.id ?? null,
      });
    },
    { orgId },
  );

  const inviter = await deps.db.query.users.findFirst({
    where: eq(users.id, actorUserId),
    columns: { name: true, firstName: true, lastName: true },
  });

  const inviterName =
    inviter?.firstName && inviter?.lastName
      ? `${inviter.firstName} ${inviter.lastName}`
      : (inviter?.name ?? undefined);

  try {
    await deps.email.sendInvitationEmail(
      invitation.email,
      rawToken,
      org.name,
      inviterName,
    );
  } catch (error: unknown) {
    await recordDeliveryFailure(deps.db, deps.logger, orgId, invitationId, error);
    throw new ServiceUnavailableException(
      "Invitation email could not be sent. Please try again.",
    );
  }

  deps.audit.log({
    action: "user.invitation.resent",
    userId: actorUserId,
    orgId,
    targetId: invitationId,
    targetType: "invitation",
    metadata: { email: invitation.email },
  });

  await deps.cache.invalidateForOrg(orgId, "users:stats");
  return { success: true };
}
