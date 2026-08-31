import { Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ChatSavedService } from "./chat-saved.service";
import { actorOf } from "../entity-reference/entity-actor";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const messageIdParams = z.object({ messageId: z.coerce.number().int().positive() }).strict();

@ApiTags("Chat Saved Messages")
@ApiBearerAuth()
@RequireModule("chat")
@Controller("chat/saved")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatSavedController {
  constructor(private readonly saved: ChatSavedService) {}

  @ApiOperation({ summary: "List saved messages for the current user" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get()
  @RequirePermission("chat:messages:read")
  list(
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const parsedLimit = limit ? Math.min(Math.max(1, parseInt(limit, 10)), 100) : 30;
    return this.saved.list(
      actorOf(u),
      cursor ? parseInt(cursor, 10) : undefined,
      parsedLimit,
    );
  }

  @ApiOperation({ summary: "Save a message to the current user's saved list" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":messageId")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  @Validate({ params: messageIdParams })
  save(@Param("messageId", ParseIntPipe) messageId: number, @CurrentUser() u: CurrentUserContext) {
    return this.saved.save(actorOf(u), messageId);
  }

  @ApiOperation({ summary: "Remove a message from the current user's saved list" })
  @ApiResponse({ status: 200, description: "OK" })
  @Delete(":messageId")
  @RequirePermission("chat:messages:write")
  @Validate({ params: messageIdParams })
  unsave(@Param("messageId", ParseIntPipe) messageId: number, @CurrentUser() u: CurrentUserContext) {
    return this.saved.unsave(actorOf(u), messageId);
  }
}
