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
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ChatHuddlesService } from "./chat-huddles.service";
import {
  huddleSignalSchema,
  muteSchema,
  raiseHandSchema,
  type HuddleSignalInput,
  type MuteInput,
  type RaiseHandInput,
} from "./dto/huddle.schemas";

@RequireModule("chat")
@Controller("chat")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatHuddlesController {
  constructor(private readonly huddles: ChatHuddlesService) {}

  @Post("channels/:channelId/huddle/start")
  @HttpCode(201)
  @RequirePermission("chat:channels:write")
  startHuddle(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.startHuddle(channelId, u.userId, u.orgId);
  }

  @Get("channels/:channelId/huddle")
  @RequirePermission("chat:channels:read")
  getActiveHuddle(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.getActiveHuddle(channelId, u.userId);
  }

  @Post("huddles/:huddleId/join")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  joinHuddle(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.joinHuddle(huddleId, u.userId, u.orgId);
  }

  @Post("huddles/:huddleId/leave")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  leaveHuddle(
    @Param("huddleId", ParseIntPipe) huddleId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.huddles.leaveHuddle(huddleId, u.userId, u.orgId);
  }

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
}
