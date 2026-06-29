import { Controller, Get, InternalServerErrorException, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import Ably from "ably";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@ApiTags("Chat Token")
@ApiBearerAuth()
@RequireModule("chat")
@Controller("chat")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatTokenController {
  @ApiOperation({ summary: "Get a scoped Ably token request for the current user" })
  @ApiResponse({ status: 200, description: "Ably token request object" })
  @Get("ably-token")
  @RequirePermission("chat:messages:read")
  async getAblyToken(@CurrentUser() u: CurrentUserContext) {
    const apiKey = process.env.ABLY_API_KEY;
    if (!apiKey) throw new ServiceUnavailableException("Ably is not configured");

    const rest = new Ably.Rest(apiKey);
    try {
      return await rest.auth.createTokenRequest({
        clientId: u.userId,
        capability: {
          [`chat:${u.orgId}:*`]: ["subscribe", "publish", "history"],
        },
        ttl: 3_600 * 1_000,
      });
    } catch {
      throw new InternalServerErrorException("Failed to create Ably token");
    }
  }
}
