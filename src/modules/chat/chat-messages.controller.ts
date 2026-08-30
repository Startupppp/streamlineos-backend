import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ChatMessagesService } from "./chat-messages.service";
import { ChatMessageTimelineService } from "./chat-message-timeline.service";
import { ChatReactionsService } from "./chat-reactions.service";
import {
  editMessageSchema,
  listMessagesQuerySchema,
  pollQuerySchema,
  reactionSchema,
  sendMessageSchema,
  type EditMessageInput,
  type ListMessagesQuery,
  type PollQuery,
  type ReactionInput,
  type SendMessageInput,
} from "./dto/chat.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { actorOf } from "../entity-reference/entity-actor";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const channelIdParams = z.object({ channelId: z.coerce.number().int().positive() }).strict();
const channelAndMessageIdParams = z.object({ channelId: z.coerce.number().int().positive(), messageId: z.coerce.number().int().positive() }).strict();
const channelMessageAndEmojiParams = z.object({ channelId: z.coerce.number().int().positive(), messageId: z.coerce.number().int().positive(), emoji: z.string().min(1) }).strict();

@ApiTags("Chat Messages")
@ApiBearerAuth()
@RequireModule("chat")
@Controller("chat/channels/:channelId/messages")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatMessagesController {
  constructor(
    private readonly messages: ChatMessagesService,
    private readonly timeline: ChatMessageTimelineService,
    private readonly reactions: ChatReactionsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @ApiOperation({ summary: "List messages in a channel (cursor-paginated)" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get()
  @RequirePermission("chat:messages:read")
  @Validate({ params: channelIdParams })
  list(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Query(new ZodValidationPipe(listMessagesQuerySchema)) query: ListMessagesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timeline.list(channelId, actorOf(u), query.cursor, query.limit);
  }

  @ApiOperation({ summary: "Send a message to a channel" })
  @ApiResponse({ status: 201, description: "Message created" })
  @ApiResponse({ status: 429, description: "Rate limited" })
  @Post()
  @HttpCode(201)
  @RequirePermission("chat:messages:write")
  @Validate({ params: channelIdParams })
  async send(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body(new ZodValidationPipe(sendMessageSchema)) body: SendMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const rl = await this.rateLimit.check("chat:send-message", u.userId);
    if (!rl.allowed)
      throw new HttpException(
        `Rate limited. Retry after ${rl.retryAfterSecs}s`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    return this.messages.send(channelId, u.userId, u.orgId, body);
  }

  @ApiOperation({ summary: "Poll for new messages since a timestamp (fallback for realtime)" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("poll")
  @RequirePermission("chat:messages:read")
  @Validate({ params: channelIdParams })
  poll(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Query(new ZodValidationPipe(pollQuerySchema)) query: PollQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!query.since) throw new BadRequestException("Missing required query param: since");
    const since = new Date(query.since);
    if (Number.isNaN(since.getTime())) throw new BadRequestException("Invalid 'since' timestamp");
    return this.timeline.poll(channelId, actorOf(u), since);
  }

  @ApiOperation({ summary: "Edit message content" })
  @ApiResponse({ status: 200, description: "OK" })
  @Patch(":messageId")
  @RequirePermission("chat:messages:write")
  @Validate({ params: channelAndMessageIdParams })
  edit(
    @Param("messageId", ParseIntPipe) messageId: number,
    @Body(new ZodValidationPipe(editMessageSchema)) body: EditMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.messages.edit(messageId, u.userId, u.orgId, body.content);
  }

  @ApiOperation({ summary: "Soft-delete a message" })
  @ApiResponse({ status: 200, description: "OK" })
  @Delete(":messageId")
  @RequirePermission("chat:messages:write")
  @Validate({ params: channelAndMessageIdParams })
  remove(
    @Param("messageId", ParseIntPipe) messageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.messages.remove(messageId, u.userId, u.isOrgOwner, u.orgId);
  }

  @ApiOperation({ summary: "Add an emoji reaction to a message (idempotent)" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":messageId/reactions")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  @Validate({ params: channelAndMessageIdParams })
  addReaction(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Param("messageId", ParseIntPipe) messageId: number,
    @Body(new ZodValidationPipe(reactionSchema)) body: ReactionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reactions.addReaction(channelId, messageId, u.userId, u.orgId, body.emoji);
  }

  @ApiOperation({ summary: "Remove an emoji reaction from a message (idempotent)" })
  @ApiResponse({ status: 200, description: "OK" })
  @Delete(":messageId/reactions/:emoji")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  @Validate({ params: channelMessageAndEmojiParams })
  removeReaction(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Param("messageId", ParseIntPipe) messageId: number,
    @Param("emoji") emoji: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.reactions.removeReaction(channelId, messageId, u.userId, u.orgId, emoji);
  }

  @ApiOperation({ summary: "List thread replies for a message" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get(":messageId/thread")
  @RequirePermission("chat:messages:read")
  @Validate({ params: channelAndMessageIdParams })
  listThread(
    @Param("messageId", ParseIntPipe) messageId: number,
    @Query(new ZodValidationPipe(listMessagesQuerySchema)) query: ListMessagesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.timeline.listThreadReplies(messageId, actorOf(u), query.cursor, query.limit);
  }

  @ApiOperation({ summary: "Send a reply in a message thread" })
  @ApiResponse({ status: 201, description: "Created" })
  @Post(":messageId/thread")
  @HttpCode(201)
  @RequirePermission("chat:messages:write")
  @Validate({ params: channelAndMessageIdParams })
  sendThreadReply(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Param("messageId", ParseIntPipe) messageId: number,
    @Body(new ZodValidationPipe(sendMessageSchema)) body: SendMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.messages.sendThreadReply(channelId, messageId, u.userId, u.orgId, body);
  }
}
