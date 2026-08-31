import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
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
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import {
  invitationEvents,
  invitations,
  organizationAllowedEmailDomains,
  organizationMembers,
  users,
} from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import {
  findActorMembershipId,
  openAdminInvitationFilter,
  requireActiveOrg,
} from "./invitations.helpers";

export interface InviteActor {
  userId: string;
  isOrgOwner: boolean;
}

interface InvitationMutationResult {
  success: true;
  invitationId: string;
  organizationName: string;
  resent: boolean;
}

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly email: EmailService,
    private readonly planLimits: PlanLimitsService,
    private readonly seatLedger: SeatLedgerService,
    private readonly access: AccessService,
  ) {}

  private readonly logger = new Logger(InvitationsService.name);

  private async recordDeliveryFailure(
    orgId: string,
    invitationId: string,
    err: unknown,
  ): Promise<void> {
    this.logger.error(
      `Invitation email delivery failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    try {
      await runInTenantTransaction(
        this.db,
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
      this.logger.error(
        `Failed to record invitation delivery failure: ${recordErr instanceof Error ? recordErr.message : String(recordErr)}`,
      );
    }
  }

  async invite(
    orgId: string,
    actor: InviteActor,
    email: string,
    role: string,
  ): Promise<InvitationMutationResult> {
    await assertMayGrantRole(this.access, orgId, actor, role);
    return this.inviteAuthorized(orgId, actor.userId, email.trim().toLowerCase(), role);
  }

  private async inviteAuthorized(
    orgId: string,
    actorUserId: string,
    email: string,
    role: string,
  ): Promise<InvitationMutationResult> {
    const org = await requireActiveOrg(this.db, orgId);

    const existingUser = await this.db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true },
    });

    if (existingUser) {
      const existingMember = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.userId, existingUser.id),
          eq(organizationMembers.orgId, orgId),
        ),
        columns: { status: true },
      });
      if (existingMember) {
        if (
          existingMember.status === "SUSPENDED" ||
          existingMember.status === "LEFT"
        ) {
          throw new ConflictException(
            "This person was archived/suspended in this organization. Restore them from Users instead of inviting again.",
          );
        }
        throw new ConflictException("User is already a member");
      }
    }

    const allowedDomainRows = await this.db
      .select({ domain: organizationAllowedEmailDomains.domain })
      .from(organizationAllowedEmailDomains)
      .where(eq(organizationAllowedEmailDomains.orgId, orgId));

    if (allowedDomainRows.length > 0) {
      const emailDomain = email.split("@")[1]?.toLowerCase();
      const allowed = allowedDomainRows.map((r) => r.domain);
      if (!emailDomain || !allowed.includes(emailDomain)) {
        throw new BadRequestException(
          `Email domain not allowed. Permitted: ${allowed.join(", ")}`,
        );
      }
    }

    const now = new Date();
    const actorMembership = await findActorMembershipId(this.db, orgId, actorUserId);

    const pendingResult = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const pending = await tx
          .select()
          .from(invitations)
          .where(
            and(
              eq(invitations.email, email),
              eq(invitations.orgId, orgId),
              eq(invitations.status, "PENDING"),
              gt(invitations.expiresAt, now),
              isNull(invitations.acceptedAt),
            ),
          )
          .for("update")
          .limit(1);
        const pendingInvitation = pending[0];
        if (!pendingInvitation) return null;

        const rawToken = randomBytes(32).toString("hex");
        const newExpiresAt = addDays(now, 7);

        await tx
          .update(invitations)
          .set({
            tokenHash: hashToken(rawToken),
            expiresAt: newExpiresAt,
            role,
            invitedBy: actorUserId,
            inviterMembershipId: actorMembership?.id ?? null,
            status: "PENDING",
            revokedAt: null,
            revokedByMembershipId: null,
            declinedAt: null,
          })
          .where(eq(invitations.id, pendingInvitation.id));

        await tx.insert(invitationEvents).values({
          orgId,
          invitationId: pendingInvitation.id,
          event: "RESENT",
          actorMembershipId: null,
        });

        return { pendingInvitation, rawToken };
      },
      { orgId },
    );

    if (pendingResult) {
      const { pendingInvitation, rawToken } = pendingResult;
      void this.email
        .sendInvitationEmail(email, rawToken, org.name)
        .catch((err: unknown) =>
          this.recordDeliveryFailure(orgId, pendingInvitation.id, err),
        );

      this.audit.log({
        action: "user.invitation.resent",
        userId: actorUserId,
        orgId,
        targetId: pendingInvitation.id,
        targetType: "invitation",
        metadata: { email, role },
      });

      await this.cache.invalidateForOrg(orgId, "users:stats");
      return {
        success: true,
        invitationId: pendingInvitation.id,
        organizationName: org.name,
        resent: true,
      };
    }

    const invitationId = randomUUID();
    const rawToken = randomBytes(32).toString("hex");
    const expiresAt = addDays(now, 7);

    try {
      await runInTenantTransaction(
        this.db,
        async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${orgId}:members`}, 0))`,
          );
          await this.planLimits.assertWithinLimit(orgId, "members", 1, tx);
          await tx
            .update(invitations)
            .set({ status: "EXPIRED" })
            .where(
              and(
                eq(invitations.email, email),
                eq(invitations.orgId, orgId),
                eq(invitations.status, "PENDING"),
                lte(invitations.expiresAt, now),
                isNull(invitations.acceptedAt),
              ),
            );

          await tx.insert(invitations).values({
            id: invitationId,
            email,
            tokenHash: hashToken(rawToken),
            orgId,
            role,
            invitedBy: actorUserId,
            inviterMembershipId: actorMembership?.id ?? null,
            expiresAt,
          });

          await tx.insert(invitationEvents).values({
            orgId,
            invitationId,
            event: "CREATED",
            actorMembershipId: actorMembership?.id ?? null,
          });

          await this.seatLedger.recordSeatEvent(
            {
              orgId,
              eventType: "INVITE_SENT",
              subjectId: invitationId,
              actorId: actorUserId,
              reason: "invitation sent",
              idempotencyKey: `invite-sent:${invitationId}`,
            },
            tx,
          );
        },
        { orgId },
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505") {
        throw new ConflictException(
          "An invitation is already pending for this email",
        );
      }
      throw err;
    }

    void this.email
      .sendInvitationEmail(email, rawToken, org.name)
      .catch((err: unknown) =>
        this.recordDeliveryFailure(orgId, invitationId, err),
      );

    this.audit.log({
      action: "user.invited",
      userId: actorUserId,
      orgId,
      targetId: invitationId,
      targetType: "invitation",
      metadata: { email, role },
    });

    await this.cache.invalidateForOrg(orgId, "users:stats");
    return {
      success: true,
      invitationId,
      organizationName: org.name,
      resent: false,
    };
  }

  async bulkInvite(
    orgId: string,
    actor: InviteActor,
    emails: string[],
    role: string,
  ): Promise<{
    results: Array<{
      email: string;
      success: boolean;
      invitationId?: string;
      error?: string;
    }>;
  }> {
    await assertMayGrantRole(this.access, orgId, actor, role);

    const results: Array<{
      email: string;
      success: boolean;
      invitationId?: string;
      error?: string;
    }> = [];

    for (const email of emails) {
      const canonicalEmail = email.trim().toLowerCase();
      try {
        const result = await this.inviteAuthorized(
          orgId,
          actor.userId,
          canonicalEmail,
          role,
        );
        results.push({
          email: canonicalEmail,
          success: true,
          invitationId: result.invitationId,
        });
      } catch (err) {
        results.push({
          email: canonicalEmail,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    return { results };
  }

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
      await this.recordDeliveryFailure(orgId, invitationId, error);
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
