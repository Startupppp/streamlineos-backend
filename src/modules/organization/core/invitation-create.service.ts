import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { randomUUID, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { addDays } from "date-fns";
import { hashToken } from "../../../common/security/token.util";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { registerAfterCommit } from "../../../common/tenant";
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
import {
  invitationEvents,
  invitationModuleAccess,
  invitations,
} from "../../../db/schema";
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

interface BulkInvitationDraft {
  index: number;
  email: string;
  originalEmail: string;
  invitationId: string;
  rawToken: string;
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
    const validatedAccess = await this.validateModuleAccess(
      orgId,
      actor,
      moduleAccess,
    );
    return this.inviteAuthorized(
      orgId,
      actor.userId,
      email.trim().toLowerCase(),
      role,
      validatedAccess,
    );
  }

  async bulkInvite(
    orgId: string,
    actor: InviteActor,
    emails: string[],
    role: string,
    _delivery: InvitationDelivery = "enqueue",
  ): Promise<{
    deliveryMode: InvitationDelivery;
    results: BulkInviteRowResult[];
  }> {
    await assertMayGrantRole(this.access, orgId, actor, role);
    // Validated once for the batch: one actor, one set of standings. A standing
    // the actor may not grant refuses the whole batch rather than every row.
    const validatedAccess = await this.validateModuleAccess(
      orgId,
      actor,
      moduleAccess,
    );

    const results: BulkInviteRowResult[] = new Array(emails.length);
    const seenCanonical = new Map<string, number>();
    const unique: Array<{
      index: number;
      email: string;
      originalEmail: string;
    }> = [];

    for (let i = 0; i < emails.length; i++) {
      const originalEmail = emails[i] ?? "";
      const canonicalEmail = canonicalAdmissionEmail(originalEmail);

      if (seenCanonical.has(canonicalEmail)) {
        results[i] = {
          email: canonicalEmail,
          originalEmail,
          success: false,
          isDuplicate: true,
          error: "Duplicate email in batch",
        };
        continue;
      }

      seenCanonical.set(canonicalEmail, i);
      unique.push({ index: i, email: canonicalEmail, originalEmail });
    }

    if (unique.length === 0) return { deliveryMode: "enqueue", results };

    const [org, actorMembership, screens] = await Promise.all([
      requireActiveOrg(this.db, orgId),
      findActorMembershipId(this.db, orgId, actor.userId),
      this.admission.screenMany(this.db, {
        orgId,
        emails: unique.map((entry) => entry.email),
      }),
    ]);

    const candidates: BulkInvitationDraft[] = [];
    for (const entry of unique) {
      const screen = screens.get(entry.email);
      if (!screen)
        throw new Error(
          `Admission screening returned no result for ${entry.email}`,
        );
      if (screen.kind !== "clear") {
        results[entry.index] = {
          email: entry.email,
          originalEmail: entry.originalEmail,
          success: false,
          error: admissionFailure(screen).message,
        };
        continue;
      }
      candidates.push({
        ...entry,
        invitationId: randomUUID(),
        rawToken: randomBytes(32).toString("hex"),
      });
    }

    if (candidates.length > 0) {
      await runInTenantTransaction(
        this.db,
        async (tx) => {
          const now = new Date();
          const expiresAt = addDays(now, 7);
          const pending = await tx
            .select({
              id: invitations.id,
              email: invitations.email,
              expiresAt: invitations.expiresAt,
            })
            .from(invitations)
            .where(
              and(
                eq(invitations.orgId, orgId),
                inArray(
                  invitations.email,
                  candidates.map((entry) => entry.email),
                ),
                eq(invitations.status, "PENDING"),
                isNull(invitations.acceptedAt),
              ),
            )
            .for("update")
            .limit(candidates.length);
          const pendingByEmail = new Map(
            pending.map((row) => [row.email, row]),
          );
          const expired = pending.filter((row) => row.expiresAt <= now);
          const livePending = new Set(
            pending
              .filter((row) => row.expiresAt > now)
              .map((row) => row.email),
          );

          if (expired.length > 0) {
            await tx
              .update(invitations)
              .set({ status: "EXPIRED" })
              .where(
                and(
                  eq(invitations.orgId, orgId),
                  inArray(
                    invitations.id,
                    expired.map((row) => row.id),
                  ),
                  eq(invitations.status, "PENDING"),
                  isNull(invitations.acceptedAt),
                ),
              );
          }

          const resends = candidates
            .filter((candidate) => livePending.has(candidate.email))
            .map((candidate) => ({
              ...candidate,
              invitationId: pendingByEmail.get(candidate.email)!.id,
            }));
          const newCandidates = candidates.filter(
            (candidate) => !livePending.has(candidate.email),
          );

          await tx.execute(lockMembersQuota(orgId));
          const headroom = await this.planLimits.headroomFor(
            orgId,
            "members",
            tx,
          );
          const allowedNewCount =
            headroom.available === null
              ? newCandidates.length
              : Math.min(headroom.available, newCandidates.length);
          const allowedNew = newCandidates.slice(0, allowedNewCount);
          const refusedForQuota = newCandidates.slice(allowedNewCount);
          if (allowedNew.length > 0)
            await this.planLimits.assertWithinLimit(
              orgId,
              "members",
              allowedNew.length,
              tx,
            );

          for (const candidate of refusedForQuota) {
            results[candidate.index] = {
              email: candidate.email,
              originalEmail: candidate.originalEmail,
              success: false,
              error: "This organization has reached its member limit",
            };
          }

          if (resends.length > 0) {
            const values = resends.map(
              (candidate) =>
                sql`(${candidate.invitationId}, ${hashToken(candidate.rawToken)})`,
            );
            await tx.execute(sql`
              WITH invitation_tokens(id, token_hash) AS (
                VALUES ${sql.join(values, sql`, `)}
              )
              UPDATE invitations AS invitation
              SET token_hash = invitation_tokens.token_hash,
                  expires_at = ${expiresAt},
                  role = ${role},
                  inviter_membership_id = ${actorMembership?.id ?? null},
                  status = 'PENDING',
                  revoked_at = NULL,
                  revoked_by_membership_id = NULL,
                  declined_at = NULL
              FROM invitation_tokens
              WHERE invitation.id = invitation_tokens.id
                AND invitation.org_id = ${orgId}
            `);
          }

          const inserted =
            allowedNew.length === 0
              ? []
              : await tx
                  .insert(invitations)
                  .values(
                    allowedNew.map((candidate) => ({
                      id: candidate.invitationId,
                      email: candidate.email,
                      tokenHash: hashToken(candidate.rawToken),
                      orgId,
                      role,
                      inviterMembershipId: actorMembership?.id ?? null,
                      expiresAt,
                    })),
                  )
                  .onConflictDoNothing()
                  .returning({ id: invitations.id, email: invitations.email });
          const insertedByEmail = new Map(
            inserted.map((row) => [row.email, row.id]),
          );
          const created = allowedNew.filter((candidate) => {
            const invitationId = insertedByEmail.get(candidate.email);
            if (invitationId) {
              candidate.invitationId = invitationId;
              return true;
            }
            results[candidate.index] = {
              email: candidate.email,
              originalEmail: candidate.originalEmail,
              success: false,
              error: "An invitation is already pending for this email",
            };
            return false;
          });
          const successful = [...resends, ...created];

          const events = [
            ...expired.map((row) => ({
              orgId,
              invitationId: row.id,
              event: "EXPIRED" as const,
              actorMembershipId: null,
            })),
            ...resends.map((candidate) => ({
              orgId,
              invitationId: candidate.invitationId,
              event: "RESENT" as const,
              actorMembershipId: null,
            })),
            ...created.map((candidate) => ({
              orgId,
              invitationId: candidate.invitationId,
              event: "CREATED" as const,
              actorMembershipId: actorMembership?.id ?? null,
            })),
          ];
          if (events.length > 0)
            await tx.insert(invitationEvents).values(events);

          await this.seatLedger.recordSeatEvents(tx, orgId, [
            ...expired.map((row) => ({
              eventType: "INVITE_EXPIRED" as const,
              subjectId: row.id,
              actorId: actor.userId,
              reason: "invitation expired before re-invite",
              idempotencyKey: `invite-expired:${row.id}`,
            })),
            ...created.map((candidate) => ({
              eventType: "INVITE_SENT" as const,
              subjectId: candidate.invitationId,
              actorId: actor.userId,
              reason: "invitation sent",
              idempotencyKey: `invite-sent:${candidate.invitationId}`,
            })),
          ]);

          await this.email.queueInvitationEmails(
            successful.map((candidate) => ({
              email: candidate.email,
              token: candidate.rawToken,
              organizationName: org.name,
              organizationId: orgId,
            })),
          );

          for (const candidate of successful) {
            results[candidate.index] = {
              email: candidate.email,
              originalEmail: candidate.originalEmail,
              success: true,
              invitationId: candidate.invitationId,
            };
          }
        },
        { orgId },
      );

      const successful = results.filter(
        (row): row is BulkInviteRowResult & { invitationId: string } =>
          row?.success === true && row.invitationId !== undefined,
      );
      this.audit.logMany(
        successful.map((row) => ({
          action: "user.invited",
          userId: actor.userId,
          orgId,
          targetId: row.invitationId,
          targetType: "invitation",
          metadata: { email: row.email, role, bulk: true },
        })),
      );
      await this.cache.invalidateForOrg(orgId, "users:stats");
    }

    return { deliveryMode: "enqueue", results };
  }

  private async inviteAuthorized(
    orgId: string,
    actorUserId: string,
    email: string,
    role: string,
    moduleAccessRows: Array<{
      moduleKey: string;
      standing: ModuleStanding;
    }> = [],
    delivery: InvitationDelivery = "background",
  ): Promise<InvitationMutationResult> {
    const org = await requireActiveOrg(this.db, orgId);

    const screen = await this.admission.screen(this.db, { orgId, email });
    if (screen.kind !== "clear") throw admissionFailure(screen);

    const now = new Date();
    const actorMembership = await findActorMembershipId(
      this.db,
      orgId,
      actorUserId,
    );

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

        await tx
          .delete(invitationModuleAccess)
          .where(eq(invitationModuleAccess.invitationId, pendingInvitation.id));

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
    moduleAccess:
      | Array<{ moduleKey: string; standing: ModuleStanding }>
      | undefined,
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
      const resolved = await resolveModuleStandingRole(
        this.db,
        orgId,
        item.moduleKey,
        item.standing,
      );
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
        await recordDeliveryFailure(
          this.db,
          this.logger,
          orgId,
          invitationId,
          err,
        );
      }
    };

    const registered = registerAfterCommit(sendBackground);
    if (!registered) await sendBackground();
  }
}
