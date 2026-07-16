import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { RateLimitGuard } from "../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { KbAiFeedbackService } from "./kb-ai-feedback.service";
import { kbAiFeedbackSchema } from "./dto/kb-ai.schemas";

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbAiFeedbackController {
  constructor(private readonly feedback: KbAiFeedbackService) {}

  @Post("ai/feedback")
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("kb:ask")
  async submitFeedback(
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ success: boolean }> {
    const parsed = kbAiFeedbackSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid request body");
    await this.feedback.recordAnswerFeedback(u.orgId, u.userId, parsed.data);
    return { success: true };
  }
}
