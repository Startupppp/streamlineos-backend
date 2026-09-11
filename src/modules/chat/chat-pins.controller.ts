import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ChatPinsService } from "./chat-pins.service";
import { actorOf } from "../entity-reference/entity-actor";
import { pinMessageSchema, type PinMessageInput } from "./dto/chat.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { chatOkSchema, chatPinsListResponseSchema } from "./dto/chat-misc-response.schemas";
import { z } from "zod";

const channelIdParams = z.object({ channelId: z.coerce.number().int().positive() }).strict();
const channelAndMessageIdParams = z.object({ channelId: z.coerce.number().int().positive(), messageId: z.coerce.number().int().positive() }).strict();

@ApiTags("Chat Pins")
@ApiBearerAuth()
@Controller("chat/channels/:channelId/pins")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatPinsController {
  constructor(private readonly pins: ChatPinsService) {}

  @ApiOperation({ summary: "List pinned messages in a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get()
  @ResponseSchema(chatPinsListResponseSchema)
  @RequirePermission("chat:messages:read")
  @Validate({ params: channelIdParams })
  list(@Param("channelId", ParseIntPipe) channelId: number, @CurrentUser() u: CurrentUserContext) {
    return this.pins.listPins(channelId, actorOf(u));
  }

  @ApiOperation({ summary: "Pin a message in a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post()
  @ResponseSchema(chatOkSchema)
  @HttpCode(200)
  @RequirePermission("chat:messages:pin")
  @Validate({ params: channelIdParams, body: pinMessageSchema })
  pin(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body() body: PinMessageInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pins.pin(channelId, body.messageId, actorOf(u));
  }

  @ApiOperation({ summary: "Unpin a message from a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Delete(":messageId")
  @ResponseSchema(chatOkSchema)
  @HttpCode(200)
  @RequirePermission("chat:messages:pin")
  @Validate({ params: channelAndMessageIdParams })
  unpin(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Param("messageId", ParseIntPipe) messageId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.pins.unpin(channelId, messageId, actorOf(u));
  }
}
