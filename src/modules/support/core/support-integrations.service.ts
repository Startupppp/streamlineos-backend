import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  supportTicketExternalLinks,
  projects,
  invoices,
  calendarEvents,
  chatChannels,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateExternalLinkInput } from "./dto/support.schemas";
import type { ScopedRead } from "../../access/scoped-read";
import { assertTicketInScope } from "./support-tickets-scope";

@Injectable()
export class SupportIntegrationsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async resolveEntityLabel(
    orgId: string,
    entityType: CreateExternalLinkInput["entityType"],
    entityId: number,
  ): Promise<string> {
    switch (entityType) {
      case "project": {
        const row = await this.db.query.projects.findFirst({
          where: and(eq(projects.id, entityId), eq(projects.orgId, orgId), isNull(projects.deletedAt)),
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

  async listLinks(orgId: string, ticketId: number, read: ScopedRead) {
    await assertTicketInScope(this.db, read, ticketId);
    return this.db.query.supportTicketExternalLinks.findMany({
      where: and(eq(supportTicketExternalLinks.orgId, orgId), eq(supportTicketExternalLinks.ticketId, ticketId)),
    });
  }

  async addLink(orgId: string, ticketId: number, userId: string, input: CreateExternalLinkInput, read: ScopedRead) {
    await assertTicketInScope(this.db, read, ticketId);
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

  async removeLink(orgId: string, ticketId: number, linkId: number, read: ScopedRead) {
    await assertTicketInScope(this.db, read, ticketId);
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
