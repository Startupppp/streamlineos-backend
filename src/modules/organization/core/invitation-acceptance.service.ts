import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { randomUUID, randomBytes, randomInt } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { withIdentity } from "../../../common/tenant/with-identity";
import { LEGACY_CELL_ID } from "../../../common/region/placement";
import { addMinutes } from "date-fns";
import { digestsMatch, hashToken } from "../../../common/security/token.util";
import { withPublicToken } from "../../../common/tenant/with-public-token";
import {
  runInNewTenantTransaction,
  runInTenantTransaction,
} from "../../../common/tenant/run-in-tenant-transaction";
import { getOrgAdminRecipients } from "../../../common/tenant/org-admin-recipients";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { withMembershipMutations } from "../../../common/org/membership-mutations";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import { lockMembersQuota } from "../../billing/core/seat-definition";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import {
  accountOrganizationIndex,
  invitationEmailOtps,
  invitationEvents,
  invitations,
  magicLinkTokens,
  organizationMembers,
  organizations,
  users,
} from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type {
  AcceptInvitationInput,
  DeclineInvitationInput,
} from "./dto/organization.schemas";
import { EmailService } from "../../email/email.service";
import {
  invitationTransition,
  lockPendingInvitation,
  requireActiveOrg,
} from "./invitations.helpers";
import {
  admissionFailure,
  canonicalAdmissionEmail,
  loadAllowedDomains,
  refuseDomain,
} from "./membership-admission.service";
import { isUniqueViolationOn } from "../../../common/db/postgres-error";
import {
  notifyInvitationAccepted,
  notifyInvitationDeclined,
} from "./invitation-outcome-notifications";
import { projectAcceptedMembership } from "./invitation-acceptance-projection";

const USERS_EMAIL_UNIQUE_CONSTRAINTS = [
  "users_email_unique",
  "uniq_users_email_ci",
];

const INVITATION_OTP_MAX_ATTEMPTS = 5;

const SUSPENDED_ACCOUNT_MESSAGE =
  "This account is suspended. It must be restored before it can join another organization.";

const CONCURRENT_SIGNUP_MESSAGE =
  "Another sign-up for this email address was in progress. Please open the invitation link again.";

@Injectable()
export class InvitationAcceptanceService {
  private readonly logger = new Logger(InvitationAcceptanceService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly planLimits: PlanLimitsService,
    private readonly seatLedger: SeatLedgerService,
    private readonly dispatch: NotificationDispatchService,
    private readonly email: EmailService,
  ) {}

  private async assertAdmissionPolicy(
    tx: DbOrTx,
    orgId: string,
    email: string,
  ): Promise<void> {
    const domains = await loadAllowedDomains(tx, orgId);
    const refusal = refuseDomain(canonicalAdmissionEmail(email), domains);
    if (refusal) throw admissionFailure(refusal);
  }

  private async assertSeatAvailable(tx: DbOrTx, orgId: string): Promise<void> {
    await tx.execute(lockMembersQuota(orgId));
    try {
      await this.planLimits.assertWithinLimit(orgId, "members", 0, tx);
    } catch (err) {
      if (err instanceof ForbiddenException) {
        throw new ForbiddenException(
          "This organization has reached its member limit. Ask an admin to upgrade the plan or free a seat.",
        );
      }
      throw err;
    }
  }

  private async claimInvitation(
    tx: DbOrTx,
    invitationId: string,
    orgId: string,
    membershipId: number,
  ): Promise<void> {
    const claimed = await invitationTransition(tx, {
      invitationId,
      orgId: null,
      from: "PENDING",
      to: "ACCEPTED",
      patch: { acceptedAt: new Date(), acceptedMembershipId: membershipId },
    });
    if (!claimed) throw new NotFoundException("Invalid or expired invitation");
    await tx.insert(invitationEvents).values({
      orgId,
      invitationId,
      event: "ACCEPTED",
      actorMembershipId: membershipId,
    });
    await this.seatLedger.recordSeatEvent(
      {
        orgId,
        eventType: "INVITE_ACCEPTED",
        subjectId: invitationId,
        reason: "invitation accepted",
        idempotencyKey: `invite-accepted:${invitationId}`,
      },
      tx,
    );
  }

  private issueMagicLink(
    tx: DbOrTx,
    userId: string,
    rawToken: string,
    orgId: string,
  ): Promise<unknown> {
    return tx.insert(magicLinkTokens).values({
      id: randomUUID(),
      userId,
      orgId,
      tokenHash: hashToken(rawToken),
      expiresAt: addMinutes(new Date(), 10),
    });
  }

  private invalidateJoinCaches(
    orgId: string,
    userId: string,
  ): Promise<unknown[]> {
    return Promise.all([
      this.cache.invalidate(CACHE_KEYS.userSession(userId)),
      this.cache.invalidateNamespaceForOrg(orgId, "org:members:list"),
      this.cache.invalidateForOrg(orgId, "rbac:members"),
      this.cache.invalidateForOrg(orgId, "module-access:candidates"),
      this.cache.invalidateForOrg(orgId, "users:stats"),
    ]);
  }

  private findPendingByToken(tokenHash: string) {
    return withPublicToken(this.db, tokenHash, (tx) =>
      tx.query.invitations.findFirst({
        where: and(
          eq(invitations.tokenHash, tokenHash),
          eq(invitations.status, "PENDING"),
          gt(invitations.expiresAt, new Date()),
          isNull(invitations.acceptedAt),
        ),
      }),
    );
  }

  async requestInvitationEmailOtp(token: string): Promise<{ ok: true }> {
    const tokenHash = hashToken(token);
    const invitation = await this.findPendingByToken(tokenHash);
    if (!invitation)
      throw new NotFoundException("Invalid or expired invitation");

    const rawCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const codeHash = hashToken(rawCode);
    const expiresAt = addMinutes(new Date(), 10);

    await this.db
      .update(invitationEmailOtps)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(invitationEmailOtps.invitationId, invitation.id),
          isNull(invitationEmailOtps.usedAt),
        ),
      );

    const [inserted] = await this.db
      .insert(invitationEmailOtps)
      .values({ invitationId: invitation.id, codeHash, expiresAt })
      .returning({ id: invitationEmailOtps.id });

    try {
      await this.email.sendEmailOtpEmail(invitation.email, rawCode);
    } catch {
      if (inserted) {
        await this.db
          .update(invitationEmailOtps)
          .set({ usedAt: new Date() })
          .where(eq(invitationEmailOtps.id, inserted.id));
      }
      throw new ServiceUnavailableException(
        "Could not send the verification code. Please try again in a moment.",
      );
    }

    return { ok: true };
  }

  private async verifyAndConsumeInvitationOtp(
    invitationId: string,
    code: string,
  ): Promise<void> {
    const normalizedCode = code.trim();

    const row = await this.db.query.invitationEmailOtps.findFirst({
      where: and(
        eq(invitationEmailOtps.invitationId, invitationId),
        isNull(invitationEmailOtps.usedAt),
        gt(invitationEmailOtps.expiresAt, sql`now()`),
      ),
      orderBy: [
        desc(invitationEmailOtps.createdAt),
        desc(invitationEmailOtps.id),
      ],
    });

    if (!row)
      throw new UnauthorizedException("Invalid or expired verification code");

    const [bumped] = await this.db
      .update(invitationEmailOtps)
      .set({ attempts: sql`${invitationEmailOtps.attempts} + 1` })
      .where(
        and(
          eq(invitationEmailOtps.id, row.id),
          isNull(invitationEmailOtps.usedAt),
        ),
      )
      .returning({ attempts: invitationEmailOtps.attempts });

    if (!bumped || bumped.attempts > INVITATION_OTP_MAX_ATTEMPTS) {
      throw new UnauthorizedException("Invalid or expired verification code");
    }

    if (!digestsMatch(row.codeHash, hashToken(normalizedCode))) {
      throw new UnauthorizedException("Invalid or expired verification code");
    }

    await this.db
      .update(invitationEmailOtps)
      .set({ usedAt: new Date() })
      .where(eq(invitationEmailOtps.id, row.id));
  }

  async accept(
    input: AcceptInvitationInput,
  ): Promise<{ ok: boolean; autoLoginToken?: string }> {
    const tokenHash = hashToken(input.token);
    const invitation = await this.findPendingByToken(tokenHash);
    if (!invitation)
      throw new NotFoundException("Invalid or expired invitation");
    const invitedOrgId = invitation.orgId;

    const { existingUser, existingMembership } = await runInTenantTransaction(
      this.db,
      async (tx) => {
        await requireActiveOrg(tx, invitation.orgId);
        const existingUser = await tx.query.users.findFirst({
          where: eq(users.email, invitation.email),
          columns: { id: true, isActive: true, deletedAt: true },
        });
        const existingMembership = existingUser
          ? await tx.query.organizationMembers.findFirst({
              where: and(
                eq(organizationMembers.userId, existingUser.id),
                eq(organizationMembers.orgId, invitation.orgId),
              ),
              columns: { status: true },
            })
          : undefined;
        return { existingUser, existingMembership };
      },
      { orgId: invitedOrgId },
    );

    // Tenant admission never reactivates a globally suspended account (root §8).
    if (
      existingUser &&
      (!existingUser.isActive || existingUser.deletedAt !== null)
    )
      throw new ForbiddenException(SUSPENDED_ACCOUNT_MESSAGE);

    if (existingMembership) {
      if (
        existingMembership.status === "SUSPENDED" ||
        existingMembership.status === "LEFT"
      ) {
        throw new ConflictException(
          "Your membership in this organization is archived or suspended. Ask an admin to restore you from Users.",
        );
      }
      throw new ConflictException(
        "You are already a member of this organization",
      );
    }

    if (!input.emailOtp) {
      throw new BadRequestException(
        "An email verification code is required to accept this invitation",
      );
    }
    await this.verifyAndConsumeInvitationOtp(invitation.id, input.emailOtp);

    const autoLoginToken = randomBytes(32).toString("hex");
    const joinedUserId = existingUser
      ? await this.acceptAsExistingUser(
          invitation.id,
          invitedOrgId,
          tokenHash,
          existingUser.id,
          autoLoginToken,
        )
      : await this.acceptAsNewUser(
          invitation.id,
          invitedOrgId,
          tokenHash,
          input,
          autoLoginToken,
        );

    // Index first, then invalidate: the session resolves its org from this projection.
    await projectAcceptedMembership(
      this.db,
      this.logger,
      invitedOrgId,
      joinedUserId,
    );
    await this.invalidateJoinCaches(invitedOrgId, joinedUserId);

    await notifyInvitationAccepted(
      this.db,
      this.dispatch,
      invitedOrgId,
      invitation.id,
      invitation.email,
      invitation.inviterMembershipId ?? null,
      joinedUserId,
    ).catch(() => undefined);

    return { ok: true, autoLoginToken };
  }

  private async acceptAsExistingUser(
    invitationId: string,
    orgId: string,
    tokenHash: string,
    userId: string,
    autoLoginToken: string,
  ): Promise<string> {
    await withMembershipMutations(this.cache, (membership) =>
      runInTenantTransaction(
        this.db,
        async (tx) => {
          const lockedInvitation = await lockPendingInvitation(
            tx,
            invitationId,
            tokenHash,
          );
          await this.assertAdmissionPolicy(tx, orgId, lockedInvitation.email);
          await this.assertSeatAvailable(tx, orgId);

          const membershipId = await membership.createMembership(tx, {
            orgId: lockedInvitation.orgId,
            userId,
            role: lockedInvitation.role,
            onConflict: "skip",
          });
          if (membershipId === null) {
            throw new ConflictException(
              "You are already a member of this organization",
            );
          }

          await tx
            .update(users)
            .set({ lastActiveOrgId: lockedInvitation.orgId })
            .where(eq(users.id, userId));

          await this.claimInvitation(tx, invitationId, orgId, membershipId);
          await this.issueMagicLink(tx, userId, autoLoginToken, orgId);
        },
        { orgId },
      ),
    );
    return userId;
  }

  private async acceptAsNewUser(
    invitationId: string,
    orgId: string,
    tokenHash: string,
    input: AcceptInvitationInput,
    autoLoginToken: string,
  ): Promise<string> {
    const userId = randomUUID();
    const firstName = input.firstName?.trim() || null;
    const lastName = input.lastName?.trim() || null;

    try {
      await withMembershipMutations(this.cache, (membership) =>
        runInTenantTransaction(
          this.db,
          async (tx) => {
            const lockedInvitation = await lockPendingInvitation(
              tx,
              invitationId,
              tokenHash,
            );
            await this.assertAdmissionPolicy(tx, orgId, lockedInvitation.email);
            await this.assertSeatAvailable(tx, orgId);

            const fromNames =
              [firstName, lastName].filter(Boolean).join(" ") || null;
            const emailLocal =
              lockedInvitation.email.split("@")[0]?.trim() || null;

            await tx.insert(users).values({
              id: userId,
              email: lockedInvitation.email,
              name: fromNames ?? emailLocal,
              firstName,
              lastName,
              emailVerified: new Date(),
              lastActiveOrgId: lockedInvitation.orgId,
            });
            const membershipId = await membership.createMembership(tx, {
              orgId: lockedInvitation.orgId,
              userId,
              role: lockedInvitation.role,
              onConflict: "skip",
            });
            if (membershipId === null) {
              throw new ConflictException(
                "You are already a member of this organization",
              );
            }

            await this.claimInvitation(tx, invitationId, orgId, membershipId);
            await this.issueMagicLink(tx, userId, autoLoginToken, orgId);
          },
          { orgId },
        ),
      );
    } catch (err) {
      if (!isUniqueViolationOn(err, ...USERS_EMAIL_UNIQUE_CONSTRAINTS))
        throw err;
      const recovery = await runInNewTenantTransaction(
        this.db,
        orgId,
        async (tx) => {
          const inv = await tx.query.invitations.findFirst({
            where: eq(invitations.id, invitationId),
            columns: { email: true },
          });
          if (!inv) return null;
          return tx.query.users.findFirst({
            where: eq(users.email, inv.email),
            columns: { id: true, isActive: true, deletedAt: true },
          });
        },
      );
      if (!recovery) throw new ConflictException(CONCURRENT_SIGNUP_MESSAGE);
      if (!recovery.isActive || recovery.deletedAt !== null)
        throw new ForbiddenException(SUSPENDED_ACCOUNT_MESSAGE);
      return this.acceptAsExistingUser(
        invitationId,
        orgId,
        tokenHash,
        recovery.id,
        autoLoginToken,
      );
    }
    return userId;
  }

  async decline(input: DeclineInvitationInput): Promise<{ ok: true }> {
    const tokenHash = hashToken(input.token);
    const invitation = await this.findPendingByToken(tokenHash);
    if (!invitation)
      throw new NotFoundException("Invalid or expired invitation");
    const orgId = invitation.orgId;

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const declined = await tx
          .update(invitations)
          .set({
            status: "DECLINED",
            declinedAt: new Date(),
          })
          .where(
            and(
              eq(invitations.id, invitation.id),
              eq(invitations.tokenHash, tokenHash),
              eq(invitations.status, "PENDING"),
              isNull(invitations.acceptedAt),
            ),
          )
          .returning({ id: invitations.id });
        if (declined.length === 0) {
          throw new NotFoundException("Invalid or expired invitation");
        }
        await tx.insert(invitationEvents).values({
          orgId,
          invitationId: invitation.id,
          event: "DECLINED",
          actorMembershipId: null,
        });
        await this.seatLedger.recordSeatEvent(
          {
            orgId,
            eventType: "INVITE_CANCELLED",
            subjectId: invitation.id,
            reason: "invitation declined by recipient",
            idempotencyKey: `invite-declined:${invitation.id}`,
          },
          tx,
        );
      },
      { orgId },
    );

    await this.cache.invalidateForOrg(orgId, "users:stats");

    await notifyInvitationDeclined(
      this.db,
      this.dispatch,
      orgId,
      invitation.id,
      invitation.email,
      invitation.inviterMembershipId ?? null,
    ).catch(() => undefined);

    return { ok: true };
  }
}
