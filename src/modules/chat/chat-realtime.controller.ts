import {
  Controller,
  Get,
  InternalServerErrorException,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { AblyService } from "../realtime/ably.service";
import { ChatChannelsService } from "./chat-channels.service";

@RequireModule("chat")
@Controller("chat")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatRealtimeController {
  constructor(
    private readonly ably: AblyService,
    private readonly channels: ChatChannelsService,
  ) {}

  @RequirePermission("chat:messages:read")
  @Get("ably-token")
  async ablyToken(@CurrentUser() u: CurrentUserContext) {
    if (!this.ably.configured) {
      throw new ServiceUnavailableException("Ably is not configured");
    }
    const channelIds = await this.channels.listMemberChannelIds(u.orgId, u.userId);
    try {
      return await this.ably.createChatTokenRequest(u.userId, u.orgId, channelIds);
    } catch {
      throw new InternalServerErrorException("Failed to create Ably token");
    }
  }
}
