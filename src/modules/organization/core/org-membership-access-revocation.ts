import { Logger } from "@nestjs/common";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import {
  agentTokens,
  chatHuddleParticipants,
  chatMessages,
  chatReplyReminders,
  chatSavedMessages,
  invitationEvents,
  invitations,
  organizationMembers,
  organizations,
  ownershipTransfers,
  portalMemberships,
  resourceGrants,
  userApiTokens,
  userDelegations,
  userIntegrationConnections,
  users,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { revokeStandingNowAndAfterCommit } from "../../../common/rbac/access-mutation-commit";
import { SessionsService } from "../../sessions/sessions.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { withIdentity } from "../../../common/tenant/with-identity";
import {
  registerAfterCommit,
  runOutsideTenantContext,
} from "../../../common/tenant/tenant-context";
import { EmailService } from "../../email/email.service";
import { AblyService } from "../../realtime/ably.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { randomUUID } from "node:crypto";

export type MembershipRevocationCause =
  | "removed"
  | "suspended"
  | "archived"
  | "left";

export class OrgMembershipAccessRevocation {
  private readonly logger = new Logger(OrgMembershipAccessRevocation.name);

  constructor(
    private readonly ably: AblyService,
    private readonly db: Db,
    private readonly cache: CacheService,
    private readonly sessions: SessionsService,
    private readonly email: EmailService,
  ) {}

  async notifyAccessLoss(
    orgId: string,
    memberUserId: string,
    kind: "removed" | "suspended",
  ): Promise<void> {
    const [member, org] = await Promise.all([
      this.db.query.users.findFirst({
        where: eq(users.id, memberUserId),
        columns: { email: true, name: true, firstName: true },
      }),
      this.db.query.organizations.findFirst({
        where: eq(organizations.id, orgId),
        columns: { name: true },
      }),
    ]);
    if (!member?.email || !org) return;

    const displayName = member.firstName ?? member.name ?? member.email;
    void (
      kind === "removed"
        ? this.email.sendMembershipRemovedEmail(
            member.email,
            displayName,
            org.name,
          )
        : this.email.sendMembershipSuspendedEmail(
            member.email,
            displayName,
            org.name,
          )
    ).catch((err: unknown) => {
      this.logger.warn(
        `Access ${kind} notice not delivered for user ${memberUserId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  async revokeOrgScopedAccess(
    orgId: string,
    memberUserId: string,
    cause: MembershipRevocationCause,
  ): Promise<void> {
    await this.invalidateMemberSessionCaches(orgId, memberUserId);
    const now = new Date();
    const isGrantCleanupCause = cause === "removed" || cause === "left";
    let userEmail: string | null = null;
    if (isGrantCleanupCause) {
      const user = await this.db.query.users.findFirst({
        where: eq(users.id, memberUserId),
        columns: { email: true },
      });
      userEmail = user?.email ?? null;
    }

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [membership] = await tx
          .select({ id: organizationMembers.id })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.userId, memberUserId),
              eq(organizationMembers.orgId, orgId),
            ),
          )
          .limit(1);
        const membershipId = membership?.id;

        if (membershipId !== undefined) {
          await tx
            .update(agentTokens)
            .set({ revokedAt: now })
            .where(
              and(
                eq(agentTokens.orgId, orgId),
                eq(agentTokens.issuerMembershipId, membershipId),
                isNull(agentTokens.revokedAt),
              ),
            );
          await tx
            .update(userDelegations)
            .set({ status: "REVOKED", revokedAt: now })
            .where(
              and(
                eq(userDelegations.orgId, orgId),
                eq(userDelegations.status, "ACTIVE"),
                or(
                  eq(userDelegations.delegatorMembershipId, membershipId),
                  eq(userDelegations.delegateeMembershipId, membershipId),
                ),
              ),
            );
          await tx
            .update(ownershipTransfers)
            .set({ status: "CANCELLED" })
            .where(
              and(
                eq(ownershipTransfers.orgId, orgId),
                eq(ownershipTransfers.status, "PENDING"),
                or(
                  eq(ownershipTransfers.fromMembershipId, membershipId),
                  eq(ownershipTransfers.toMembershipId, membershipId),
                  eq(ownershipTransfers.initiatedByMembershipId, membershipId),
                ),
              ),
            );
        }

        if (isGrantCleanupCause) {
          const membershipPrincipalFilter =
            membershipId !== undefined
              ? and(
                  eq(resourceGrants.principalType, "org_membership"),
                  eq(resourceGrants.principalId, String(membershipId)),
                )
              : undefined;
          await tx
            .delete(resourceGrants)
            .where(
              and(
                eq(resourceGrants.orgId, orgId),
                or(
                  and(
                    eq(resourceGrants.principalType, "user"),
                    eq(resourceGrants.principalId, memberUserId),
                  ),
                  membershipPrincipalFilter,
                ),
              ),
            );
          if (userEmail) {
            const revokedInvites = await tx
              .update(invitations)
              .set({ status: "REVOKED", revokedAt: now })
              .where(
                and(
                  eq(invitations.orgId, orgId),
                  eq(invitations.email, userEmail),
                  eq(invitations.status, "PENDING"),
                  isNull(invitations.acceptedAt),
                ),
              )
              .returning({ id: invitations.id });
            if (revokedInvites.length > 0) {
              await tx.insert(invitationEvents).values(
                revokedInvites.map((invite) => ({
                  orgId,
                  invitationId: invite.id,
                  event: "REVOKED" as const,
                  actorMembershipId: null,
                })),
              );
            }
          }

          const senderFilter = membershipId !== undefined
            ? eq(chatMessages.senderMembershipId, membershipId)
            : sql`false`;
          await tx
            .update(chatMessages)
            .set({ senderMembershipId: null })
            .where(and(eq(chatMessages.orgId, orgId), senderFilter));
          const savedFilter = membershipId !== undefined
            ? eq(chatSavedMessages.membershipId, membershipId)
            : sql`false`;
          await tx
            .delete(chatSavedMessages)
            .where(and(eq(chatSavedMessages.orgId, orgId), savedFilter));
          const reminderFilter = membershipId !== undefined
            ? or(
                eq(chatReplyReminders.recipientMembershipId, membershipId),
                eq(chatReplyReminders.senderMembershipId, membershipId),
              )
            : sql`false`;
          await tx
            .delete(chatReplyReminders)
            .where(and(eq(chatReplyReminders.orgId, orgId), reminderFilter));
          const huddleFilter = membershipId !== undefined
            ? eq(chatHuddleParticipants.membershipId, membershipId)
            : sql`false`;
          await tx
            .delete(chatHuddleParticipants)
            .where(and(eq(chatHuddleParticipants.orgId, orgId), huddleFilter));
        }

        if (membershipId !== undefined) {
          await tx
            .update(portalMemberships)
            .set({ status: "REVOKED" })
            .where(
              and(
                eq(portalMemberships.organizationId, orgId),
                eq(portalMemberships.userMembershipId, membershipId),
                ne(portalMemberships.status, "REVOKED"),
              ),
            );
        }

        const updatedConns = await tx
          .update(userIntegrationConnections)
          .set({ status: "disabled" })
          .where(
            and(
              eq(userIntegrationConnections.orgId, orgId),
              eq(userIntegrationConnections.userId, memberUserId),
              ne(userIntegrationConnections.status, "disabled"),
            ),
          )
          .returning({
            id: userIntegrationConnections.id,
            composioConnectedAccountId:
              userIntegrationConnections.composioConnectedAccountId,
          });
        await OutboxWriter.emitMany(
          tx,
          updatedConns.map((connection) => ({
            eventId: randomUUID(),
            organizationId: orgId,
            aggregateType: "user_integration_connection",
            aggregateId: String(connection.id),
            aggregateVersion: 1,
            eventType: "integration.connection.disconnected",
            payload: {
              connectionId: connection.id,
              composioConnectedAccountId: connection.composioConnectedAccountId,
              userId: memberUserId,
              orgId,
              cause,
            },
            occurredAt: now,
          })),
        );
      },
      { orgId },
    );

    const withdrawRealtime = (): Promise<unknown> =>
      this.ably.revokeUserTokens(memberUserId).catch((err: unknown) => {
        this.logger.warn(
          `Realtime token revocation failed for user ${memberUserId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    if (!registerAfterCommit(withdrawRealtime)) void withdrawRealtime();

    const hasOtherActiveMemberships = await runOutsideTenantContext(() =>
      withIdentity(this.db, memberUserId, async (tx) => {
        const other = await tx
          .select({ one: sql`1` })
          .from(organizationMembers)
          .innerJoin(
            organizations,
            eq(organizations.id, organizationMembers.orgId),
          )
          .where(
            and(
              eq(organizationMembers.userId, memberUserId),
              eq(organizationMembers.status, "ACTIVE"),
              eq(organizations.status, "ACTIVE"),
              isNull(organizations.deletedAt),
              ne(organizationMembers.orgId, orgId),
            ),
          )
          .limit(1);
        return other.length > 0;
      }),
    );
    if (!hasOtherActiveMemberships) {
      await this.sessions.revokeAllForUser(memberUserId);
    }
  }

  async revokeAccountAccess(
    orgId: string,
    memberUserId: string,
  ): Promise<void> {
    await this.revokeOrgScopedAccess(orgId, memberUserId, "removed");
    await this.sessions.revokeAllForUser(memberUserId);
    await this.db
      .update(userApiTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userApiTokens.userId, memberUserId),
          isNull(userApiTokens.revokedAt),
        ),
      );
  }

  async invalidateMemberSessionCaches(
    orgId: string,
    memberUserId: string,
  ): Promise<void> {
    return revokeStandingNowAndAfterCommit(this.cache, memberUserId);
  }
}
