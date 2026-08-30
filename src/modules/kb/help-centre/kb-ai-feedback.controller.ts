import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { Validate } from "../../../common/validation/validate.decorator";
import { KbAiFeedbackService } from "./kb-ai-feedback.service";
import { kbAiFeedbackSchema } from "../retrieval/dto/kb-ai.schemas";
import type { z } from "zod";

type KbAiFeedbackInput = z.infer<typeof kbAiFeedbackSchema>;

@Controller("kb")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class KbAiFeedbackController {
  constructor(private readonly feedback: KbAiFeedbackService) {}

  @Post("ai/feedback")
  @HttpCode(200)
  @RequirePermission("kb:pages:view")
  @UseGuards(RateLimitGuard)
  @UseRateLimit("kb:ask")
  @Validate({ body: kbAiFeedbackSchema })
  async submitFeedback(
    @Body() body: KbAiFeedbackInput,
    @CurrentUser() u: CurrentUserContext,
  ): Promise<{ success: boolean }> {
    await this.feedback.recordAnswerFeedback(u.orgId, u.userId, body);
    return { success: true };
  }
}
