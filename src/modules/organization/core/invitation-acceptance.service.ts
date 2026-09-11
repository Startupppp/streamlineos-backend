import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashToken } from "../../../common/security/token.util";
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
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import {
  invitationEvents,
  invitations,
  organizationMembers,
  users,
} from "../../../db/schema";
import type {
  AcceptInvitationInput,
  DeclineInvitationInput,
} from "./dto/organization.schemas";
import { requireActiveOrg } from "./invitations.helpers";
import {
  acceptAsExistingUser,
  acceptAsNewUser,
  touchIndexLastActivated,
  type InvitationJoinDeps,
} from "./lib/invitation-join";

@Injectable()
export class InvitationAcceptanceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly planLimits: PlanLimitsService,
    private readonly seatLedger: SeatLedgerService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  private get joinDeps(): InvitationJoinDeps {
    return {
      db: this.db,
      planLimits: this.planLimits,
      seatLedger: this.seatLedger,
    };
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
      ? await acceptAsExistingUser(
          this.joinDeps,
          invitation.id,
          invitedOrgId,
          tokenHash,
          existingUser.id,
          autoLoginToken,
        )
      : await acceptAsNewUser(
          this.joinDeps,
          invitation.id,
          invitedOrgId,
          tokenHash,
          input,
          autoLoginToken,
        );

    // Index first, then invalidate: the session resolves its org from this projection.
    await touchIndexLastActivated(this.joinDeps, invitedOrgId, joinedUserId).catch(
      () => undefined,
    );
    await this.invalidateJoinCaches(invitedOrgId, joinedUserId);

    await this.notifyAccepted(
      invitedOrgId,
      invitation.id,
      invitation.email,
      invitation.inviterMembershipId ?? null,
      joinedUserId,
    ).catch(() => undefined);

    return { ok: true, autoLoginToken };
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

    await this.cache.invalidateForOrg(orgId, "users:stats");

    await this.notifyDeclined(
      orgId,
      invitation.id,
      invitation.email,
      invitation.inviterMembershipId ?? null,
    ).catch(() => undefined);

    return { ok: true };
  }

  private async resolveInviterUserId(
    orgId: string,
    inviterMembershipId: number | null,
  ): Promise<string | null> {
    if (inviterMembershipId === null) return null;
    const row = await runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.id, inviterMembershipId),
          eq(organizationMembers.orgId, orgId),
        ),
        columns: { userId: true },
      }),
    );
    return row?.userId ?? null;
  }

  private async notifyAccepted(
    orgId: string,
    invitationId: string,
    email: string,
    inviterMembershipId: number | null,
    joinedUserId: string,
  ): Promise<void> {
    const inviterUserId = await this.resolveInviterUserId(orgId, inviterMembershipId);
    // Public route, so no ambient GUC; inside the callback the DRIZZLE proxy routes `this.db` to `tx`.
    const targetUserIds = (
      await runInNewTenantTransaction(this.db, orgId, () =>
        getOrgAdminRecipients(this.db, orgId, [inviterUserId]),
      )
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
    inviterMembershipId: number | null,
  ): Promise<void> {
    const inviterUserId = await this.resolveInviterUserId(orgId, inviterMembershipId);
    const targetUserIds = await runInNewTenantTransaction(this.db, orgId, () =>
      getOrgAdminRecipients(this.db, orgId, [inviterUserId]),
    );
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
