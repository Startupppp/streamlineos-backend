import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  supportTickets,
  supportTicketExternalLinks,
  projects,
  invoices,
  calendarEvents,
  chatChannels,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateExternalLinkInput } from "./dto/support.schemas";

@Injectable()
export class SupportIntegrationsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async assertTicketExists(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
  }

  private async resolveEntityLabel(
    orgId: string,
    entityType: CreateExternalLinkInput["entityType"],
    entityId: number,
  ): Promise<string> {
    switch (entityType) {
      case "project": {
        const row = await this.db.query.projects.findFirst({
          where: and(eq(projects.id, entityId), eq(projects.orgId, orgId)),
          columns: { name: true },
        });
        if (!row) throw new NotFoundException("Project not found");
        return row.name;
      }
      case "invoice": {
        const row = await this.db.query.invoices.findFirst({
          where: and(eq(invoices.id, entityId), eq(invoices.orgId, orgId)),
          columns: { invoiceNumber: true },
        });
        if (!row) throw new NotFoundException("Invoice not found");
        return row.invoiceNumber;
      }
      case "calendar_event": {
        const row = await this.db.query.calendarEvents.findFirst({
          where: and(eq(calendarEvents.id, entityId), eq(calendarEvents.orgId, orgId)),
          columns: { title: true },
        });
        if (!row) throw new NotFoundException("Calendar event not found");
        return row.title;
      }
      case "chat_channel": {
        const row = await this.db.query.chatChannels.findFirst({
          where: and(eq(chatChannels.id, entityId), eq(chatChannels.orgId, orgId)),
          columns: { name: true },
        });
        if (!row) throw new NotFoundException("Chat channel not found");
        return row.name;
      }
      default:
        throw new BadRequestException("Unsupported entity type");
    }
  }

  async listLinks(orgId: string, ticketId: number) {
    await this.assertTicketExists(orgId, ticketId);
    return this.db.query.supportTicketExternalLinks.findMany({
      where: and(eq(supportTicketExternalLinks.orgId, orgId), eq(supportTicketExternalLinks.ticketId, ticketId)),
    });
  }

  async addLink(orgId: string, ticketId: number, userId: string, input: CreateExternalLinkInput) {
    await this.assertTicketExists(orgId, ticketId);
    const label = await this.resolveEntityLabel(orgId, input.entityType, input.entityId);

    const [link] = await this.db
      .insert(supportTicketExternalLinks)
      .values({
        orgId,
        ticketId,
        entityType: input.entityType,
        entityId: input.entityId,
        label,
        createdBy: userId,
      })
      .onConflictDoNothing()
      .returning();

    return link ?? { success: true };
  }

  async removeLink(orgId: string, ticketId: number, linkId: number) {
    await this.assertTicketExists(orgId, ticketId);
    const [deleted] = await this.db
      .delete(supportTicketExternalLinks)
      .where(
        and(
          eq(supportTicketExternalLinks.id, linkId),
          eq(supportTicketExternalLinks.orgId, orgId),
          eq(supportTicketExternalLinks.ticketId, ticketId),
        ),
      )
      .returning();
    if (!deleted) throw new NotFoundException("Link not found");
    return { success: true };
  }
}
