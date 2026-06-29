import { Controller, Get, InternalServerErrorException, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import Ably from "ably";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("chat")
@Controller("chat")
@UseGuards(JwtAuthGuard)
export class ChatTokenController {
  @Get("ably-token")
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
