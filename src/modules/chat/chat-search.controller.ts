import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ChatSearchService } from "./chat-search.service";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@ApiTags("Chat Search")
@ApiBearerAuth()
@RequireModule("chat")
@Controller("chat/search")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatSearchController {
  constructor(private readonly search: ChatSearchService) {}

  @ApiOperation({ summary: "Search messages by keyword with optional date range and sender filters" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("messages")
  @RequirePermission("chat:messages:read")
  searchMessages(
    @Query("q") q: string,
    @Query("cursor") cursor: string | undefined,
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Query("sender") sender: string | undefined,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.search.searchMessages(u.orgId, u.userId, q ?? "", 20, cursor ? parseInt(cursor) : undefined, from, to, sender);
  }

  @ApiOperation({ summary: "Search channels by name" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("channels")
  @RequirePermission("chat:channels:read")
  searchChannels(@Query("q") q: string, @CurrentUser() u: CurrentUserContext) {
    return this.search.searchChannels(u.orgId, u.userId, q ?? "");
  }

  @ApiOperation({ summary: "Search users in the organisation by name or email" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("users")
  @RequirePermission("chat:channels:read")
  searchUsers(@Query("q") q: string, @CurrentUser() u: CurrentUserContext) {
    return this.search.searchUsers(u.orgId, q ?? "");
  }
}
