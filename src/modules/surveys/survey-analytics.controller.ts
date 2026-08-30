import { Body, Controller, Get, Header, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SurveyAnalyticsService } from "./survey-analytics.service";
import { SurveyResponseService } from "./survey-response.service";
import { SurveyExportService } from "./survey-export.service";
import { SurveyFormsService } from "./survey-forms.service";
import { SurveyVersionService } from "./survey-version.service";
import {
  listResponsesSchema,
  exportResponsesSchema,
  type ListResponsesInput,
  type ExportResponsesInput,
} from "./dto/survey-analytics.schemas";

const surveyIdParams = z.object({ surveyId: z.coerce.number().int().positive() }).strict();
const surveyAndSessionIdParams = z.object({ surveyId: z.coerce.number().int().positive(), sessionId: z.coerce.number().int().positive() }).strict();

@Controller("surveys/:surveyId")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SurveyAnalyticsController {
  constructor(
    private readonly analytics: SurveyAnalyticsService,
    private readonly responses: SurveyResponseService,
    private readonly exports: SurveyExportService,
    private readonly forms: SurveyFormsService,
    private readonly versions: SurveyVersionService,
  ) {}

  @Get("analytics/overview")
  @RequirePermission("surveys:analytics:view")
  @Validate({ params: surveyIdParams })
  overview(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.analytics.overview(u.orgId, surveyId);
  }

  @Get("analytics/questions")
  @RequirePermission("surveys:analytics:view")
  @Validate({ params: surveyIdParams })
  async questions(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    const survey = await this.forms.get(u.orgId, surveyId);
    const versionId = survey.activeVersionId ?? (await this.versions.getDraftVersion(u.orgId, surveyId)).id;
    return this.analytics.questionAnalytics(u.orgId, surveyId, versionId);
  }

  @Get("responses")
  @RequirePermission("surveys:responses:view")
  @Validate({ params: surveyIdParams })
  listResponses(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Query(new ZodValidationPipe(listResponsesSchema)) query: ListResponsesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.responses.listResponses(u.orgId, surveyId, query);
  }

  @Get("responses/:sessionId")
  @RequirePermission("surveys:responses:view")
  @Validate({ params: surveyAndSessionIdParams })
  getResponse(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("sessionId", ParseIntPipe) sessionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.responses.getResponse(u.orgId, surveyId, sessionId);
  }

  @Post("export")
  @RequirePermission("surveys:responses:export")
  @Header("Content-Type", "text/csv")
  @Header("Content-Disposition", "attachment; filename=responses.csv")
  @Validate({ params: surveyIdParams })
  exportResponses(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body(new ZodValidationPipe(exportResponsesSchema)) body: ExportResponsesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.exports.exportResponsesCsv(u.orgId, surveyId, body);
  }
}
