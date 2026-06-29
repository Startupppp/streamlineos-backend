import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  TooManyRequestsException,
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
  cameraSchema,
  screenShareSchema,
  kickSchema,
  type HuddleSignalInput,
  type MuteInput,
  type RaiseHandInput,
  type CameraInput,
  type ScreenShareInput,
  type KickInput,
} from "./dto/huddle.schemas";
import { videoSignalSchema, type VideoSignalInput } from "./dto/video.schemas";
import { z } from "zod";
import { RateLimitService } from "../../common/ratelimit/rate-limit.service";
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
  @RequirePermission("chat:channels:write")
  async startHuddle(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const rl = await this.rateLimit.check("chat:huddle", u.userId);
    if (!rl.allowed) throw new TooManyRequestsException(`Rate limited. Retry after ${rl.retryAfterSecs}s`);
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
    return this.huddles.getActiveHuddle(channelId, u.userId);
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
  @Post("huddles/:huddleId/signal")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  sendSignal(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body(new ZodValidationPipe(huddleSignalSchema)) body: HuddleSignalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.sendSignal(huddleId, u.userId, body, u.orgId);
  }

  @ApiOperation({ summary: "Start a video meeting in a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("channels/:channelId/meeting/start")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  startMeeting(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.startVideoMeeting(channelId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Send a WebRTC signalling message to a peer in a video meeting" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("huddles/:huddleId/meeting-signal")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  meetingSignal(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body(new ZodValidationPipe(videoSignalSchema)) body: VideoSignalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.sendMeetingSignal(huddleId, u.userId, u.orgId, body.targetUserId, body.type, body.payload);
  }

  @ApiOperation({ summary: "Toggle camera on/off in a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Patch("huddles/:huddleId/camera")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  setCameraState(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body(new ZodValidationPipe(cameraSchema)) body: CameraInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.setCameraState(huddleId, u.userId, body.isCameraOff, u.orgId);
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
  @RequirePermission("chat:channels:write")
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
