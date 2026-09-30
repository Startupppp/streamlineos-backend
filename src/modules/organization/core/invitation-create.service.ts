import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { randomUUID, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { addDays } from "date-fns";
import { hashToken } from "../../../common/security/token.util";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { registerAfterCommit } from "../../../common/tenant";
import { runInConsumerSavepoint } from "../../../common/outbox/consumer-savepoint";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import { assertMayGrantRole } from "../../../common/rbac/assert-may-grant-role";
import { assertMayAssignRole } from "../../rbac/assert-role-assignment";
import { type Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { EmailService } from "../../email/email.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import { lockMembersQuota } from "../../billing/core/seat-definition";
import { invitationEvents, invitationModuleAccess, invitations } from "../../../db/schema";
import {
  findActorMembershipId,
  recordDeliveryFailure,
  requireActiveOrg,
  type InviteActor,
} from "./invitations.helpers";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import {
  MembershipAdmissionService,
  admissionFailure,
  canonicalAdmissionEmail,
} from "./membership-admission.service";
import {
  resolveModuleStandingRole,
  validateModuleKeyAndStanding,
  type ModuleStanding,
} from "../../rbac/resolve-module-standing-role";

interface InvitationMutationResult {
  success: true;
  invitationId: string;
  organizationName: string;
  resent: boolean;
}

type InvitationDelivery = "background" | "enqueue";

interface BulkInviteRowResult {
  email: string;
  originalEmail: string;
  success: boolean;
  invitationId?: string;
  isDuplicate?: boolean;
  error?: string;
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
    private readonly admission: MembershipAdmissionService,
  ) {}

  private readonly logger = new Logger(InvitationCreateService.name);

  async invite(
    orgId: string,
    actor: InviteActor,
    email: string,
    role: string,
    moduleAccess?: Array<{ moduleKey: string; standing: ModuleStanding }>,
  ): Promise<InvitationMutationResult> {
    await assertMayGrantRole(this.access, orgId, actor, role);
    const validatedAccess = await this.validateModuleAccess(orgId, actor, moduleAccess);
    return this.inviteAuthorized(orgId, actor.userId, email.trim().toLowerCase(), role, validatedAccess);
  }

  async bulkInvite(
    orgId: string,
    actor: InviteActor,
    emails: string[],
    role: string,
    delivery: InvitationDelivery = "background",
  ): Promise<{
    deliveryMode: InvitationDelivery;
    results: BulkInviteRowResult[];
  }> {
    await assertMayGrantRole(this.access, orgId, actor, role);

    const results: BulkInviteRowResult[] = [];
    const seenCanonical = new Map<string, number>();

    for (let i = 0; i < emails.length; i++) {
      const originalEmail = emails[i] ?? "";
      const canonicalEmail = canonicalAdmissionEmail(originalEmail);

      if (seenCanonical.has(canonicalEmail)) {
        results.push({
          email: canonicalEmail,
          originalEmail,
          success: false,
          isDuplicate: true,
          error: "Duplicate email in batch",
        });
        continue;
      }

      seenCanonical.set(canonicalEmail, i);

      try {
        const result = await runInConsumerSavepoint(() =>
          this.inviteAuthorized(orgId, actor.userId, canonicalEmail, role, [], delivery),
        );
        results.push({
          email: canonicalEmail,
          originalEmail,
          success: true,
          invitationId: result.invitationId,
        });
      } catch (err) {
        results.push({
          email: canonicalEmail,
          originalEmail,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    return { deliveryMode: delivery, results };
  }

  private async inviteAuthorized(
    orgId: string,
    actorUserId: string,
    email: string,
    role: string,
    moduleAccessRows: Array<{ moduleKey: string; standing: ModuleStanding }> = [],
    delivery: InvitationDelivery = "background",
  ): Promise<InvitationMutationResult> {
    const org = await requireActiveOrg(this.db, orgId);

    const screen = await this.admission.screen(this.db, { orgId, email });
    if (screen.kind !== "clear") throw admissionFailure(screen);

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

        await tx.delete(invitationModuleAccess).where(eq(invitationModuleAccess.invitationId, pendingInvitation.id));

        if (moduleAccessRows.length > 0) {
          await tx.insert(invitationModuleAccess).values(
            moduleAccessRows.map((row) => ({
              orgId,
              invitationId: pendingInvitation.id,
              moduleKey: row.moduleKey,
              standing: row.standing,
            })),
          );
        }

        return { pendingInvitation, rawToken };
      },
      { orgId },
    );

    if (pendingResult) {
      const { pendingInvitation, rawToken } = pendingResult;
      await this.deliverInvitation(
        delivery,
        orgId,
        pendingInvitation.id,
        email,
        rawToken,
        org.name,
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
          await tx.execute(lockMembersQuota(orgId));
          await this.planLimits.assertWithinLimit(orgId, "members", 1, tx);
          const expiredRows = await tx
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
            )
            .returning({ id: invitations.id });

          for (const expired of expiredRows) {
            await this.seatLedger.recordSeatEvent(
              {
                orgId,
                eventType: "INVITE_EXPIRED",
                subjectId: expired.id,
                actorId: actorUserId,
                reason: "invitation expired before re-invite",
                idempotencyKey: `invite-expired:${expired.id}`,
              },
              tx,
            );
          }

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

          if (moduleAccessRows.length > 0) {
            await tx.insert(invitationModuleAccess).values(
              moduleAccessRows.map((row) => ({
                orgId,
                invitationId,
                moduleKey: row.moduleKey,
                standing: row.standing,
              })),
            );
          }

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
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          "An invitation is already pending for this email",
        );
      }
      throw err;
    }

    await this.deliverInvitation(
      delivery,
      orgId,
      invitationId,
      email,
      rawToken,
      org.name,
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

  private async validateModuleAccess(
    orgId: string,
    actor: InviteActor,
    moduleAccess: Array<{ moduleKey: string; standing: ModuleStanding }> | undefined,
  ): Promise<Array<{ moduleKey: string; standing: ModuleStanding }>> {
    if (!moduleAccess || moduleAccess.length === 0) return [];

    const actorCtx: CurrentUserContext = {
      userId: actor.userId,
      orgId,
      isOrgOwner: actor.isOrgOwner,
      role: "MEMBER",
      sessionId: "",
      tokenScopes: null,
      principal: humanSessionPrincipal(0, actor.isOrgOwner),
    };

    for (const item of moduleAccess) {
      validateModuleKeyAndStanding(item.moduleKey, item.standing);
      const resolved = await resolveModuleStandingRole(this.db, orgId, item.moduleKey, item.standing);
      if (!resolved) {
        throw new BadRequestException(
          `No seeded role found for module "${item.moduleKey}" with standing "${item.standing}"`,
        );
      }
      await assertMayAssignRole(this.db, this.access, actorCtx, resolved);
    }

    return moduleAccess;
  }

  private async deliverInvitation(
    delivery: InvitationDelivery,
    orgId: string,
    invitationId: string,
    email: string,
    rawToken: string,
    organizationName: string,
  ): Promise<void> {
    if (delivery === "enqueue") {
      await this.email.queueInvitationEmail(email, rawToken, organizationName);
      return;
    }

    const sendBackground = async (): Promise<void> => {
      try {
        await this.email.sendInvitationEmail(email, rawToken, organizationName);
      } catch (err: unknown) {
        await recordDeliveryFailure(this.db, this.logger, orgId, invitationId, err);
      }
    };

    const registered = registerAfterCommit(sendBackground);
    if (!registered) await sendBackground();
  }
}
