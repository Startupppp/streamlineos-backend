import { Body, Controller, Inject, Post, UseGuards } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { projectMembers, projectStatuses, ticketActivityLog, tickets } from "../../db/schema";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ticketStatusActionSchema, type TicketStatusActionInput } from "./dto/chat.schemas";
import { AuditService } from "../../common/audit/audit.service";
import { ChatMessagesService } from "./chat-messages.service";
import {
  ChatActionForbiddenException,
  ProjectsInvalidTicketStatusException,
  ProjectsTicketNotFoundException,
} from "../../common/http/api-exceptions";

const CANONICAL_STATUSES = new Set(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]);

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

    if (!CANONICAL_STATUSES.has(body.nextStatus)) {
      const statuses = await this.db
        .select({ name: projectStatuses.name })
        .from(projectStatuses)
        .where(and(eq(projectStatuses.projectId, body.projectId), eq(projectStatuses.orgId, u.orgId)));
      const validNames = new Set(statuses.map((s) => s.name));
      if (!validNames.has(body.nextStatus)) throw new ProjectsInvalidTicketStatusException(body.nextStatus);
    }

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
}
