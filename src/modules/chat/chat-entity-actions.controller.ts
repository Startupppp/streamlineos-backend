import { Body, Controller, Logger, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { AuthorizedInService } from "../../common/auth/authorized-in-service.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import {
  entityActionOptionsSchema,
  entityActionsAvailableSchema,
  submitEntityActionSchema,
  type EntityActionOptionsInput,
  type EntityActionsAvailableInput,
  type SubmitEntityActionInput,
} from "./dto/chat.schemas";
import { ChatChannelMembersService } from "./chat-channel-members.service";
import { ChatMessagesService } from "./chat-messages.service";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import { actorOf } from "../entity-reference/entity-actor";
import {
  ChatActionForbiddenException,
  ChatActionTicketStatusFailedException,
  ProjectsTicketNotFoundException,
} from "../../common/http/api-exceptions";
import type {
  EntityActionResult,
  EntityReference,
} from "../entity-reference/entity-reference.types";
import { Validate } from "../../common/validation/validate.decorator";

@Controller("chat/entity-actions")
@UseGuards(JwtAuthGuard)
export class ChatEntityActionsController {
  private readonly logger = new Logger(ChatEntityActionsController.name);

  constructor(
    private readonly entities: EntityReferenceService,
    private readonly members: ChatChannelMembersService,
    private readonly chatMessages: ChatMessagesService,
  ) {}

  @Post("available")
  @AuthorizedInService("ChatChannelMembersService.assertChannelMembership, then EntityReferenceService resolves the actor's own access to the target")
  @Validate({ body: entityActionsAvailableSchema })
  async availableActions(
    @Body()
    body: EntityActionsAvailableInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.members.assertChannelMembership(body.channelId, u.userId, u.orgId);

    const actions = await this.entities.actionsFor(actorOf(u), [
      ...body.references,
    ]);

    return {
      references: body.references.map((reference, index) => ({
        reference,
        actions: actions[index] ?? [],
      })),
    };
  }

  @Post("options")
  @AuthorizedInService("ChatChannelMembersService.assertChannelMembership, then EntityReferenceService resolves the actor's own access to the target")
  @Validate({ body: entityActionOptionsSchema })
  async actionOptions(
    @Body()
    body: EntityActionOptionsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.members.assertChannelMembership(body.channelId, u.userId, u.orgId);

    return { options: await this.entities.optionsFor(actorOf(u), body.reference) };
  }

  @Post("submit")
  @Idempotent("chat.action.submit")
  @AuthorizedInService("ChatChannelMembersService.assertChannelMembership, then EntityReferenceService resolves the actor's own access to the target")
  @Validate({ body: submitEntityActionSchema })
  async submitAction(
    @Body()
    body: SubmitEntityActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.members.assertChannelMembership(body.channelId, u.userId, u.orgId);

    const result = await this.entities.submitAction(
      actorOf(u),
      body.reference,
      body.actionId,
      body.input,
    );
    const data = this.unwrap(result);
    this.announce(body.channelId, u, result, body.reference);
    return { success: true, ...data };
  }

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
      .catch((error: unknown) => {
        this.logger.warn("chat: entity action announcement failed", {
          orgId: u.orgId,
          channelId,
          error: error instanceof Error ? error.message : String(error),
          cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
        });
      });
  }
}
