import { Controller, HttpCode, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ChatInviteLinksService } from "./chat-invite-links.service";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";

const channelIdParams = z.object({ channelId: z.coerce.number().int().positive() }).strict();
const tokenParams = z.object({ token: z.string().min(1) }).strict();

@ApiTags("Chat Invite Links")
@ApiBearerAuth()
@RequireModule("chat")
@Controller("chat")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatInviteLinksController {
  constructor(private readonly inviteLinks: ChatInviteLinksService) {}

  @ApiOperation({ summary: "Get (or create) the active invite link token for a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("channels/:channelId/invite-link")
  @HttpCode(200)
  @RequirePermission("chat:invite-links:manage")
  @Validate({ params: channelIdParams })
  getOrCreate(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.inviteLinks.getOrCreateInviteLink(channelId, u.userId);
  }

  @ApiOperation({ summary: "Revoke the current invite link and issue a new one" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("channels/:channelId/invite-link/regenerate")
  @HttpCode(200)
  @RequirePermission("chat:invite-links:manage")
  @Validate({ params: channelIdParams })
  regenerate(
    @Param("channelId", ParseIntPipe) channelId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.inviteLinks.regenerateInviteLink(channelId, u.userId);
  }

  @ApiOperation({ summary: "Join a channel using an invite link token" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("invite-links/:token/join")
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: tokenParams })
  join(@Param("token") token: string, @CurrentUser() u: CurrentUserContext) {
    return this.inviteLinks.joinViaInviteLink(token, u.userId, u.orgId);
  }
}
