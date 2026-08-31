import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ChatPresenceService } from "./chat-presence.service";
import {
  searchQuerySchema,
  statusSchema,
  type SearchQuery,
  type StatusInput,
} from "./dto/chat.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

@ApiTags("Chat Presence")
@ApiBearerAuth()
@RequireModule("chat")
@Controller("chat")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatPresenceController {
  constructor(private readonly presence: ChatPresenceService) {}

  @ApiOperation({ summary: "Update presence heartbeat to mark user as online" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("presence/heartbeat")
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:messages:read")
  heartbeat(@CurrentUser() u: CurrentUserContext) {
    return this.presence.heartbeat(u.userId, u.orgId);
  }

  @ApiOperation({ summary: "Get currently online users in the organisation" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("presence/online")
  @RequirePermission("chat:messages:read")
  online(@CurrentUser() u: CurrentUserContext) {
    return this.presence.getOnlineUsers(u.orgId);
  }

  @ApiOperation({ summary: "Set the current user's status message and emoji" })
  @ApiResponse({ status: 200, description: "OK" })
  @Put("status")
  @RequirePermission("chat:messages:write")
  @Validate({ body: statusSchema })
  setStatus(
    @Body() body: StatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.presence.setStatus(u.userId, u.orgId, body);
  }

  @ApiOperation({ summary: "Get total unread message count across all channels" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("unread")
  @RequirePermission("chat:messages:read")
  async unread(@CurrentUser() u: CurrentUserContext) {
    const total = await this.presence.getUnreadTotal(u.userId, u.orgId);
    return { total };
  }

  @ApiOperation({ summary: "Full-text search across chat messages" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("search")
  @RequirePermission("chat:messages:read")
  @Validate({ query: searchQuerySchema })
  search(
    @Query() query: SearchQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (query.query.length < 2) {
      throw new BadRequestException("Query must be at least 2 characters");
    }
    return this.presence.searchMessages(u.userId, u.orgId, query.query, query.channelId, query.limit);
  }

  @ApiOperation({ summary: "List all users in the organisation for mentions and invites" })
  @ApiResponse({ status: 200, description: "OK" })
  @Get("users")
  @RequirePermission("chat:channels:read")
  users(@CurrentUser() u: CurrentUserContext) {
    return this.presence.getOrgUsers(u.orgId);
  }
}
