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
import { ChatChannelMembersService } from "./chat-channel-members.service";
import { ChatTypingService } from "./chat-typing.service";
import {
  addMemberSchema,
  chatChannelFilesQuerySchema,
  createChannelSchema,
  muteChannelSchema,
  notificationPreferenceSchema,
  updateChannelSchema,
  type AddMemberInput,
  type CreateChannelInput,
  type MuteChannelInput,
  type NotificationPreferenceInput,
  type UpdateChannelInput,
} from "./dto/chat.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { actorOf } from "../entity-reference/entity-actor";

@ApiTags("Chat Channels")
@ApiBearerAuth()
@RequireModule("chat")
@Controller("chat/channels")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatChannelsController {
  constructor(
    private readonly channels: ChatChannelsService,
    private readonly members: ChatChannelMembersService,
    private readonly typing: ChatTypingService,
  ) {}

  @ApiOperation({ summary: "List channels the current user is a member of" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get()
  @RequirePermission("chat:channels:read")
  list(@CurrentUser() u: CurrentUserContext) {
    return this.channels.getMyChannels(actorOf(u));
  }

  @ApiOperation({ summary: "List archived channels for the current user" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("archived")
  @RequirePermission("chat:channels:read")
  listArchived(@CurrentUser() u: CurrentUserContext) {
    return this.channels.getArchivedChannels(actorOf(u));
  }

  @ApiOperation({ summary: "List public channels available to join" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("public")
  @RequirePermission("chat:channels:read")
  listPublic(@CurrentUser() u: CurrentUserContext) {
    return this.channels.listPublicChannels(u.orgId, u.userId);
  }

  @ApiOperation({ summary: "Get or create the entity-linked channel for a given entity" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("entity/:entityType/:entityId")
  @RequirePermission("chat:channels:read")
  getByEntity(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.getOrCreateEntityChannel(entityType, entityId, actorOf(u));
  }

  @ApiOperation({ summary: "Create a new channel or return existing DM/entity channel" })
  @ApiResponse({ status: 201, description: "Channel created" })
  @ApiResponse({ status: 200, description: "Existing channel returned" })
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

  @ApiOperation({ summary: "Get a single channel by ID" })
  @ApiResponse({ status: 200, description: "OK" })
  @ApiResponse({ status: 404, description: "Not found" })
  @Get(":channelId")
  @RequirePermission("chat:channels:read")
  async getOne(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const channel = await this.members.getChannel(channelId, u.userId, u.orgId);
    if (!channel) throw new NotFoundException("Channel not found");
    return channel;
  }

  @ApiOperation({ summary: "Update channel name, description or type" })
  @ApiResponse({ status: 200, description: "OK" })
  @Patch(":channelId")
  @RequirePermission("chat:channels:write")
  update(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body(new ZodValidationPipe(updateChannelSchema)) body: UpdateChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.updateChannel(channelId, u.userId, body, u.orgId);
  }

  @ApiOperation({ summary: "List members of a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get(":channelId/members")
  @RequirePermission("chat:channels:read")
  listMembers(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.listMembers(channelId, u.userId);
  }

  @ApiOperation({ summary: "Add a member to a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/members")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  addMember(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.addMember(channelId, body.userId, u.userId);
  }

  @ApiOperation({ summary: "Recompute an entity channel's display name" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/refresh-name")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  async refreshEntityChannelName(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ success: true }> {
    await this.channels.reconcileEntityChannelDisplayName(channelId, actorOf(u));
    return { success: true };
  }

  @ApiOperation({ summary: "Remove a member from a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Delete(":channelId/members/:userId")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  removeMember(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Param("userId") targetUserId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.removeMember(channelId, targetUserId, u.userId);
  }

  @ApiOperation({
    summary: "Join a public channel, or a record channel you can read",
  })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/join")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  join(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.joinOpenChannel(channelId, actorOf(u));
  }

  @ApiOperation({ summary: "Leave a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/leave")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  leave(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.leaveChannel(channelId, u.userId);
  }

  @ApiOperation({ summary: "Archive a channel for the current user" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/archive")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  archive(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.members.archiveChannel(channelId, u.userId);
  }

  @ApiOperation({ summary: "Unarchive a channel for the current user" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/unarchive")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  unarchive(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.members.unarchiveChannel(channelId, u.userId);
  }

  @ApiOperation({ summary: "Mark a channel as read up to now" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/read")
  @HttpCode(200)
  @RequirePermission("chat:messages:read")
  read(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.markRead(channelId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Mark a channel as unread" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/mark-unread")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  markUnread(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.members.markChannelUnread(channelId, u.userId);
  }

  @ApiOperation({ summary: "Mute a channel for the current user" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/mute")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  mute(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body(new ZodValidationPipe(muteChannelSchema)) body: MuteChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.muteChannel(channelId, u.userId, body.duration);
  }

  @ApiOperation({ summary: "Unmute a channel for the current user" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/unmute")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  unmute(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.unmuteChannel(channelId, u.userId);
  }

  @ApiOperation({ summary: "Add a channel to the current user's favorites" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/favorite")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  favorite(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.members.favoriteChannel(channelId, u.userId);
  }

  @ApiOperation({ summary: "Remove a channel from the current user's favorites" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/unfavorite")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  unfavorite(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.members.unfavoriteChannel(channelId, u.userId);
  }

  @ApiOperation({ summary: "Set the current user's notification preference for a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/notification-preference")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  setNotificationPreference(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body(new ZodValidationPipe(notificationPreferenceSchema)) body: NotificationPreferenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.setNotificationPreference(channelId, u.userId, body.preference);
  }

  @ApiOperation({ summary: "List files shared in a channel with cursor pagination" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get(":channelId/files")
  @RequirePermission("chat:messages:read")
  @Validate({ query: chatChannelFilesQuerySchema })
  listFiles(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Query("cursor") cursor: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.listChannelFiles(
      channelId,
      u.userId,
      cursor !== undefined ? parseInt(cursor, 10) : undefined,
    );
  }

  @ApiOperation({ summary: "Set current user as typing in a channel" })
  @ApiResponse({ status: 200, description: "OK" })
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

  @ApiOperation({ summary: "Get users currently typing in a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get(":channelId/typing")
  @RequirePermission("chat:messages:read")
  getTyping(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.typing.getTyping(channelId, u.userId);
  }

  @ApiOperation({ summary: "Update a channel member's role (ADMIN/MEMBER)" })
  @ApiResponse({ status: 200, description: "OK" })
  @Patch(":channelId/members/:userId/role")
  @RequirePermission("chat:channels:write")
  updateRole(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Param("userId") targetUserId: string,
    @Body(new ZodValidationPipe(z.object({ role: z.enum(["ADMIN", "MEMBER"]) }))) body: { role: string },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.updateMemberRole(channelId, targetUserId, u.userId, body.role);
  }
}
