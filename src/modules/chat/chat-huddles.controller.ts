import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { NoTenantTransaction } from "../../common/tenant/no-tenant-transaction.decorator";
import { ChatHuddlesService } from "./chat-huddles.service";
import { ChatHuddleSignalsService } from "./chat-huddle-signals.service";
import {
  kickSchema,
  huddleInviteSchema,
  type KickInput,
  type HuddleInviteInput,
} from "./dto/huddle.schemas";
import { z } from "zod";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import {
  chatOkSchema,
  huddleWireNullableSchema,
  huddleWireSchema,
} from "./dto/chat-misc-response.schemas";

const channelIdParams = z.object({ channelId: z.coerce.number().int().positive() }).strict();
const huddleIdParams = z.object({ huddleId: z.coerce.number().int().positive() }).strict();

@ApiTags("Chat Huddles & Video")
@ApiBearerAuth()
@Controller("chat")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatHuddlesController {
  constructor(
    private readonly huddles: ChatHuddlesService,
    private readonly signals: ChatHuddleSignalsService,
  ) {}

  @ApiOperation({ summary: "Start a huddle in a channel and mint its Google Meet link" })
  @ApiResponse({ status: 201, description: "Huddle started" })
  @ApiResponse({ status: 429, description: "Rate limited" })
  @ApiResponse({
    status: 412,
    description:
      "Organization precondition an owner or admin must fix, never a retry: no Google account is connected, or the connected one needs reconnecting.",
  })
  @ApiResponse({
    status: 503,
    description:
      "Transient or server-side: Composio is unconfigured for this deployment, Google refused or timed out, or Google returned no join link. Nothing was started.",
  })
  @Post("channels/:channelId/huddle/start")
  @ResponseSchema(huddleWireSchema)
  @BodylessAction()
  @HttpCode(201)
  // Minting the Meet link is a third-party call; the ambient request transaction would hold a
  // pooled connection for the length of a Google outage, so the service opens its own instead.
  @NoTenantTransaction()
  @UseGuards(RateLimitGuard)
  @UseRateLimit("chat:huddle")
  @RequirePermission("chat:huddles:start")
  @Validate({ params: channelIdParams })
  startHuddle(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.startHuddle(channelId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Get the currently active huddle for a channel" })
  @ApiResponse({ status: 200, description: "Active huddle or null" })
  @Get("channels/:channelId/huddle")
  @ResponseSchema(huddleWireNullableSchema)
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
  @ResponseSchema(chatOkSchema)
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
  @ResponseSchema(chatOkSchema)
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

  @ApiOperation({ summary: "Heartbeat to keep a participant active in a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @ApiResponse({ status: 429, description: "Rate limited" })
  @Patch("huddles/:huddleId/heartbeat")
  @ResponseSchema(chatOkSchema)
  @BodylessAction()
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @UseRateLimit("chat:huddle-heartbeat")
  @RequirePermission("chat:channels:read")
  @Validate({ params: huddleIdParams })
  heartbeat(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.signals.heartbeat(huddleId, u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Kick a participant from a huddle" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("huddles/:huddleId/kick")
  @ResponseSchema(chatOkSchema)
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
  @ResponseSchema(chatOkSchema)
  @Idempotent("chat.huddle.invite")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: huddleIdParams, body: huddleInviteSchema })
  invite(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @Body() body: HuddleInviteInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.inviteToHuddle(huddleId, u.userId, u.orgId, body.userIds);
  }
}
