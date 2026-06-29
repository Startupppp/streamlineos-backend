import { Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ChatSavedService } from "./chat-saved.service";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("chat")
@Controller("chat/saved")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatSavedController {
  constructor(private readonly saved: ChatSavedService) {}

  @Get()
  @RequirePermission("chat:messages:read")
  list(
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.saved.list(u.userId, cursor ? parseInt(cursor) : undefined, limit ? parseInt(limit) : 30);
  }

  @Post(":messageId")
  @HttpCode(200)
  @RequirePermission("chat:messages:write")
  save(@Param("messageId", ParseIntPipe) messageId: number, @CurrentUser() u: CurrentUserContext) {
    return this.saved.save(u.userId, messageId);
  }

  @Delete(":messageId")
  @RequirePermission("chat:messages:write")
  unsave(@Param("messageId", ParseIntPipe) messageId: number, @CurrentUser() u: CurrentUserContext) {
    return this.saved.unsave(u.userId, messageId);
  }
}
