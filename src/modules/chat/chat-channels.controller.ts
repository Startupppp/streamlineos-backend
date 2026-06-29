import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ChatChannelsService } from "./chat-channels.service";
import { ChatTypingService } from "./chat-typing.service";
import {
  addMemberSchema,
  createChannelSchema,
  muteChannelSchema,
  updateChannelSchema,
  type AddMemberInput,
  type CreateChannelInput,
  type MuteChannelInput,
  type UpdateChannelInput,
} from "./dto/chat.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { z } from "zod";

@RequireModule("chat")
@Controller("chat/channels")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatChannelsController {
  constructor(
    private readonly channels: ChatChannelsService,
    private readonly typing: ChatTypingService,
  ) {}

  @Get()
  @RequirePermission("chat:channels:read")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.channels.getMyChannels(u.userId, u.orgId);
  }

  @Get("public")
  @RequirePermission("chat:channels:read")
  listPublic(@CurrentUser() u: CurrentUserContext) {
    return this.channels.listPublicChannels(u.orgId, u.userId);
  }

  @Get("entity/:entityType/:entityId")
  @RequirePermission("chat:channels:read")
  getByEntity(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.getOrCreateEntityChannel(entityType, entityId, u.userId, u.orgId);
  }

  @Post()
  @RequirePermission("chat:channels:write")
  async create(
    @Body(new ZodValidationPipe(createChannelSchema)) body: CreateChannelInput,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { channel, created } = await this.channels.createChannel(u.orgId, u.userId, body);
    res.status(created ? 201 : 200);
    return channel;
  }

  @Get(":channelId")
  @RequirePermission("chat:channels:read")
  async getOne(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const channel = await this.channels.getChannel(channelId, u.userId);
    if (!channel) throw new NotFoundException("Channel not found");
    return channel;
  }

  @Patch(":channelId")
  @RequirePermission("chat:channels:write")
  update(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body(new ZodValidationPipe(updateChannelSchema)) body: UpdateChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.updateChannel(channelId, u.userId, body);
  }

  @Get(":channelId/members")
  @RequirePermission("chat:channels:read")
  members(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.listMembers(channelId, u.userId);
  }

  @Post(":channelId/members")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  addMember(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.addMember(channelId, body.userId, u.userId);
  }

  @Delete(":channelId/members/:userId")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  removeMember(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Param("userId") targetUserId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.removeMember(channelId, targetUserId, u.userId);
  }

  @Post(":channelId/join")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  join(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.joinPublicChannel(channelId, u.userId);
  }

  @Post(":channelId/leave")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  leave(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.leaveChannel(channelId, u.userId);
  }

  @Post(":channelId/archive")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  archive(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.channels.archiveChannel(channelId, u.userId);
  }

  @Post(":channelId/unarchive")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  unarchive(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.channels.unarchiveChannel(channelId, u.userId);
  }

  @Post(":channelId/read")
  @HttpCode(200)
  @RequirePermission("chat:messages:read")
  read(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.markRead(channelId, u.userId);
  }

  @Post(":channelId/mark-unread")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  markUnread(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.channels.markChannelUnread(channelId, u.userId);
  }

  @Post(":channelId/mute")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  mute(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body(new ZodValidationPipe(muteChannelSchema)) body: MuteChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.muteChannel(channelId, u.userId, body.duration);
  }

  @Post(":channelId/unmute")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  unmute(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.unmuteChannel(channelId, u.userId);
  }

  @Get(":channelId/files")
  @RequirePermission("chat:messages:read")
  listFiles(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Query("cursor") cursor: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.listChannelFiles(
      channelId,
      u.userId,
      cursor !== undefined ? parseInt(cursor, 10) : undefined,
    );
  }

  @Post(":channelId/typing")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  async setTyping(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.typing.setTyping(channelId, u.userId);
    return { ok: true };
  }

  @Get(":channelId/typing")
  @RequirePermission("chat:messages:read")
  getTyping(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.typing.getTyping(channelId, u.userId);
  }

  @Patch(":channelId/members/:userId/role")
  @RequirePermission("chat:channels:write")
  updateRole(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Param("userId") targetUserId: string,
    @Body(new ZodValidationPipe(z.object({ role: z.enum(["ADMIN", "MEMBER"]) }))) body: { role: string },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.updateMemberRole(channelId, targetUserId, u.userId, body.role);
  }
}
