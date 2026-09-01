import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { supportTickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AblyService } from "../../realtime/ably.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { resolveSupportTicketsViewScope } from "./support-tickets-scope";

/**
 * Bounds the capability document. Anyone with more assigned tickets than this is an
 * agent in practice and should hold `scope: all` rather than an enormous per-ticket
 * grant — the cap is a safety valve, not a scoping rule.
 */
const MAX_SCOPED_CHANNELS = 200;

@Injectable()
export class SupportRealtimeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly ably: AblyService,
    private readonly access: AccessService,
  ) {}

  /**
   * RT-005. The Ably capability now matches the caller's DataScope rather than
   * granting the whole org. `all` keeps the wildcard — agents genuinely monitor every
   * ticket. Anything narrower gets one channel per ticket it can actually see, using
   * the same `assigneeId` predicate `listTickets` already applies. `none` gets nothing.
   */
  async createTokenRequest(u: CurrentUserContext) {
    if (!this.ably.configured) {
      throw new ServiceUnavailableException("Realtime updates are not configured");
    }

    const scope = await resolveSupportTicketsViewScope(this.access, u);
    if (scope === "all") {
      return this.ably.createSupportTokenRequest(u.userId, u.orgId, { wildcard: true });
    }
    if (scope === "none") {
      return this.ably.createSupportTokenRequest(u.userId, u.orgId, {
        wildcard: false,
        ticketIds: [],
      });
    }

    const rows = await this.db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(
        // support_tickets carries no deleted_at — the table is not soft-deleted,
        // so there is no deletion predicate to mirror from listTickets.
        and(
          eq(supportTickets.orgId, u.orgId),
          sql`${supportTickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${u.orgId} AND user_id = ${u.userId} AND status = 'ACTIVE')`,
        ),
      )
      .limit(MAX_SCOPED_CHANNELS);

    return this.ably.createSupportTokenRequest(u.userId, u.orgId, {
      wildcard: false,
      ticketIds: rows.map((r) => r.id),
    });
  }

  async publishTicketUpdated(orgId: string, ticketId: number, updatedAt: Date): Promise<void> {
    await this.ably.publishSupportTicketEvent(orgId, ticketId, "ticket-updated", {
      ticketId,
      updatedAt: updatedAt.toISOString(),
    });
  }

  async publishMessageCreated(orgId: string, ticketId: number, messageId: number): Promise<void> {
    await this.ably.publishSupportTicketEvent(orgId, ticketId, "message", { ticketId, messageId });
  }
}
