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
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ChatHuddlesService } from "./chat-huddles.service";
import { ChatHuddleSignalsService } from "./chat-huddle-signals.service";
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
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const channelIdParams = z.object({ channelId: z.coerce.number().int().positive() }).strict();
const huddleIdParams = z.object({ huddleId: z.coerce.number().int().positive() }).strict();

@ApiTags("Chat Huddles & Video")
@ApiBearerAuth()
@RequireModule("chat")
@Controller("chat")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatHuddlesController {
  constructor(
    private readonly huddles: ChatHuddlesService,
    private readonly signals: ChatHuddleSignalsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @ApiOperation({ summary: "Start a voice huddle in a channel" })
  @ApiResponse({ status: 201, description: "Huddle started" })
  @ApiResponse({ status: 429, description: "Rate limited" })
  @Post("channels/:channelId/huddle/start")
  @BodylessAction()
  @HttpCode(201)
  @RequirePermission("chat:huddles:start")
  @Validate({ params: channelIdParams })
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
  @Validate({ params: channelIdParams })
  getActiveHuddle(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.getActiveHuddle(channelId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Join an active huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("huddles/:huddleId/join")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: huddleIdParams })
  joinHuddle(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.joinHuddle(huddleId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Leave a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("huddles/:huddleId/leave")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: huddleIdParams })
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
  @Validate({ params: huddleIdParams, body: muteSchema })
  setMute(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body() body: MuteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.signals.setMute(huddleId, u.userId, body.muted, u.orgId);
  }

  @ApiOperation({ summary: "Raise or lower hand in a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Patch("huddles/:huddleId/hand")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  @Validate({ params: huddleIdParams, body: raiseHandSchema })
  raiseHand(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body() body: RaiseHandInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.signals.raiseHand(huddleId, u.userId, body.raised, u.orgId);
  }

  @ApiOperation({ summary: "Set deafen state for self in a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Patch("huddles/:huddleId/deafen")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: huddleIdParams, body: z.object({ deafened: z.boolean() }) })
  deafen(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body() body: { deafened: boolean },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.signals.setDeafen(huddleId, u.userId, u.orgId, body.deafened);
  }

  @ApiOperation({ summary: "Send a WebRTC signalling message to a peer in a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @ApiResponse({ status: 429, description: "Rate limited" })
  @Post("huddles/:huddleId/signal")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  @Validate({ params: huddleIdParams, body: huddleSignalSchema })
  async sendSignal(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body() body: HuddleSignalInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const rl = await this.rateLimit.check("chat:huddle-signal", u.userId);
    if (!rl.allowed) throw new HttpException(`Rate limited. Retry after ${rl.retryAfterSecs}s`, HttpStatus.TOO_MANY_REQUESTS);
    return this.signals.sendSignal(huddleId, u.userId, body, u.orgId);
  }

  @ApiOperation({ summary: "Heartbeat to keep a participant active in a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @ApiResponse({ status: 429, description: "Rate limited" })
  @Patch("huddles/:huddleId/heartbeat")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:channels:read")
  @Validate({ params: huddleIdParams })
  async heartbeat(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const rl = await this.rateLimit.check("chat:huddle-heartbeat", u.userId);
    if (!rl.allowed) throw new HttpException(`Rate limited. Retry after ${rl.retryAfterSecs}s`, HttpStatus.TOO_MANY_REQUESTS);
    return this.signals.heartbeat(huddleId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Toggle screen share on/off in a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Patch("huddles/:huddleId/screenshare")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  @Validate({ params: huddleIdParams, body: screenShareSchema })
  setScreenShare(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body() body: ScreenShareInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.signals.setScreenShare(huddleId, u.userId, body.isScreenSharing, u.orgId);
  }

  @ApiOperation({ summary: "Kick a participant from a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("huddles/:huddleId/kick")
  @HttpCode(200)
  @RequirePermission("chat:huddles:moderate")
  @Validate({ params: huddleIdParams, body: kickSchema })
  kickParticipant(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body() body: KickInput,
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
  @Validate({ params: huddleIdParams, body: z.object({ userIds: z.array(z.string().min(1)).min(1) }) })
  invite(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body() body: { userIds: string[] },
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.inviteToHuddle(huddleId, u.userId, u.orgId, body.userIds);
  }
}
