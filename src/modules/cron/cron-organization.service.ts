import { Inject, Injectable } from "@nestjs/common";
import { and, eq, lt } from "drizzle-orm";
import { invitationEvents, invitations, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";

interface ExpiredInvitation {
  id: string;
  orgId: string;
  email: string;
  inviterMembershipId: number | null;
}

@Injectable()
export class CronOrganizationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async expireStaleInvitations(): Promise<{ expired: number }> {
    const now = new Date();
    const expiredRows: ExpiredInvitation[] = [];

    await forEachOrg(this.db, "org-expire-invitations", async (tx, orgId) => {
      const result = await tx
        .update(invitations)
        .set({ status: "EXPIRED" })
        .where(
          and(
            eq(invitations.orgId, orgId),
            eq(invitations.status, "PENDING"),
            lt(invitations.expiresAt, now),
          ),
        )
        .returning({
          id: invitations.id,
          email: invitations.email,
          inviterMembershipId: invitations.inviterMembershipId,
        });
      if (result.length === 0) return;

      await tx.insert(invitationEvents).values(
        result.map((row) => ({
          orgId,
          invitationId: row.id,
          event: "EXPIRED" as const,
          actorMembershipId: null,
        })),
      );

      for (const row of result) {
        expiredRows.push({ ...row, orgId });
      }
    });

    for (const row of expiredRows) {
      if (!row.inviterMembershipId) continue;
      const inviter = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.id, row.inviterMembershipId),
          eq(organizationMembers.orgId, row.orgId),
        ),
        columns: { userId: true },
      });
      if (!inviter) continue;
      void this.dispatch
        .emit({
          eventKey: "organization.invitation.expired",
          orgId: row.orgId,
          targetUserIds: [inviter.userId],
          entityType: "invitation",
          entityId: row.id,
          title: "Invitation expired",
          message: `The invitation you sent to ${row.email} expired before it was accepted. You can send a new one from Users.`,
          link: "/users",
        })
        .catch(() => undefined);
    }

    return { expired: expiredRows.length };
  }
}
