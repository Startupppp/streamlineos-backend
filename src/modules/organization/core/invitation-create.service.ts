import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { randomUUID, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { addDays } from "date-fns";
import { hashToken } from "../../../common/security/token.util";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import { assertMayGrantRole } from "../../../common/rbac/assert-may-grant-role";
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
import {
  findActorMembershipId,
  recordDeliveryFailure,
  requireActiveOrg,
  type InviteActor,
} from "./invitations.helpers";

interface InvitationMutationResult {
  success: true;
  invitationId: string;
  organizationName: string;
  resent: boolean;
}

@Injectable()
export class InvitationCreateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly email: EmailService,
    private readonly planLimits: PlanLimitsService,
    private readonly seatLedger: SeatLedgerService,
    private readonly access: AccessService,
  ) {}

  private readonly logger = new Logger(InvitationCreateService.name);

  async invite(
    orgId: string,
    actor: InviteActor,
    email: string,
    role: string,
  ): Promise<InvitationMutationResult> {
    await assertMayGrantRole(this.access, orgId, actor, role);
    return this.inviteAuthorized(orgId, actor.userId, email.trim().toLowerCase(), role);
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
          recordDeliveryFailure(this.db, this.logger, orgId, pendingInvitation.id, err),
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
        recordDeliveryFailure(this.db, this.logger, orgId, invitationId, err),
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
}
