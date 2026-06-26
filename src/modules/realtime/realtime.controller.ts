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
import { AblyService } from "./ably.service";

@Controller("chat")
@UseGuards(JwtAuthGuard)
export class RealtimeController {
  constructor(private readonly ably: AblyService) {}

  @Get("ably-token")
  async ablyToken(@CurrentUser() u: CurrentUserContext) {
    if (!this.ably.configured) {
      throw new ServiceUnavailableException("Ably is not configured");
    }
    try {
      return await this.ably.createChatTokenRequest(u.userId, u.orgId);
    } catch {
      throw new InternalServerErrorException("Failed to create Ably token");
    }
  }
}
