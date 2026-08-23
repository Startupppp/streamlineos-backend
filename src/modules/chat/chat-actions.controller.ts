import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import {
  createTaskFromMessageSchema,
  type CreateTaskFromMessageInput,
} from "./dto/chat.schemas";
import { ChatMessagesService } from "./chat-messages.service";
import { ChatChannelMembersService } from "./chat-channel-members.service";
import {
  ChatActionForbiddenException,
  ChatActionTicketStatusFailedException,
  ProjectsTicketNotFoundException,
} from "../../common/http/api-exceptions";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import { actorOf } from "../entity-reference/entity-actor";
import type { EntityActionResult } from "../entity-reference/entity-reference.types";

/**
 * What is left after the generic entity-action route took the rest: turning a
 * chat message into a record is chat-specific, because the server reads the
 * message's own text to fill the new record's description and the seam has no
 * business knowing what a chat message is.
 *
 * The three routes that were pure entity actions — status, assign, due date —
 * are gone. They carried `build:tickets:*` keys, which on a route the seam
 * serves could only ever exclude the modules the seam exists to include.
 */
@RequireModule("chat")
@Controller("chat/actions")
@UseGuards(JwtAuthGuard)
export class ChatActionsController {
  constructor(
    private readonly entities: EntityReferenceService,
    private readonly members: ChatChannelMembersService,
    private readonly chatMessages: ChatMessagesService,
  ) {}

  @Post("create-task-from-message")
  async createTaskFromMessage(
    @Body(new ZodValidationPipe(createTaskFromMessageSchema))
    body: CreateTaskFromMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.members.assertChannelMembership(body.channelId, u.userId);

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

    if (result.ok && result.message)
      void this.chatMessages
        .sendSystemMessage(body.channelId, u.userId, u.orgId, result.message, {
          entities: [{ type: "ticket", id: String(ticketId) }],
        })
        .catch(() => undefined);

    return { ticketId, ticketNumber };
  }

  private unwrap(result: EntityActionResult): Record<string, unknown> {
    if (result.ok) return result.data;
    if (result.reason === "not-found") throw new ProjectsTicketNotFoundException();
    if (result.reason === "invalid") throw new ChatActionTicketStatusFailedException();
    throw new ChatActionForbiddenException();
  }
}
