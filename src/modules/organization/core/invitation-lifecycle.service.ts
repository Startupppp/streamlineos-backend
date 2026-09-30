import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { addDays } from "date-fns";
import { hashToken } from "../../../common/security/token.util";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { registerAfterCommit } from "../../../common/tenant";
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
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import { lockMembersQuota } from "../../billing/core/seat-definition";
import {
  invitationEvents,
  invitationModuleAccess,
  invitations,
  users,
} from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { assertMayAssignRole } from "../../rbac/assert-role-assignment";
import { resolveModuleStandingRole } from "../../rbac/resolve-module-standing-role";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
  findActorMembershipId,
  invitationTransition,
  openAdminInvitationFilter,
  recordDeliveryFailure,
  requireActiveOrg,
  type InviteActor,
} from "./invitations.helpers";

export interface ReissuedInvitation {
  success: true;
  rawToken: string;
  email: string;
  expiresAt: Date;
}

@Injectable()
export class InvitationLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly email: EmailService,
    private readonly planLimits: PlanLimitsService,
    private readonly seatLedger: SeatLedgerService,
    private readonly access: AccessService,
  ) {}

  private readonly logger = new Logger(InvitationLifecycleService.name);

  async resend(
    orgId: string,
    invitationId: string,
    actor: InviteActor,
    options?: { deliverEmail?: boolean },
  ): Promise<ReissuedInvitation> {
    const deliverEmail = options?.deliverEmail ?? true;
    const actorUserId = actor.userId;
    const org = await requireActiveOrg(this.db, orgId);

    const invitation = await this.db.query.invitations.findFirst({
      where: openAdminInvitationFilter(invitationId, orgId),
    });
    if (!invitation)
      throw new NotFoundException("Invitation not found or already accepted");

    await assertMayManageOrganizationMembership(this.access, orgId, actor);

    const attachedAccess = await this.db
      .select({ moduleKey: invitationModuleAccess.moduleKey, standing: invitationModuleAccess.standing })
      .from(invitationModuleAccess)
      .where(eq(invitationModuleAccess.invitationId, invitationId))
      .limit(10);

    if (attachedAccess.length > 0) {
      const actorCtx: CurrentUserContext = {
        userId: actor.userId,
        orgId,
        isOrgOwner: actor.isOrgOwner,
        role: "MEMBER",
        sessionId: "",
        tokenScopes: null,
        principal: humanSessionPrincipal(0, actor.isOrgOwner),
      };
      for (const row of attachedAccess) {
        const resolved = await resolveModuleStandingRole(this.db, orgId, row.moduleKey, row.standing);
        if (resolved) {
          await assertMayAssignRole(this.db, this.access, actorCtx, resolved);
        }
      }
    }

    const rawToken = randomBytes(32).toString("hex");
    const newExpiresAt = addDays(new Date(), 7);

    const actorMembership = await findActorMembershipId(this.db, orgId, actorUserId);

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx.execute(lockMembersQuota(orgId));

        const [current] = await tx
          .select({
            id: invitations.id,
            status: invitations.status,
            expiresAt: invitations.expiresAt,
          })
          .from(invitations)
          .where(openAdminInvitationFilter(invitationId, orgId))
          .for("update")
          .limit(1);

        if (!current) {
          throw new NotFoundException("Invitation not found or already accepted");
        }

        const wasTimeExpired = current.expiresAt <= new Date();
        if (wasTimeExpired) {
          try {
            await this.planLimits.assertWithinLimit(orgId, "members", 1, tx);
          } catch (err) {
            if (err instanceof ForbiddenException) {
              throw new ForbiddenException(
                "This organization is at its member limit. Free a seat before resending to a time-expired invitation.",
              );
            }
            throw err;
          }
        }

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
              eq(invitations.status, current.status),
              eq(invitations.expiresAt, invitation.expiresAt),
              isNull(invitations.acceptedAt),
            ),
          )
          .returning({ id: invitations.id });
        if (updated.length === 0) {
          throw new NotFoundException("Invitation not found or already accepted");
        }

        if (wasTimeExpired) {
          await this.seatLedger.recordSeatEvent(
            {
              orgId,
              eventType: "INVITE_SENT",
              subjectId: invitationId,
              actorId: actorUserId,
              reason: "invitation resent after expiry",
              idempotencyKey: `invite-resent-seat:${invitationId}:${newExpiresAt.getTime()}`,
            },
            tx,
          );
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

    const sendRenewedInvitation = async (): Promise<void> => {
      try {
        await this.email.sendInvitationEmail(
          invitation.email,
          rawToken,
          org.name,
          inviterName,
        );
      } catch (error: unknown) {
        await recordDeliveryFailure(this.db, this.logger, orgId, invitationId, error);
      }
    };

    if (deliverEmail) {
      const registered = registerAfterCommit(sendRenewedInvitation);
      if (!registered) await sendRenewedInvitation();
    }

    this.audit.log({
      action: deliverEmail
        ? "user.invitation.resent"
        : "user.invitation.link-reissued",
      userId: actorUserId,
      orgId,
      targetId: invitationId,
      targetType: "invitation",
      metadata: { email: invitation.email },
    });

    await this.cache.invalidateForOrg(orgId, "users:stats");
    return {
      success: true,
      rawToken,
      email: invitation.email,
      expiresAt: newExpiresAt,
    };
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
        const revoked = await invitationTransition(tx, {
          invitationId,
          orgId,
          from: "PENDING",
          to: "REVOKED",
          patch: { revokedAt: new Date(), revokedByMembershipId: actorMembership?.id ?? null },
        });
        if (!revoked)
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
        await this.seatLedger.recordSeatEvents(
          tx,
          orgId,
          rows.map((r) => ({
            eventType: "INVITE_CANCELLED" as const,
            subjectId: r.id,
            reason: "pending invitations revoked in bulk",
            idempotencyKey: `invite-cancelled:${r.id}`,
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
