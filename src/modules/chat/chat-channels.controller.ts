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
import { ChatChannelsService } from "./chat-channels.service";
import { ChatChannelMembersService } from "./chat-channel-members.service";
import { ChatTypingService } from "./chat-typing.service";
import {
  addMemberSchema,
  channelListQuerySchema,
  createChannelSchema,
  memberRoleSchema,
  muteChannelSchema,
  notificationPreferenceSchema,
  updateChannelSchema,
  type AddMemberInput,
  type ChannelListQuery,
  type CreateChannelInput,
  type MuteChannelInput,
  type NotificationPreferenceInput,
  type UpdateChannelInput,
} from "./dto/chat.schemas";
import { z } from "zod";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse, ApiOkResponse } from "@nestjs/swagger";
import { actorOf } from "../entity-reference/entity-actor";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  channelDetailSchema,
  channelFilesResponseSchema,
  channelListResponseSchema,
  channelMembersListResponseSchema,
  channelMuteResponseSchema,
  channelNotifPrefResponseSchema,
  channelOkSchema,
  channelPublicListResponseSchema,
  channelSuccessSchema,
  channelTypingResponseSchema,
} from "./dto/chat-channels-response.schemas";

const entityTypeentityIdParams = z.object({ entityType: z.string().min(1), entityId: z.string().min(1) }).strict();
const channelIdParams = z.object({ channelId: z.coerce.number().int().positive() }).strict();
const channelIduserIdParams = z.object({ channelId: z.coerce.number().int().positive(), userId: z.string().min(1) }).strict();

@ApiTags("Chat Channels")
@ApiBearerAuth()
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
  @ResponseSchema(channelListResponseSchema)
  @RequirePermission("chat:channels:read")
  @Validate({ query: channelListQuerySchema })
  list(@CurrentUser() u: CurrentUserContext, @Query() query: ChannelListQuery) {
    return this.channels.getMyChannels(actorOf(u), query.cursor, query.limit);
  }

  @ApiOperation({ summary: "List archived channels for the current user" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("archived")
  @ResponseSchema(channelListResponseSchema)
  @RequirePermission("chat:channels:read")
  @Validate({ query: channelListQuerySchema })
  listArchived(@CurrentUser() u: CurrentUserContext, @Query() query: ChannelListQuery) {
    return this.channels.getArchivedChannels(actorOf(u), query.cursor, query.limit);
  }

  @ApiOperation({ summary: "List public channels available to join" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("public")
  @ResponseSchema(channelPublicListResponseSchema)
  @RequirePermission("chat:channels:read")
  @Validate({ query: channelListQuerySchema })
  listPublic(@CurrentUser() u: CurrentUserContext, @Query() query: ChannelListQuery) {
    return this.channels.listPublicChannels(u.orgId, u.userId, query.cursor, query.limit);
  }

  @ApiOperation({ summary: "Get the entity-linked channel for a given entity, if one exists" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("entity/:entityType/:entityId")
  @ResponseSchema(channelDetailSchema.nullable())
  @RequirePermission("chat:channels:read")
  @Validate({ params: entityTypeentityIdParams })
  getByEntity(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.channels.getEntityChannel(entityType, entityId, actorOf(u));
  }

  @ApiOperation({ summary: "Create the entity-linked channel for a record, or return the existing one" })
  @ApiResponse({ status: 201, description: "Channel created" })
  @ApiOkResponse({ description: "Existing channel returned" })
  @Post("entity/:entityType/:entityId")
  @ResponseSchema(channelDetailSchema)
  @BodylessAction()
  @RequirePermission("chat:channels:write")
  @Validate({ params: entityTypeentityIdParams })
  async createByEntity(
    @Param("entityType") entityType: string,
    @Param("entityId") entityId: string,
    @CurrentUser() u: CurrentUserContext,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { channel, created } = await this.channels.createEntityChannel(
      entityType,
      entityId,
      actorOf(u),
    );
    res.status(created ? 201 : 200);
    return channel;
  }

  @ApiOperation({ summary: "Create a new channel or return existing DM/entity channel" })
  @ApiResponse({ status: 201, description: "Channel created" })
  @ApiOkResponse({ description: "Existing channel returned" })
  @ResponseSchema(channelDetailSchema)
  @Post()
  @RequirePermission("chat:channels:write")
  @Validate({ body: createChannelSchema })
  async create(
    @Body() body: CreateChannelInput,
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
  @ResponseSchema(channelDetailSchema)
  @RequirePermission("chat:channels:read")
  @Validate({ params: channelIdParams })
  async getOne(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const channel = await this.members.getChannel(channelId, actorOf(u));
    if (!channel) throw new NotFoundException("Channel not found");
    return channel;
  }

  @ApiOperation({ summary: "Update channel name, description or type" })
  @ApiResponse({ status: 200, description: "OK" })
  @Patch(":channelId")
  @ResponseSchema(channelOkSchema)
  @RequirePermission("chat:channels:write")
  @Validate({ params: channelIdParams, body: updateChannelSchema })
  update(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body() body: UpdateChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.updateChannel(channelId, u.userId, body, u.orgId);
  }

  @ApiOperation({ summary: "List members of a channel with keyset pagination" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get(":channelId/members")
  @ResponseSchema(channelMembersListResponseSchema)
  @RequirePermission("chat:channels:read")
  @Validate({ params: channelIdParams, query: channelListQuerySchema })
  listMembers(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Query() query: ChannelListQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const raw = query.cursor !== undefined ? parseInt(query.cursor, 10) : undefined;
    const cursor = typeof raw === "number" && !Number.isNaN(raw) ? raw : undefined;
    return this.members.listMembers(channelId, actorOf(u), cursor, query.limit);
  }

  @ApiOperation({ summary: "Add a member to a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/members")
  @ResponseSchema(channelOkSchema)
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: channelIdParams, body: addMemberSchema })
  addMember(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body() body: AddMemberInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.addMember(channelId, body.userId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Recompute an entity channel's display name" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/refresh-name")
  @ResponseSchema(channelSuccessSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: channelIdParams })
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
  @ResponseSchema(channelOkSchema)
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: channelIduserIdParams })
  removeMember(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Param("userId") targetUserId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.removeMember(channelId, targetUserId, u.userId, u.orgId);
  }

  @ApiOperation({
    summary: "Join a public channel, or a record channel you can read",
  })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/join")
  @ResponseSchema(channelOkSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: channelIdParams })
  join(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.joinOpenChannel(channelId, actorOf(u));
  }

  @ApiOperation({ summary: "Leave a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/leave")
  @ResponseSchema(channelOkSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: channelIdParams })
  leave(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.leaveChannel(channelId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Archive a channel for the current user" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/archive")
  @ResponseSchema(channelOkSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: channelIdParams })
  archive(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.members.archiveChannel(channelId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Unarchive a channel for the current user" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/unarchive")
  @ResponseSchema(channelOkSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: channelIdParams })
  unarchive(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.members.unarchiveChannel(channelId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Mark a channel as read up to now" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/read")
  @ResponseSchema(channelOkSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:messages:read")
  @Validate({ params: channelIdParams })
  read(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.markRead(channelId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Mark a channel as unread" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/mark-unread")
  @ResponseSchema(channelOkSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  @Validate({ params: channelIdParams })
  markUnread(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.members.markChannelUnread(channelId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Mute a channel for the current user" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/mute")
  @ResponseSchema(channelMuteResponseSchema)
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: channelIdParams, body: muteChannelSchema })
  mute(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body() body: MuteChannelInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.muteChannel(channelId, u.userId, body.duration, u.orgId);
  }

  @ApiOperation({ summary: "Unmute a channel for the current user" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/unmute")
  @ResponseSchema(channelOkSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: channelIdParams })
  unmute(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.unmuteChannel(channelId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Add a channel to the current user's favorites" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/favorite")
  @ResponseSchema(channelOkSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: channelIdParams })
  favorite(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.members.favoriteChannel(channelId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Remove a channel from the current user's favorites" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/unfavorite")
  @ResponseSchema(channelOkSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: channelIdParams })
  unfavorite(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.members.unfavoriteChannel(channelId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Set the current user's notification preference for a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/notification-preference")
  @ResponseSchema(channelNotifPrefResponseSchema)
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: channelIdParams, body: notificationPreferenceSchema })
  setNotificationPreference(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body() body: NotificationPreferenceInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.setNotificationPreference(channelId, u.userId, body.preference, u.orgId);
  }

  @ApiOperation({ summary: "List files shared in a channel with cursor pagination" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get(":channelId/files")
  @ResponseSchema(channelFilesResponseSchema)
  @RequirePermission("chat:messages:read")
  @Validate({ params: channelIdParams })
  listFiles(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Query("cursor") cursor: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.listChannelFiles(
      channelId,
      actorOf(u),
      cursor !== undefined ? parseInt(cursor, 10) : undefined,
    );
  }

  @ApiOperation({ summary: "Set current user as typing in a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":channelId/typing")
  @ResponseSchema(channelOkSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  @Validate({ params: channelIdParams })
  async setTyping(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.typing.setTyping(channelId, u.orgId, u.userId);
    return { ok: true };
  }

  @ApiOperation({ summary: "Get users currently typing in a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get(":channelId/typing")
  @ResponseSchema(channelTypingResponseSchema)
  @RequirePermission("chat:messages:read")
  @Validate({ params: channelIdParams })
  getTyping(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.typing.getTyping(channelId, u.orgId, u.userId);
  }

  @ApiOperation({ summary: "Update a channel member's role (ADMIN/MEMBER)" })
  @ApiResponse({ status: 200, description: "OK" })
  @Patch(":channelId/members/:userId/role")
  @ResponseSchema(channelOkSchema)
  @RequirePermission("chat:channels:write")
  @Validate({ params: channelIduserIdParams, body: memberRoleSchema })
  updateRole(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Param("userId") targetUserId: string,
    @Body() body: z.infer<typeof memberRoleSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.members.updateMemberRole(channelId, targetUserId, u.userId, u.orgId, body.role);
  }
}
