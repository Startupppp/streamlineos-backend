import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import {
  supportTicketMessages,
  supportTickets,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SupportRealtimeService } from "./support-realtime.service";
import { SupportNotificationsService } from "./support-notifications.service";
import { SupportMentionsService } from "./support-mentions.service";
import { AutomationService } from "../automation/automation.service";
import { SupportTicketActivityService } from "./support-ticket-activity.service";
import type { ReplyMessageInput } from "./dto/support.schemas";

@Injectable()
export class SupportTicketMessagesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly realtime: SupportRealtimeService,
    private readonly notifications: SupportNotificationsService,
    private readonly mentions: SupportMentionsService,
    private readonly automations: AutomationService,
    private readonly activity: SupportTicketActivityService,
  ) {}

  async listMessages(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    return this.db.query.supportTicketMessages.findMany({
      where: eq(supportTicketMessages.ticketId, ticketId),
      with: { author: { columns: { id: true, name: true, image: true } } },
      orderBy: [asc(supportTicketMessages.createdAt)],
    });
  }

  async listPublicMessages(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    return this.db.query.supportTicketMessages.findMany({
      where: and(
        eq(supportTicketMessages.ticketId, ticketId),
        eq(supportTicketMessages.isInternal, false),
      ),
      with: { author: { columns: { id: true, name: true, image: true } } },
      orderBy: [asc(supportTicketMessages.createdAt)],
    });
  }

  async addMessage(
    orgId: string,
    ticketId: number,
    userId: string | null,
    input: ReplyMessageInput,
    source?: {
      channel: string;
      messageId?: string | null;
      contactEmail?: string | null;
      contactName?: string | null;
    },
  ) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)),
      columns: {
        id: true,
        status: true,
        title: true,
        createdBy: true,
        assigneeId: true,
        firstRespondedAt: true,
        priority: true,
        category: true,
      },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const [message] = await this.db
      .insert(supportTicketMessages)
      .values({
        ticketId,
        authorId: userId,
        body: input.body,
        isInternal: input.isInternal,
        attachments: input.attachments ?? [],
        sourceChannel: source?.channel ?? "web",
        sourceMessageId: source?.messageId ?? null,
        sourceContactEmail: source?.contactEmail ?? null,
        sourceContactName: source?.contactName ?? null,
      })
      .returning();

    await this.activity.recordActivity(
      orgId,
      ticketId,
      userId,
      input.isInternal ? "internal_note" : "replied",
      null,
      null,
    );

    void this.realtime.publishMessageCreated(orgId, ticketId, message.id).catch(() => undefined);

    if (input.isInternal && userId) {
      void this.db.query.users
        .findFirst({ where: eq(users.id, userId), columns: { name: true, email: true } })
        .then((author) =>
          this.mentions.processMessageMentions({
            orgId,
            ticketId,
            ticketTitle: ticket.title,
            messageId: message.id,
            content: input.body,
            authorId: userId,
            authorName: author?.name ?? author?.email ?? "A teammate",
          }),
        )
        .catch(() => undefined);
    }

    void this.automations
      .runAutomationsForEvent(orgId, "ticket.message_received", {
        ticketId: ticket.id,
        title: ticket.title,
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category ?? null,
        assigneeId: ticket.assigneeId ?? null,
        isInternal: input.isInternal,
        messageBody: input.body,
      })
      .catch(() => undefined);

    const isFirstAgentReply =
      !input.isInternal && !ticket.firstRespondedAt && userId !== null && userId !== ticket.createdBy;

    if (ticket.status === "OPEN" || isFirstAgentReply) {
      const followUp: Partial<typeof supportTickets.$inferInsert> = { updatedAt: new Date() };
      if (ticket.status === "OPEN") followUp.status = "IN_PROGRESS";
      if (isFirstAgentReply) followUp.firstRespondedAt = new Date();
      await this.db
        .update(supportTickets)
        .set(followUp)
        .where(and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId)));
    }

    if (!input.isInternal && userId) {
      void this.notifications
        .sendReplyEmail(
          { title: ticket.title, createdBy: ticket.createdBy, assigneeId: ticket.assigneeId },
          ticketId,
          userId,
          input.body,
        )
        .catch(() => undefined);
    }

    return message;
  }
}
