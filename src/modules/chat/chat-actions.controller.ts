import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import {
  assignTicketFromChatSchema,
  createTaskFromMessageSchema,
  setDueDateFromChatSchema,
  ticketStatusActionSchema,
  type AssignTicketFromChatInput,
  type CreateTaskFromMessageInput,
  type SetDueDateFromChatInput,
  type TicketStatusActionInput,
} from "./dto/chat.schemas";
import { ChatMessagesService } from "./chat-messages.service";
import {
  ChatActionForbiddenException,
  ChatActionTicketStatusFailedException,
  ProjectsTicketNotFoundException,
} from "../../common/http/api-exceptions";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import { actorOf } from "../entity-reference/entity-actor";
import type {
  EntityActionResult,
  EntityReference,
} from "../entity-reference/entity-reference.types";

@RequireModule("chat")
@Controller("chat/actions")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatActionsController {
  constructor(
    private readonly entities: EntityReferenceService,
    private readonly chatMessages: ChatMessagesService,
  ) {}

  private unwrap(result: EntityActionResult): Record<string, unknown> {
    if (result.ok) return result.data;
    if (result.reason === "not-found") throw new ProjectsTicketNotFoundException();
    if (result.reason === "invalid") throw new ChatActionTicketStatusFailedException();
    throw new ChatActionForbiddenException();
  }

  private announce(
    channelId: number,
    u: CurrentUserContext,
    result: EntityActionResult,
    reference: EntityReference,
  ): void {
    if (!result.ok || !result.message) return;
    void this.chatMessages
      .sendSystemMessage(channelId, u.userId, u.orgId, result.message, {
        entities: [reference],
      })
      .catch(() => undefined);
  }

  @Post("ticket-status")
  @RequirePermission("build:tickets:update")
  async changeTicketStatus(
    @Body(new ZodValidationPipe(ticketStatusActionSchema)) body: TicketStatusActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const reference = { type: "ticket", id: String(body.ticketId) };
    const result = await this.entities.submitAction(
      actorOf(u),
      reference,
      "status",
      { status: body.nextStatus },
    );
    const data = this.unwrap(result);
    this.announce(body.channelId, u, result, reference);
    return { success: true, ...data };
  }

  @Post("create-task-from-message")
  @RequirePermission("build:tickets:create")
  async createTaskFromMessage(
    @Body(new ZodValidationPipe(createTaskFromMessageSchema)) body: CreateTaskFromMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const source = await this.chatMessages.readMessageContent(
      body.messageId,
      body.channelId,
      u.orgId,
    );
    if (source === null) throw new ChatActionForbiddenException();

    const result = await this.entities.submitAction(
      actorOf(u),
      { type: "project", id: String(body.projectId) },
      "create-ticket",
      { type: body.type, title: body.title, description: source },
    );
    const data = this.unwrap(result);
    const ticketId = Number(data["ticketId"]);
    const ticketNumber = Number(data["ticketNumber"]);
    this.announce(body.channelId, u, result, {
      type: "ticket",
      id: String(ticketId),
    });
    return { ticketId, ticketNumber };
  }

  @Post("assign-ticket")
  @RequirePermission("build:tickets:assign")
  async assignTicket(
    @Body(new ZodValidationPipe(assignTicketFromChatSchema)) body: AssignTicketFromChatInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const reference = { type: "ticket", id: String(body.ticketId) };
    const result = await this.entities.submitAction(
      actorOf(u),
      reference,
      "assign",
      { assigneeId: body.assigneeId },
    );
    this.unwrap(result);
    this.announce(body.channelId, u, result, reference);
    return { success: true };
  }

  @Post("set-due-date")
  @RequirePermission("build:tickets:update")
  async setDueDate(
    @Body(new ZodValidationPipe(setDueDateFromChatSchema)) body: SetDueDateFromChatInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const reference = { type: "ticket", id: String(body.ticketId) };
    const result = await this.entities.submitAction(
      actorOf(u),
      reference,
      "due-date",
      { dueDate: body.dueDate },
    );
    this.unwrap(result);
    this.announce(body.channelId, u, result, reference);
    return { success: true };
  }
}
