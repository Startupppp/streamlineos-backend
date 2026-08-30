import { Body, Controller, Logger, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
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
import { Validate } from "../../common/validation/validate.decorator";

@RequireModule("chat")
@Controller("chat/actions")
@UseGuards(JwtAuthGuard)
export class ChatActionsController {
  private readonly logger = new Logger(ChatActionsController.name);

  constructor(
    private readonly entities: EntityReferenceService,
    private readonly members: ChatChannelMembersService,
    private readonly chatMessages: ChatMessagesService,
  ) {}

  @Post("create-task-from-message")
  @AuthorizedInService("ChatChannelMembersService.assertChannelMembership, then EntityReferenceService resolves the actor's own access to the target")
  @Validate({ body: createTaskFromMessageSchema })
  async createTaskFromMessage(
    @Body()
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
        .catch((error: unknown) => {
          this.logger.warn("chat: system message announcement failed", {
            orgId: u.orgId,
            channelId: body.channelId,
            error: error instanceof Error ? error.message : String(error),
            cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
          });
        });

    return { ticketId, ticketNumber };
  }

  private unwrap(result: EntityActionResult): Record<string, unknown> {
    if (result.ok) return result.data;
    if (result.reason === "not-found") throw new ProjectsTicketNotFoundException();
    if (result.reason === "invalid") throw new ChatActionTicketStatusFailedException();
    throw new ChatActionForbiddenException();
  }
}
