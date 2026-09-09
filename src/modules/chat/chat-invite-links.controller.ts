import { Body, Controller, HttpCode, Param, ParseIntPipe, Post, UseGuards, Header } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { NO_COMPRESSION_HEADER } from "../../common/http/compression.config";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ChatInviteLinksService } from "./chat-invite-links.service";
import { Validate } from "../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { chatInviteLinkJoinSchema, chatInviteLinkTokenSchema } from "./dto/chat-misc-response.schemas";
import { chatInviteLinkMintSchema } from "./dto/chat-invite-link-mint.schema";

const channelIdParams = z.object({ channelId: z.coerce.number().int().positive() }).strict();
const tokenParams = z.object({ token: z.string().min(1) }).strict();

@ApiTags("Chat Invite Links")
@ApiBearerAuth()
@Controller("chat")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatInviteLinksController {
  constructor(private readonly inviteLinks: ChatInviteLinksService) {}

  @ApiOperation({ summary: "Get (or create) the active invite link token for a channel" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("channels/:channelId/invite-link")
  @ResponseSchema(chatInviteLinkTokenSchema)
  @HttpCode(200)
  @RequirePermission("chat:invite-links:manage")
  @Validate({ params: channelIdParams, body: chatInviteLinkMintSchema })
  // PRD-C089 (BREACH) — this body carries a credential and `app.enableCors({ credentials:
  // true })` is live, so a compressed length is a cross-origin size oracle.
  @Header(NO_COMPRESSION_HEADER, "1")
  getOrCreate(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body() body: z.infer<typeof chatInviteLinkMintSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.inviteLinks.getOrCreateInviteLink(channelId, u.userId, u.orgId, body);
  }

  @ApiOperation({ summary: "Revoke the current invite link and issue a new one" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("channels/:channelId/invite-link/regenerate")
  @ResponseSchema(chatInviteLinkTokenSchema)
  @HttpCode(200)
  @RequirePermission("chat:invite-links:manage")
  @Validate({ params: channelIdParams, body: chatInviteLinkMintSchema })
  // PRD-C089 (BREACH) — this body carries a credential and `app.enableCors({ credentials:
  // true })` is live, so a compressed length is a cross-origin size oracle.
  @Header(NO_COMPRESSION_HEADER, "1")
  regenerate(
    @Param("channelId", ParseIntPipe) channelId: number,
    @Body() body: z.infer<typeof chatInviteLinkMintSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.inviteLinks.regenerateInviteLink(channelId, u.userId, u.orgId, body);
  }

  @ApiOperation({ summary: "Join a channel using an invite link token" })
  @ApiResponse({ status: 200, description: "OK" })
  @Post("invite-links/:token/join")
  @ResponseSchema(chatInviteLinkJoinSchema)
  @BodylessAction()
  @HttpCode(200)
  @RequirePermission("chat:channels:write")
  @Validate({ params: tokenParams })
  join(@Param("token") token: string, @CurrentUser() u: CurrentUserContext) {
    return this.inviteLinks.joinViaInviteLink(token, u.userId, u.orgId);
  }
}
