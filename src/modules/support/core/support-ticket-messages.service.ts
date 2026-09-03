import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import {
  supportTicketMessages,
  supportTicketAttachments,
  supportTickets,
  organizationMembers,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { SupportRealtimeService } from "./support-realtime.service";
import { SupportNotificationsService } from "./support-notifications.service";
import { SupportMentionsService } from "./support-mentions.service";
import { AutomationService } from "../../automation/automation.service";
import { SupportTicketActivityService } from "./support-ticket-activity.service";
import type { ReplyMessageInput } from "./dto/support.schemas";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";

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
      with: {
        author: { columns: { id: true, name: true, image: true } },
        attachments: { columns: { id: true, fileName: true, fileUrl: true, fileSize: true, mimeType: true } },
      },
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
      with: {
        author: { columns: { id: true, name: true, image: true } },
        attachments: { columns: { id: true, fileName: true, fileUrl: true, fileSize: true, mimeType: true } },
      },
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
        createdByMembershipId: true,
        assigneeMembershipId: true,
        firstRespondedAt: true,
        priority: true,
        category: true,
      },
      with: {
        creatorMembership: { columns: { id: true }, with: { user: { columns: { id: true } } } },
        assigneeMembership: { columns: { id: true }, with: { user: { columns: { id: true } } } },
      },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const message = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(supportTicketMessages)
        .values({
          orgId,
          ticketId,
          authorId: userId,
          body: input.body,
          isInternal: input.isInternal,
          sourceChannel: source?.channel ?? "web",
          sourceMessageId: source?.messageId ?? null,
          sourceContactEmail: source?.contactEmail ?? null,
          sourceContactName: source?.contactName ?? null,
        })
        .returning();

      if (!created) throw new Error("Failed to create message");

      if (input.attachments && input.attachments.length > 0) {
        await tx.insert(supportTicketAttachments).values(
          input.attachments.map((a) => ({
            orgId,
            messageId: created.id,
            fileName: a.fileName,
            fileUrl: a.fileUrl,
            fileSize: a.fileSize,
            mimeType: a.mimeType,
          })),
        );
      }

      return created;
    });

    await this.activity.recordActivity(
      orgId,
      ticketId,
      userId,
      input.isInternal ? "internal_note" : "replied",
      null,
      null,
    );

    void this.realtime.publishMessageCreated(orgId, ticketId, message.id).catch(logSideEffectFailure("support realtime message-created publish", { orgId, ticketId }));

    if (input.isInternal && userId) {
      const mentionTask = async () => {
        const author = await this.db.query.users
          .findFirst({ where: eq(users.id, userId), columns: { name: true, email: true } });
        await this.mentions.processMessageMentions({
          orgId,
          ticketId,
          ticketTitle: ticket.title,
          messageId: message.id,
          content: input.body,
          authorId: userId,
          authorName: author?.name ?? author?.email ?? "A teammate",
        });
      };
      if (!registerAfterCommit(() => mentionTask().catch(logSideEffectFailure("support message notification", { orgId, ticketId }))))
        void mentionTask().catch(logSideEffectFailure("support message notification", { orgId, ticketId }));
    }

    const automationPayload = {
      ticketId: ticket.id,
      title: ticket.title,
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category ?? null,
      assigneeId: ticket.assigneeMembership?.user?.id ?? null,
      isInternal: input.isInternal,
      messageBody: input.body,
    };
    const automationTask = () =>
      this.automations
        .runAutomationsForEvent(orgId, "ticket.message_received", automationPayload)
        .catch(logSideEffectFailure("support message email", { orgId, ticketId }));
    if (!registerAfterCommit(automationTask)) void automationTask();

    const isFirstAgentReply =
      !input.isInternal && !ticket.firstRespondedAt && userId !== null && userId !== ticket.creatorMembership?.user?.id;

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
      const replyTask = () =>
        this.notifications
          .sendReplyEmail(
            orgId,
            {
              title: ticket.title,
              createdBy: ticket.creatorMembership?.user?.id ?? null,
              assigneeId: ticket.assigneeMembership?.user?.id ?? null,
            },
            ticketId,
            userId,
            input.body,
          )
          .catch(logSideEffectFailure("support automations on message", { orgId, ticketId }));
      if (!registerAfterCommit(replyTask)) void replyTask();
    }

    return message;
  }
}
