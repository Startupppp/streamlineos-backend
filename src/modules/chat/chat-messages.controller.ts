import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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

@Controller("chat/channels/:channelId/messages")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatMessagesController {
  constructor(private readonly messages: ChatMessagesService) {}

  @Get()
  @RequirePermission("chat:messages:read")
  list(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Query(new ZodValidationPipe(listMessagesQuerySchema)) query: ListMessagesQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.messages.list(channelId, u.userId, query.cursor, query.limit ?? 50);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("chat:messages:write")
  send(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body(new ZodValidationPipe(sendMessageSchema)) body: SendMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.messages.send(channelId, u.userId, u.orgId, body);
  }

  @Get("poll")
  @RequirePermission("chat:messages:read")
  poll(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Query(new ZodValidationPipe(pollQuerySchema)) query: PollQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!query.since) throw new BadRequestException("Missing required query param: since");
    const since = new Date(query.since);
    if (Number.isNaN(since.getTime())) throw new BadRequestException("Invalid 'since' timestamp");
    return this.messages.poll(channelId, u.userId, since);
  }

  @Patch(":messageId")
  @RequirePermission("chat:messages:write")
  edit(
    @Param("messageId", ParseIntPipe) messageId: number,
    @Body(new ZodValidationPipe(editMessageSchema)) body: EditMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.messages.edit(messageId, u.userId, body.content);
  }

  @Delete(":messageId")
  @RequirePermission("chat:messages:write")
  remove(
    @Param("messageId", ParseIntPipe) messageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.messages.remove(messageId, u.userId, u.role);
  }

  @Post(":messageId/reactions")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  react(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Param("messageId", ParseIntPipe) messageId: number,
    @Body(new ZodValidationPipe(reactionSchema)) body: ReactionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.messages.react(channelId, messageId, u.userId, body.emoji);
  }
}
