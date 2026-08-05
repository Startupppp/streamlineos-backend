import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import { assertMayGrantRole } from "../../../common/rbac/assert-may-grant-role";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { bustUsersStatsCache } from "../../../common/cache/bust-users-stats";
import { EmailService } from "../../email/email.service";
import { invitationEvents, invitations } from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { InviteActor } from "./invitations.service";
import { findActorMembershipId, requireActiveOrg } from "./invitations.helpers";

@Injectable()
export class InvitationLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly email: EmailService,
    private readonly access: AccessService,
  ) {}

  private readonly logger = new Logger(InvitationLifecycleService.name);

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
    if (!existingTx && updated.length > 0) {
      await bustUsersStatsCache(this.cache, orgId);
    }
    return updated.length;
  }

  /** Changes the structural role a PENDING invitation will grant. */
  async changeRole(
    orgId: string,
    invitationId: string,
    actor: InviteActor,
    role: string,
  ): Promise<{ success: true }> {
    await assertMayGrantRole(this.access, orgId, actor, role);

    const invitation = await this.db.query.invitations.findFirst({
      where: and(
        eq(invitations.id, invitationId),
        eq(invitations.orgId, orgId),
        inArray(invitations.status, ["PENDING", "EXPIRED"]),
        isNull(invitations.acceptedAt),
      ),
    });
    if (!invitation) {
      throw new NotFoundException("Invitation not found or already accepted");
    }
    if (invitation.role === role) return { success: true };

    const actorMembership = await findActorMembershipId(
      this.db,
      orgId,
      actor.userId,
    );

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const updated = await tx
          .update(invitations)
          .set({ role })
          .where(
            and(
              eq(invitations.id, invitationId),
              eq(invitations.orgId, orgId),
              eq(invitations.status, invitation.status),
              eq(invitations.role, invitation.role),
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
    actorUserId: string,
  ): Promise<{ success: true }> {
    const invitation = await this.db.query.invitations.findFirst({
      where: and(
        eq(invitations.id, invitationId),
        eq(invitations.orgId, orgId),
        inArray(invitations.status, ["PENDING", "EXPIRED"]),
        isNull(invitations.acceptedAt),
      ),
    });
    if (!invitation)
      throw new NotFoundException("Invitation not found or already accepted");

    const org = await requireActiveOrg(this.db, orgId);
    const actorMembership = await findActorMembershipId(
      this.db,
      orgId,
      actorUserId,
    );

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
          event: "REVOKED",
          actorMembershipId: actorMembership?.id ?? null,
        });
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

    await bustUsersStatsCache(this.cache, orgId);
    return { success: true };
  }
}
