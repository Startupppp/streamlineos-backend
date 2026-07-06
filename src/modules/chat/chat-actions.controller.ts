import { Body, Controller, Inject, Post, UseGuards } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { chatChannels, chatMessages, projectMembers, projects, ticketActivityLog, tickets } from "../../db/schema";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import {
  createTaskFromMessageSchema,
  ticketStatusActionSchema,
  type CreateTaskFromMessageInput,
  type TicketStatusActionInput,
} from "./dto/chat.schemas";
import { AuditService } from "../../common/audit/audit.service";
import { ChatMessagesService } from "./chat-messages.service";
import {
  ChatActionForbiddenException,
  ChatActionTicketStatusFailedException,
  ProjectsTicketNotFoundException,
} from "../../common/http/api-exceptions";
import { resolveValidTicketStatuses } from "../projects/ticket-status.util";

@RequireModule("chat")
@Controller("chat/actions")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatActionsController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly chatMessages: ChatMessagesService,
  ) {}

  @Post("ticket-status")
  @RequirePermission("projects:tickets:update")
  async changeTicketStatus(
    @Body(new ZodValidationPipe(ticketStatusActionSchema)) body: TicketStatusActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const membership = await this.db.query.projectMembers.findFirst({
        where: and(eq(projectMembers.projectId, body.projectId), eq(projectMembers.userId, u.userId)),
        columns: { projectId: true },
      });
      if (!membership) throw new ChatActionForbiddenException();
    }

    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, body.ticketId), eq(tickets.projectId, body.projectId), eq(tickets.orgId, u.orgId)),
      columns: { id: true, status: true },
    });

    if (!ticket) throw new ProjectsTicketNotFoundException();

    if (ticket.status === body.nextStatus) {
      return { success: true, prevStatus: ticket.status, nextStatus: body.nextStatus };
    }

    const valid = await resolveValidTicketStatuses(this.db, body.projectId, u.orgId, [body.nextStatus]);
    if (!valid.has(body.nextStatus)) throw new ChatActionTicketStatusFailedException();

    await this.db
      .update(tickets)
      .set({ status: body.nextStatus, updatedAt: new Date() })
      .where(and(eq(tickets.id, body.ticketId), eq(tickets.orgId, u.orgId)));

    void this.db
      .insert(ticketActivityLog)
      .values({
        orgId: u.orgId,
        ticketId: body.ticketId,
        userId: u.userId,
        action: "status_changed",
        fromValue: ticket.status,
        toValue: body.nextStatus,
      })
      .catch(() => undefined);

    this.audit.log({
      action: "ticket.status_changed",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(body.ticketId),
      targetType: "ticket",
      metadata: { projectId: body.projectId, from: ticket.status, to: body.nextStatus },
    });

    void this.chatMessages
      .sendSystemMessage(body.channelId, u.userId, u.orgId, `Status changed from ${ticket.status} to ${body.nextStatus}`, {
        entities: [{ type: "ticket", id: String(body.ticketId), projectId: body.projectId }],
      })
      .catch(() => undefined);

    return { success: true, prevStatus: ticket.status, nextStatus: body.nextStatus };
  }

  @Post("create-task-from-message")
  @RequirePermission("projects:tickets:create")
  async createTaskFromMessage(
    @Body(new ZodValidationPipe(createTaskFromMessageSchema)) body: CreateTaskFromMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const membership = await this.db.query.projectMembers.findFirst({
        where: and(eq(projectMembers.projectId, body.projectId), eq(projectMembers.userId, u.userId)),
        columns: { projectId: true },
      });
      if (!membership) throw new ChatActionForbiddenException();
    }

    const [msgRow] = await this.db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .innerJoin(chatChannels, eq(chatMessages.channelId, chatChannels.id))
      .where(
        and(
          eq(chatMessages.id, body.messageId),
          eq(chatMessages.channelId, body.channelId),
          eq(chatChannels.orgId, u.orgId),
          eq(chatMessages.isDeleted, false),
        ),
      )
      .limit(1);

    if (!msgRow) throw new ChatActionForbiddenException();

    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, body.projectId), eq(projects.orgId, u.orgId)),
      columns: { key: true },
    });

    if (!project) throw new ChatActionForbiddenException();

    const baseContent = msgRow.content ?? "";
    const title = (body.title ?? baseContent.slice(0, 80)).trim() || "Untitled";

    const newTicket = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${body.projectId})`);

      const [maxRow] = await tx
        .select({ max: sql<number>`COALESCE(MAX(${tickets.ticketNumber}), 0)` })
        .from(tickets)
        .where(and(eq(tickets.projectId, body.projectId), eq(tickets.orgId, u.orgId)));

      const ticketNumber = (maxRow?.max ?? 0) + 1;

      const [created] = await tx
        .insert(tickets)
        .values({
          orgId: u.orgId,
          projectId: body.projectId,
          ticketNumber,
          title,
          description: msgRow.content,
          type: body.type,
          status: "TODO",
          priority: "MEDIUM",
          reporterId: u.userId,
        })
        .returning();

      return created;
    });

    this.audit.log({
      action: "ticket.created_from_message",
      userId: u.userId,
      orgId: u.orgId,
      targetId: String(newTicket.id),
      targetType: "ticket",
      metadata: { projectId: body.projectId, channelId: body.channelId, messageId: body.messageId, type: body.type },
    });

    void this.chatMessages
      .sendSystemMessage(
        body.channelId,
        u.userId,
        u.orgId,
        `Created ${body.type} ${project.key}-${newTicket.ticketNumber}: ${newTicket.title}`,
        {
          entities: [
            {
              type: "ticket",
              id: String(newTicket.id),
              projectId: body.projectId,
              ticketNumber: newTicket.ticketNumber,
              projectKey: project.key,
              title: newTicket.title,
              status: newTicket.status,
            },
          ],
        },
      )
      .catch(() => undefined);

    return { ticketId: newTicket.id, ticketNumber: newTicket.ticketNumber };
  }
}
