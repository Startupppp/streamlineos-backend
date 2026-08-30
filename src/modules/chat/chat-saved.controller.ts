import { Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ChatSavedService } from "./chat-saved.service";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { chatSavedListQuerySchema } from "./dto/chat.schemas";

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
  @Validate({ query: chatSavedListQuerySchema })
  list(
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const parsedLimit = limit ? Math.min(Math.max(1, parseInt(limit, 10)), 100) : 30;
    return this.saved.list(
      { orgId: u.orgId, userId: u.userId, isOrgOwner: u.isOrgOwner },
      cursor ? parseInt(cursor, 10) : undefined,
      parsedLimit,
    );
  }

  @ApiOperation({ summary: "Save a message to the current user's saved list" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post(":messageId")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  save(@Param("messageId", ParseIntPipe) messageId: number, @CurrentUser() u: CurrentUserContext) {
    return this.saved.save(
      { orgId: u.orgId, userId: u.userId, isOrgOwner: u.isOrgOwner },
      messageId,
    );
  }

  @ApiOperation({ summary: "Remove a message from the current user's saved list" })
  @ApiResponse({ status: 200, description: "OK" })
  @Delete(":messageId")
  @RequirePermission("chat:messages:write")
  unsave(@Param("messageId", ParseIntPipe) messageId: number, @CurrentUser() u: CurrentUserContext) {
    return this.saved.unsave(
      { orgId: u.orgId, userId: u.userId, isOrgOwner: u.isOrgOwner },
      messageId,
    );
  }
}
