import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ChatPinsService } from "./chat-pins.service";
import { pinMessageSchema, type PinMessageInput } from "./dto/chat.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("chat")
@Controller("chat/channels/:channelId/pins")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatPinsController {
  constructor(private readonly pins: ChatPinsService) {}

  @Get()
  @RequirePermission("chat:messages:read")
  list(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.pins.listPins(channelId, u.userId);
  }

  @Post()
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  pin(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body(new ZodValidationPipe(pinMessageSchema)) body: PinMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pins.pin(channelId, body.messageId, u.userId);
  }

  @Delete(":messageId")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  unpin(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Param("messageId", ParseIntPipe) messageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pins.unpin(channelId, messageId, u.userId);
  }
}
