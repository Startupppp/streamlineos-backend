import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ChatPinsService } from "./chat-pins.service";
import { pinMessageSchema, type PinMessageInput } from "./dto/chat.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@ApiTags("Chat Pins")
@ApiBearerAuth()
@RequireModule("chat")
@Controller("chat/channels/:channelId/pins")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatPinsController {
  constructor(private readonly pins: ChatPinsService) {}

  @ApiOperation({ summary: "List pinned messages in a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get()
  @RequirePermission("chat:messages:read")
  list(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.pins.listPins(channelId, u.userId);
  }

  @ApiOperation({ summary: "Pin a message in a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post()
  @HttpCode(200)
  @RequirePermission("chat:messages:pin")
  pin(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body(new ZodValidationPipe(pinMessageSchema)) body: PinMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pins.pin(channelId, body.messageId, u.userId);
  }

  @ApiOperation({ summary: "Unpin a message from a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Delete(":messageId")
  @HttpCode(200)
  @RequirePermission("chat:messages:pin")
  unpin(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Param("messageId", ParseIntPipe) messageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pins.unpin(channelId, messageId, u.userId);
  }
}
