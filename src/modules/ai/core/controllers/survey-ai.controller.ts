import {
  Controller,
  Param,
  ParseIntPipe,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { RateLimitGuard } from "../../../../common/ratelimit/rate-limit.guard";
import { UseRateLimit } from "../../../../common/ratelimit/use-rate-limit.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import { NoTenantTransaction } from "../../../../common/tenant/no-tenant-transaction.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { LlmService } from "../providers/llm.service";
import { SurveyAiService } from "../services/survey-ai.service";

@Controller("ai")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@UseRateLimit("ai:invoke")
@NoTenantTransaction()
export class SurveyAiController {
  constructor(
    private readonly llm: LlmService,
    private readonly surveyAi: SurveyAiService,
  ) {}

  private ensureLlm(): void {
    if (!this.llm.isConfigured()) throw new ServiceUnavailableException("AI is not configured.");
  }

  @Post("surveys/:surveyId/summarize-responses")
  @RequirePermission("surveys:ai:use")
  async summarizeResponses(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.surveyAi.summarizeResponses(u.orgId, u.userId, surveyId);
  }
}
