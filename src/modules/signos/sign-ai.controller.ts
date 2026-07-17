import { BadRequestException, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { SignAiService } from "./sign-ai.service";

@Controller("sign/envelopes/:envelopeId/ai")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@RequirePermission("sign:envelope:view")
@UseRateLimit("ai:invoke")
export class SignAiController {
  constructor(private readonly signAi: SignAiService) {}

  @Post("summarize")
  summarize(
    @Param("envelopeId") rawId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const id = parseInt(rawId, 10);
    if (Number.isNaN(id) || id <= 0) throw new BadRequestException("Invalid envelopeId");
    return this.signAi.summarizeDocument(u.orgId, id, u.userId);
  }
}
