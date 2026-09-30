import { Body, Controller, Logger, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  createTaskFromMessageSchema,
  type CreateTaskFromMessageInput,
} from "./dto/chat.schemas";
import { ChatMessagesService } from "./chat-messages.service";
import { ChatChannelMembersImplementation } from "./chat-channel-members-implementation";
import {
  ChatActionForbiddenException,
  ChatActionTicketStatusFailedException,
  ProjectsTicketNotFoundException,
} from "../../common/http/api-exceptions";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import { actorOf } from "../entity-reference/entity-actor";
import type { EntityActionResult } from "../entity-reference/entity-reference.types";
import { Validate } from "../../common/validation/validate.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { chatCreateTaskSchema } from "./dto/chat-misc-response.schemas";

@Controller("chat/actions")
@UseGuards(JwtAuthGuard)
export class ChatActionsController {
  private readonly logger = new Logger(ChatActionsController.name);

  constructor(
    private readonly entities: EntityReferenceService,
    private readonly members: ChatChannelMembersImplementation,
    private readonly chatMessages: ChatMessagesService,
  ) {}

  @Post("create-task-from-message")
  @ResponseSchema(chatCreateTaskSchema)
  @Idempotent("chat.action.create-task-from-message")
  @AuthorizedInService("ChatChannelMembersImplementation.assertChannelMembership, then EntityReferenceService resolves the actor's own access to the target")
  @Validate({ body: createTaskFromMessageSchema })
  async createTaskFromMessage(
    @Body()
    body: CreateTaskFromMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.members.assertChannelMembership(body.channelId, actorOf(u));

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
      {
        type: body.type,
        title: body.title,
        description: source,
        sourceChannelId: body.channelId,
        sourceMessageId: body.messageId,
      },
    );
    const data = this.unwrap(result);
    const ticketId = Number(data["ticketId"]);
    const ticketNumber = Number(data["ticketNumber"]);

    await this.chatMessages.attachEntity(body.messageId, body.channelId, u.orgId, {
      type: "ticket",
      id: String(ticketId),
    });

    // Awaited, not `void`: a detached call keeps using this request's transaction
    // after it commits, where its queries never settle and nothing is logged.
    if (result.ok && result.message)
      await this.chatMessages
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
