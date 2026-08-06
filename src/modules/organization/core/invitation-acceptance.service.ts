import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { addMinutes } from "date-fns";
import { hashToken } from "../../../common/security/token.util";
import { withPublicToken } from "../../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { getOrgAdminRecipients } from "../../../common/tenant/org-admin-recipients";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { bustUsersStatsCache } from "../../../common/cache/bust-users-stats";
import { bustMembershipStatusCache } from "../../../common/auth/membership-state.service";
import { syncStructuralRoleAssignment } from "../../../common/rbac/sync-structural-role";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import {
  invitationEvents,
  invitations,
  magicLinkTokens,
  organizationMembers,
  users,
} from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type {
  AcceptInvitationInput,
  DeclineInvitationInput,
} from "./dto/organization.schemas";
import { lockPendingInvitation, requireActiveOrg } from "./invitations.helpers";

@Injectable()
export class InvitationAcceptanceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly planLimits: PlanLimitsService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  private async assertSeatAvailable(tx: DbOrTx, orgId: string): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${orgId}:members`}, 0))`,
    );
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
    const claimedRows = await tx
      .update(invitations)
      .set({
        acceptedAt: new Date(),
        status: "ACCEPTED",
        acceptedMembershipId: membershipId,
      })
      .where(
        and(
          eq(invitations.id, invitationId),
          eq(invitations.status, "PENDING"),
          isNull(invitations.acceptedAt),
        ),
      )
      .returning({ id: invitations.id });
    if (claimedRows.length === 0)
      throw new NotFoundException("Invalid or expired invitation");
    await tx.insert(invitationEvents).values({
      orgId,
      invitationId,
      event: "ACCEPTED",
      actorMembershipId: membershipId,
    });
  }

  private issueMagicLink(
    tx: DbOrTx,
    userId: string,
    rawToken: string,
  ): Promise<unknown> {
    return tx.insert(magicLinkTokens).values({
      id: randomUUID(),
      userId,
      tokenHash: createHash("sha256").update(rawToken).digest("hex"),
      expiresAt: addMinutes(new Date(), 10),
    });
  }

  private invalidateJoinCaches(
    orgId: string,
    userId: string,
  ): Promise<unknown[]> {
    return Promise.all([
      this.cache.invalidate(CACHE_KEYS.userSession(userId)),
      this.cache.invalidateNamespace(CACHE_KEYS.orgMembersListNamespace(orgId)),
      this.cache.invalidate(CACHE_KEYS.rbacDiscoveryMembers(orgId)),
      this.cache.invalidate(CACHE_KEYS.moduleAccessCandidates(orgId)),
      bustUsersStatsCache(this.cache, orgId),
      bustMembershipStatusCache(this.cache, userId, orgId),
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
          columns: { id: true },
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

    await this.invalidateJoinCaches(invitedOrgId, joinedUserId);

    await this.notifyAccepted(
      invitedOrgId,
      invitation.id,
      invitation.email,
      invitation.invitedBy,
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
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const lockedInvitation = await lockPendingInvitation(
          tx,
          invitationId,
          tokenHash,
        );
        await this.assertSeatAvailable(tx, orgId);

        const inserted = await tx
          .insert(organizationMembers)
          .values({
            userId,
            orgId: lockedInvitation.orgId,
            role: lockedInvitation.role,
          })
          .onConflictDoNothing()
          .returning({ id: organizationMembers.id });
        const membershipId = inserted[0]?.id;
        if (membershipId === undefined) {
          throw new ConflictException(
            "You are already a member of this organization",
          );
        }
        await syncStructuralRoleAssignment(
          tx,
          lockedInvitation.orgId,
          membershipId,
          lockedInvitation.role,
        );

        await tx
          .update(users)
          .set({ lastActiveOrgId: lockedInvitation.orgId })
          .where(eq(users.id, userId));

        await this.claimInvitation(tx, invitationId, orgId, membershipId);
        await this.issueMagicLink(tx, userId, autoLoginToken);
      },
      { orgId },
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
      await runInTenantTransaction(
        this.db,
        async (tx) => {
          const lockedInvitation = await lockPendingInvitation(
            tx,
            invitationId,
            tokenHash,
          );
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
          const inserted = await tx
            .insert(organizationMembers)
            .values({
              userId,
              orgId: lockedInvitation.orgId,
              role: lockedInvitation.role,
            })
            .onConflictDoNothing()
            .returning({ id: organizationMembers.id });
          const membershipId = inserted[0]?.id;
          if (membershipId === undefined) {
            throw new ConflictException(
              "You are already a member of this organization",
            );
          }
          await syncStructuralRoleAssignment(
            tx,
            lockedInvitation.orgId,
            membershipId,
            lockedInvitation.role,
          );

          await this.claimInvitation(tx, invitationId, orgId, membershipId);
          await this.issueMagicLink(tx, userId, autoLoginToken);
        },
        { orgId },
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505") {
        throw new ConflictException("Invitation has already been accepted");
      }
      throw err;
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
      },
      { orgId },
    );

    await bustUsersStatsCache(this.cache, orgId);

    await this.notifyDeclined(
      orgId,
      invitation.id,
      invitation.email,
      invitation.invitedBy,
    ).catch(() => undefined);

    return { ok: true };
  }

  private async notifyAccepted(
    orgId: string,
    invitationId: string,
    email: string,
    invitedBy: string | null,
    joinedUserId: string,
  ): Promise<void> {
    const targetUserIds = (
      await getOrgAdminRecipients(this.db, orgId, [invitedBy])
    ).filter((id) => id !== joinedUserId);
    if (targetUserIds.length === 0) return;

    await this.dispatch.emit({
      eventKey: "organization.invitation.accepted",
      orgId,
      actorUserId: joinedUserId,
      targetUserIds,
      entityType: "invitation",
      entityId: invitationId,
      title: "Invitation accepted",
      message: `${email} accepted their invitation and joined the organization.`,
      link: "/users",
    });
  }

  private async notifyDeclined(
    orgId: string,
    invitationId: string,
    email: string,
    invitedBy: string | null,
  ): Promise<void> {
    const targetUserIds = await getOrgAdminRecipients(this.db, orgId, [
      invitedBy,
    ]);
    if (targetUserIds.length === 0) return;

    await this.dispatch.emit({
      eventKey: "organization.invitation.declined",
      orgId,
      targetUserIds,
      entityType: "invitation",
      entityId: invitationId,
      title: "Invitation declined",
      message: `${email} declined the invitation to join the organization.`,
      link: "/users",
    });
  }
}
