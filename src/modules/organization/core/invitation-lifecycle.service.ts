import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { addDays } from "date-fns";
import { hashToken } from "../../../common/security/token.util";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import {
  assertMayGrantRole,
  assertMayManageOrganizationMembership,
} from "../../../common/rbac/assert-may-grant-role";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { EmailService } from "../../email/email.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import {
  invitationEvents,
  invitations,
  users,
} from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import {
  findActorMembershipId,
  openAdminInvitationFilter,
  recordDeliveryFailure,
  requireActiveOrg,
  type InviteActor,
} from "./invitations.helpers";

@Injectable()
export class InvitationLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly email: EmailService,
    private readonly seatLedger: SeatLedgerService,
    private readonly access: AccessService,
  ) {}

  private readonly logger = new Logger(InvitationLifecycleService.name);

  async resend(
    orgId: string,
    invitationId: string,
    actor: InviteActor,
  ): Promise<{ success: true }> {
    const actorUserId = actor.userId;
    const org = await requireActiveOrg(this.db, orgId);

    const invitation = await this.db.query.invitations.findFirst({
      where: and(
        eq(invitations.id, invitationId),
        eq(invitations.orgId, orgId),
        eq(invitations.status, "PENDING"),
        isNull(invitations.acceptedAt),
      ),
    });
    if (!invitation)
      throw new NotFoundException("Invitation not found or already accepted");

    await assertMayManageOrganizationMembership(this.access, orgId, actor);

    const rawToken = randomBytes(32).toString("hex");
    const newExpiresAt = addDays(new Date(), 7);

    const actorMembership = await findActorMembershipId(this.db, orgId, actorUserId);

    await runInTenantTransaction(
      this.db,
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

    const inviter = await this.db.query.users.findFirst({
      where: eq(users.id, actorUserId),
      columns: { name: true, firstName: true, lastName: true },
    });

    const inviterName =
      inviter?.firstName && inviter?.lastName
        ? `${inviter.firstName} ${inviter.lastName}`
        : (inviter?.name ?? undefined);

    try {
      await this.email.sendInvitationEmail(
        invitation.email,
        rawToken,
        org.name,
        inviterName,
      );
    } catch (error: unknown) {
      await recordDeliveryFailure(this.db, this.logger, orgId, invitationId, error);
      throw new ServiceUnavailableException(
        "Invitation email could not be sent. Please try again.",
      );
    }

    this.audit.log({
      action: "user.invitation.resent",
      userId: actorUserId,
      orgId,
      targetId: invitationId,
      targetType: "invitation",
      metadata: { email: invitation.email },
    });

    await this.cache.invalidateForOrg(orgId, "users:stats");
    return { success: true };
  }

  async changeRole(
    orgId: string,
    invitationId: string,
    actor: InviteActor,
    role: string,
  ): Promise<{ success: true }> {
    const invitation = await this.db.query.invitations.findFirst({
      where: openAdminInvitationFilter(invitationId, orgId),
    });
    if (!invitation)
      throw new NotFoundException("Invitation not found or already accepted");

    await assertMayGrantRole(this.access, orgId, actor, role);
    if (invitation.role === role) return { success: true };

    const actorMembership = await findActorMembershipId(this.db, orgId, actor.userId);

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const updated = await tx
          .update(invitations)
          .set({ role })
          .where(
            and(
              openAdminInvitationFilter(invitationId, orgId),
              eq(invitations.role, invitation.role),
            ),
          )
          .returning({ id: invitations.id });
        if (updated.length === 0)
          throw new NotFoundException("Invitation not found or already accepted");

        await tx.insert(invitationEvents).values({
          orgId,
          invitationId,
          event: "ROLE_CHANGED",
          actorMembershipId: actorMembership?.id ?? null,
        });
      },
      { orgId },
    );

    this.audit.log({
      action: "user.invitation.role_changed",
      userId: actor.userId,
      orgId,
      targetId: invitationId,
      targetType: "invitation",
      metadata: { from: invitation.role, to: role },
    });

    return { success: true };
  }

  async cancel(
    orgId: string,
    invitationId: string,
    actor: InviteActor,
  ): Promise<{ success: true }> {
    const actorUserId = actor.userId;
    const invitation = await this.db.query.invitations.findFirst({
      where: openAdminInvitationFilter(invitationId, orgId),
    });
    if (!invitation)
      throw new NotFoundException("Invitation not found or already accepted");

    await assertMayManageOrganizationMembership(this.access, orgId, actor);

    const org = await requireActiveOrg(this.db, orgId);
    const actorMembership = await findActorMembershipId(this.db, orgId, actorUserId);

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const updated = await tx
          .update(invitations)
          .set({
            status: "REVOKED",
            revokedAt: new Date(),
            revokedByMembershipId: actorMembership?.id ?? null,
          })
          .where(openAdminInvitationFilter(invitationId, orgId))
          .returning({ id: invitations.id });
        if (updated.length === 0)
          throw new NotFoundException("Invitation not found or already accepted");

        await tx.insert(invitationEvents).values({
          orgId,
          invitationId,
          event: "REVOKED",
          actorMembershipId: actorMembership?.id ?? null,
        });

        await this.seatLedger.recordSeatEvent(
          {
            orgId,
            eventType: "INVITE_CANCELLED",
            subjectId: invitationId,
            actorId: actorUserId,
            reason: "invitation cancelled",
            idempotencyKey: `invite-cancelled:${invitationId}`,
          },
          tx,
        );
      },
      { orgId },
    );

    this.audit.log({
      action: "user.invitation.cancelled",
      userId: actorUserId,
      orgId,
      targetId: invitationId,
      targetType: "invitation",
      metadata: { email: invitation.email },
    });

    void this.email
      .sendInvitationRevokedEmail(invitation.email, org.name)
      .catch((err: unknown) =>
        this.logger.warn(
          `Invitation revocation notice not delivered to ${invitation.email}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );

    await this.cache.invalidateForOrg(orgId, "users:stats");
    return { success: true };
  }

  async revokeAllPending(orgId: string, existingTx?: DbOrTx): Promise<number> {
    const now = new Date();
    const revoke = async (tx: DbOrTx) => {
      const rows = await tx
        .update(invitations)
        .set({
          status: "REVOKED",
          revokedAt: now,
          revokedByMembershipId: null,
        })
        .where(
          and(
            eq(invitations.orgId, orgId),
            eq(invitations.status, "PENDING"),
            isNull(invitations.acceptedAt),
          ),
        )
        .returning({ id: invitations.id });
      if (rows.length > 0) {
        await tx.insert(invitationEvents).values(
          rows.map((r) => ({
            orgId,
            invitationId: r.id,
            event: "REVOKED" as const,
            actorMembershipId: null,
          })),
        );
      }
      return rows;
    };
    const updated = existingTx
      ? await revoke(existingTx)
      : await runInTenantTransaction(this.db, revoke, { orgId });
    if (!existingTx && updated.length > 0)
      await this.cache.invalidateForOrg(orgId, "users:stats");

    return updated.length;
  }
}
