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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { ChatPresenceService } from "./chat-presence.service";
import {
  searchQuerySchema,
  statusSchema,
  type SearchQuery,
  type StatusInput,
} from "./dto/chat.schemas";

@Controller("chat")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatPresenceController {
  constructor(private readonly presence: ChatPresenceService) {}

  @Post("presence/heartbeat")
  @HttpCode(200)
  @RequirePermission("chat:messages:read")
  heartbeat(@CurrentUser() u: CurrentUserContext) {
    return this.presence.heartbeat(u.userId, u.orgId);
  }

  @Get("presence/online")
  @RequirePermission("chat:messages:read")
  online(@CurrentUser() u: CurrentUserContext) {
    return this.presence.getOnlineUsers(u.orgId);
  }

  @Put("status")
  @RequirePermission("chat:messages:write")
  setStatus(
    @Body(new ZodValidationPipe(statusSchema)) body: StatusInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.presence.setStatus(u.userId, u.orgId, body);
  }

  @Get("unread")
  @RequirePermission("chat:messages:read")
  async unread(@CurrentUser() u: CurrentUserContext) {
    const total = await this.presence.getUnreadTotal(u.userId);
    return { total };
  }

  @Get("search")
  @RequirePermission("chat:messages:read")
  search(
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (query.query.length < 2) {
      throw new BadRequestException("Query must be at least 2 characters");
    }
    return this.presence.searchMessages(u.userId, query.query, query.channelId, query.limit ?? 20);
  }

  @Get("users")
  @RequirePermission("chat:channels:read")
  users(@CurrentUser() u: CurrentUserContext) {
    return this.presence.getOrgUsers(u.userId, u.orgId);
  }
}
