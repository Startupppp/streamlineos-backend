import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { supportTickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { SupportTicketsService } from "./support-tickets.service";
import type { CreatePortalMessageInput, CreatePortalTicketInput } from "./dto/support.schemas";

/**
 * Customer-portal-facing ticket access. Deliberately does NOT reuse the
 * general listTickets()/getTicket()/scope-resolution path — portal callers
 * are hard-filtered to `createdBy = userId` at the query level here, so a
 * misconfigured permission scope elsewhere can never leak another
 * customer's tickets through this surface.
 */
@Injectable()
export class SupportPortalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly tickets: SupportTicketsService,
  ) {}

  async createTicket(orgId: string, userId: string, membershipId: number | null, input: CreatePortalTicketInput) {
    return this.tickets.createTicket(
      orgId,
      userId,
      {
        title: input.title,
        category: input.category,
        description: input.description,
        customFields: input.customFields,
      },
      { channel: "portal" },
      membershipId,
    );
  }

  async listMyTickets(orgId: string, userId: string, membershipId: number | null) {
    const ownerPredicate = membershipId != null
      ? eq(supportTickets.createdByMembershipId, membershipId)
      : eq(supportTickets.createdBy, userId);
    return this.db.query.supportTickets.findMany({
      where: and(eq(supportTickets.orgId, orgId), ownerPredicate),
      orderBy: [desc(supportTickets.createdAt)],
      columns: {
        id: true,
        title: true,
        category: true,
        status: true,
        priority: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
        closedAt: true,
      },
      limit: 100,
    });
  }

  async getMyTicket(orgId: string, userId: string, membershipId: number | null, ticketId: number) {
    await this.assertOwnTicket(orgId, userId, membershipId, ticketId);
    const [ticket, messages] = await Promise.all([
      this.db.query.supportTickets.findFirst({
        where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
        columns: {
          id: true,
          title: true,
          category: true,
          description: true,
          status: true,
          priority: true,
          createdAt: true,
          updatedAt: true,
          resolvedAt: true,
          closedAt: true,
        },
      }),
      this.tickets.listPublicMessages(orgId, ticketId),
    ]);
    if (!ticket) throw new NotFoundException("Ticket not found");
    return { ...ticket, messages };
  }

  async addMessage(orgId: string, userId: string, membershipId: number | null, ticketId: number, input: CreatePortalMessageInput) {
    await this.assertOwnTicket(orgId, userId, membershipId, ticketId);
    return this.tickets.addMessage(
      orgId,
      ticketId,
      userId,
      { body: input.body, isInternal: false, attachments: input.attachments },
      { channel: "portal" },
    );
  }

  private async assertOwnTicket(orgId: string, userId: string, membershipId: number | null, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true, createdBy: true, createdByMembershipId: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    const isOwner = membershipId != null && ticket.createdByMembershipId != null
      ? ticket.createdByMembershipId === membershipId
      : ticket.createdBy === userId;
    if (!isOwner) throw new ForbiddenException("Not your ticket");
  }
}
