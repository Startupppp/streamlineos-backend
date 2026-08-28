import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ChatHuddlesService } from "./chat-huddles.service";
import {
  huddleSignalSchema,
  muteSchema,
  raiseHandSchema,
  screenShareSchema,
  kickSchema,
  type HuddleSignalInput,
  type MuteInput,
  type RaiseHandInput,
  type ScreenShareInput,
  type KickInput,
} from "./dto/huddle.schemas";
import { z } from "zod";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";

@ApiTags("Chat Huddles & Video")
@ApiBearerAuth()
@RequireModule("chat")
@Controller("chat")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatHuddlesController {
  constructor(
    private readonly huddles: ChatHuddlesService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @ApiOperation({ summary: "Start a voice huddle in a channel" })
  @ApiResponse({ status: 201, description: "Huddle started" })
  @ApiResponse({ status: 429, description: "Rate limited" })
  @Post("channels/:channelId/huddle/start")
  @HttpCode(201)
  @RequirePermission("chat:huddles:start")
  async startHuddle(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const rl = await this.rateLimit.check("chat:huddle", u.userId);
    if (!rl.allowed) throw new HttpException(`Rate limited. Retry after ${rl.retryAfterSecs}s`, HttpStatus.TOO_MANY_REQUESTS);
    return this.huddles.startHuddle(channelId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Get the currently active huddle for a channel" })
  @ApiResponse({ status: 200, description: "Active huddle or null" })
  @Get("channels/:channelId/huddle")
  @RequirePermission("chat:channels:read")
  getActiveHuddle(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.getActiveHuddle(channelId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Join an active huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("huddles/:huddleId/join")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  joinHuddle(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.joinHuddle(huddleId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Leave a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("huddles/:huddleId/leave")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  leaveHuddle(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.leaveHuddle(huddleId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Set mute state for self in a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Patch("huddles/:huddleId/mute")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  setMute(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body(new ZodValidationPipe(muteSchema)) body: MuteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.setMute(huddleId, u.userId, body.muted, u.orgId);
  }

  @ApiOperation({ summary: "Raise or lower hand in a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Patch("huddles/:huddleId/hand")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  raiseHand(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body(new ZodValidationPipe(raiseHandSchema)) body: RaiseHandInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.raiseHand(huddleId, u.userId, body.raised, u.orgId);
  }

  @ApiOperation({ summary: "Set deafen state for self in a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Patch("huddles/:huddleId/deafen")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  deafen(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body(new ZodValidationPipe(z.object({ deafened: z.boolean() }))) body: { deafened: boolean },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.setDeafen(huddleId, u.userId, u.orgId, body.deafened);
  }

  @ApiOperation({ summary: "Send a WebRTC signalling message to a peer in a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @ApiResponse({ status: 429, description: "Rate limited" })
  @Post("huddles/:huddleId/signal")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  async sendSignal(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body(new ZodValidationPipe(huddleSignalSchema)) body: HuddleSignalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const rl = await this.rateLimit.check("chat:huddle-signal", u.userId);
    if (!rl.allowed) throw new HttpException(`Rate limited. Retry after ${rl.retryAfterSecs}s`, HttpStatus.TOO_MANY_REQUESTS);
    return this.huddles.sendSignal(huddleId, u.userId, body, u.orgId);
  }

  @ApiOperation({ summary: "Heartbeat to keep a participant active in a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @ApiResponse({ status: 429, description: "Rate limited" })
  @Patch("huddles/:huddleId/heartbeat")
  @HttpCode(200)
  @RequirePermission("chat:channels:read")
  async heartbeat(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const rl = await this.rateLimit.check("chat:huddle-heartbeat", u.userId);
    if (!rl.allowed) throw new HttpException(`Rate limited. Retry after ${rl.retryAfterSecs}s`, HttpStatus.TOO_MANY_REQUESTS);
    return this.huddles.heartbeat(huddleId, u.userId);
  }

  @ApiOperation({ summary: "Toggle screen share on/off in a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Patch("huddles/:huddleId/screenshare")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  setScreenShare(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body(new ZodValidationPipe(screenShareSchema)) body: ScreenShareInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.setScreenShare(huddleId, u.userId, body.isScreenSharing, u.orgId);
  }

  @ApiOperation({ summary: "Kick a participant from a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("huddles/:huddleId/kick")
  @HttpCode(200)
  @RequirePermission("chat:huddles:moderate")
  kickParticipant(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body(new ZodValidationPipe(kickSchema)) body: KickInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.kickParticipant(huddleId, u.userId, body.targetUserId, u.orgId);
  }

  @ApiOperation({ summary: "Invite users to an active huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("huddles/:huddleId/invite")
  @Idempotent("chat.huddle.invite")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  invite(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body(new ZodValidationPipe(z.object({ userIds: z.array(z.string().min(1)).min(1) }))) body: { userIds: string[] },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.inviteToHuddle(huddleId, u.userId, u.orgId, body.userIds);
  }
}
