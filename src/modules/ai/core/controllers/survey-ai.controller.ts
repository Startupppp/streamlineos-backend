import {
  Controller,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Request, Response } from "express";
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
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";
import { BodylessAction, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import { AiRequestAbortInterceptor, respondWithAiTextStream } from "../streaming";
import { ApiOkResponse } from "@nestjs/swagger";
import { surveyAiSummarizeResponseSchema } from "../dto/ai-response.schemas";

const surveyIdParams = z.object({ surveyId: z.coerce.number().int().positive() }).strict();

@Controller("ai")
@UseGuards(JwtAuthGuard, PermissionGuard, RateLimitGuard)
@UseRateLimit("ai:invoke")
@NoTenantTransaction()
@UseInterceptors(AiRequestAbortInterceptor)
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
  @Validate({ params: surveyIdParams })
  @BodylessAction()
  @ResponseSchema(surveyAiSummarizeResponseSchema)
  async summarizeResponses(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    this.ensureLlm();
    return this.surveyAi.summarizeResponses(u.orgId, u.userId, surveyId);
  }

  @Post("surveys/:surveyId/summarize-responses/stream")
  @RequirePermission("surveys:ai:use")
  @Validate({ params: surveyIdParams })
  @BodylessAction()
  @ApiOkResponse({ description: "AI text stream", content: { "text/plain": { schema: { type: "string" } } } })
  async summarizeResponsesStream(
    @Req() req: Request,
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ): Promise<void> {
    this.ensureLlm();
    return respondWithAiTextStream(
      req,
      res,
      {
        feature: "survey.summarize-responses",
        orgId: u.orgId,
        route: "POST /ai/surveys/:surveyId/summarize-responses/stream",
      },
      async (signal) =>
        this.surveyAi.streamSummarizeResponses(u.orgId, u.userId, surveyId, signal),
    );
  }
}
