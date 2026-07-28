import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  supportTicketLinks,
  supportTickets,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { SupportTicketActivityService } from "./support-ticket-activity.service";
import type {
  CreateTicketLinkInput,
  MergeTicketInput,
  SnoozeTicketInput,
} from "./dto/support.schemas";

@Injectable()
export class SupportTicketOperationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly activity: SupportTicketActivityService,
  ) {}

  private async assertTicketExists(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
  }

  private async invalidateTicketCaches(orgId: string) {
    await this.cache.invalidatePattern(`support:tickets:${orgId}:*`);
    await this.cache.invalidate(CACHE_KEYS.supportDashboard(orgId));
    await this.cache.invalidate(CACHE_KEYS.ceDashboard(orgId));
  }

  async addTicketLink(orgId: string, ticketId: number, userId: string, input: CreateTicketLinkInput) {
    if (input.linkedTicketId === ticketId) {
      throw new BadRequestException("A ticket cannot be linked to itself");
    }

    const [ticket, linkedTicket] = await Promise.all([
      this.db.query.supportTickets.findFirst({
        where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
        columns: { id: true },
      }),
      this.db.query.supportTickets.findFirst({
        where: and(eq(supportTickets.id, input.linkedTicketId), eq(supportTickets.orgId, orgId)),
        columns: { id: true },
      }),
    ]);
    if (!ticket) throw new NotFoundException("Ticket not found");
    if (!linkedTicket) throw new NotFoundException("Linked ticket not found");

    const [link] = await this.db
      .insert(supportTicketLinks)
      .values({
        orgId,
        ticketId,
        linkedTicketId: input.linkedTicketId,
        relation: input.relation,
        createdBy: userId,
      })
      .onConflictDoNothing()
      .returning();

    await this.activity.recordActivity(orgId, ticketId, userId, "linked", null, String(input.linkedTicketId));

    return link ?? { success: true };
  }

  async listTicketLinks(orgId: string, ticketId: number) {
    await this.assertTicketExists(orgId, ticketId);
    return this.db.query.supportTicketLinks.findMany({
      where: and(eq(supportTicketLinks.orgId, orgId), eq(supportTicketLinks.ticketId, ticketId)),
      with: { linkedTicket: { columns: { id: true, title: true, status: true } } },
    });
  }

  async mergeTicket(orgId: string, ticketId: number, userId: string, input: MergeTicketInput) {
    if (input.intoTicketId === ticketId) {
      throw new BadRequestException("A ticket cannot be merged into itself");
    }

    const [ticket, targetTicket] = await Promise.all([
      this.db.query.supportTickets.findFirst({
        where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
        columns: { id: true, status: true, mergedIntoTicketId: true },
      }),
      this.db.query.supportTickets.findFirst({
        where: and(eq(supportTickets.id, input.intoTicketId), eq(supportTickets.orgId, orgId)),
        columns: { id: true },
      }),
    ]);
    if (!ticket) throw new NotFoundException("Ticket not found");
    if (!targetTicket) throw new NotFoundException("Target ticket not found");
    if (ticket.mergedIntoTicketId) {
      throw new ConflictException("This ticket has already been merged into another ticket");
    }

    await this.db
      .update(supportTickets)
      .set({ mergedIntoTicketId: input.intoTicketId, status: "CLOSED", closedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));

    await this.activity.recordActivity(orgId, ticketId, userId, "merged", ticket.status, String(input.intoTicketId));
    await this.invalidateTicketCaches(orgId);

    return { success: true, mergedIntoTicketId: input.intoTicketId };
  }

  async snoozeTicket(orgId: string, ticketId: number, userId: string, input: SnoozeTicketInput) {
    await this.assertTicketExists(orgId, ticketId);

    await this.db
      .update(supportTickets)
      .set({ snoozedUntil: input.snoozedUntil, snoozedBy: userId, updatedAt: new Date() })
      .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));

    await this.activity.recordActivity(orgId, ticketId, userId, "snoozed", null, input.snoozedUntil.toISOString());
    await this.invalidateTicketCaches(orgId);

    return { success: true, snoozedUntil: input.snoozedUntil };
  }

  async unsnoozeTicket(orgId: string, ticketId: number, userId: string) {
    await this.assertTicketExists(orgId, ticketId);

    await this.db
      .update(supportTickets)
      .set({ snoozedUntil: null, snoozedBy: null, updatedAt: new Date() })
      .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));

    await this.activity.recordActivity(orgId, ticketId, userId, "unsnoozed", null, null);
    await this.invalidateTicketCaches(orgId);

    return { success: true };
  }

  async unsnoozeExpiredTickets(): Promise<{ unsnoozed: number }> {
    const result = await this.db
      .update(supportTickets)
      .set({ snoozedUntil: null, snoozedBy: null, updatedAt: new Date() })
      .where(sql`${supportTickets.snoozedUntil} IS NOT NULL AND ${supportTickets.snoozedUntil} <= now()`)
      .returning({ id: supportTickets.id, orgId: supportTickets.orgId });

    const orgIds = new Set(result.map((r) => r.orgId));
    await Promise.all(Array.from(orgIds).map((orgId) => this.invalidateTicketCaches(orgId)));

    return { unsnoozed: result.length };
  }
}
