import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import {
  assertMayGrantRole,
} from "../../../common/rbac/assert-may-grant-role";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { EmailService } from "../../email/email.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import {
  invitationEvents,
  invitations,
} from "../../../db/schema";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import {
  cancelInvitation,
  resendInvitation,
  type InvitationMailDeps,
} from "./lib/invitation-mail-ops";
import {
  findActorMembershipId,
  openAdminInvitationFilter,
  type InviteActor,
} from "./invitations.helpers";

@Injectable()
export class InvitationLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly email: EmailService,
    private readonly seatLedger: SeatLedgerService,
    private readonly access: AccessService,
  ) {}

  private readonly logger = new Logger(InvitationLifecycleService.name);

  /** @see lib/invitation-mail-ops.ts */
  async resend(
    orgId: string,
    invitationId: string,
    actor: InviteActor,
  ): Promise<{ success: true }> {
    return resendInvitation(this.mailDeps, orgId, invitationId, actor);
  }

  /** @see lib/invitation-mail-ops.ts */
  async cancel(
    orgId: string,
    invitationId: string,
    actor: InviteActor,
  ): Promise<{ success: true }> {
    return cancelInvitation(this.mailDeps, orgId, invitationId, actor);
  }

  private get mailDeps(): InvitationMailDeps {
    return {
      db: this.db,
      audit: this.audit,
      cache: this.cache,
      email: this.email,
      seatLedger: this.seatLedger,
      access: this.access,
      logger: this.logger,
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
