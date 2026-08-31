import { Inject, Injectable } from "@nestjs/common";
import { and, eq, lt } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { invitations } from "../../db/schema";
import { forEachOrg } from "../../common/tenant";
import { SeatLedgerService } from "../billing/core/seat-ledger.service";

@Injectable()
export class CronInvitationExpiryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly seatLedger: SeatLedgerService,
  ) {}

  async sweepExpiredInvitations(): Promise<{ expired: number }> {
    let expired = 0;

    await forEachOrg(this.db, "invitation-expiry-sweep", async (tx, orgId) => {
      const now = new Date();

      const transitioned = await tx
        .update(invitations)
        .set({ status: "EXPIRED" })
        .where(
          and(
            eq(invitations.orgId, orgId),
            eq(invitations.status, "PENDING"),
            lt(invitations.expiresAt, now),
          ),
        )
        .returning({ id: invitations.id });

      for (const inv of transitioned) {
        await this.seatLedger.recordSeatEvent(
          {
            orgId,
            eventType: "INVITE_EXPIRED",
            subjectId: inv.id,
            reason: "invitation-expiry-sweep",
            idempotencyKey: `invite-expired:${inv.id}`,
          },
          tx,
        );
        expired += 1;
      }
    });

    return { expired };
  }
}
