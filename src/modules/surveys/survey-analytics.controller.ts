import { Body, Controller, Get, Header, Param, ParseIntPipe, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { ResponseSchema } from "../../common/openapi/zod-operation-contracts";
import { ApiOkResponse } from "@nestjs/swagger";
import {
  surveyOverviewSchema,
  surveyQuestionAnalyticsSchema,
  surveyResponseListSchema,
  surveyResponseDetailSchema,
} from "./dto/survey-analytics-response.schemas";
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

@RequireModule("surveys")
@Controller("surveys/:surveyId")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
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
  @ResponseSchema(surveyOverviewSchema)
  async overview(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    await this.forms.get(u.orgId, surveyId);
    return this.analytics.overview(u.orgId, surveyId);
  }

  @Get("analytics/questions")
  @RequirePermission("surveys:analytics:view")
  @Validate({ params: surveyIdParams })
  @ResponseSchema(surveyQuestionAnalyticsSchema)
  async questions(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    const survey = await this.forms.get(u.orgId, surveyId);
    const versionId = survey.activeVersionId ?? (await this.versions.getDraftVersion(u.orgId, surveyId)).id;
    return this.analytics.questionAnalytics(u.orgId, surveyId, versionId);
  }

  @Get("responses")
  @RequirePermission("surveys:responses:view")
  @Validate({ params: surveyIdParams, query: listResponsesSchema })
  @ResponseSchema(surveyResponseListSchema)
  async listResponses(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Query() query: ListResponsesInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    await this.forms.get(u.orgId, surveyId);
    return this.responses.listResponses(u.orgId, surveyId, query);
  }

  @Get("responses/:sessionId")
  @RequirePermission("surveys:responses:view")
  @Validate({ params: surveyAndSessionIdParams })
  @ResponseSchema(surveyResponseDetailSchema)
  getResponse(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("sessionId", ParseIntPipe) sessionId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.responses.getResponse(u.orgId, surveyId, sessionId);
  }

  @Post("export")
  @RequirePermission("surveys:responses:export")
  @Validate({ params: surveyIdParams, body: exportResponsesSchema })
  @ApiOkResponse({ content: { "text/csv": { schema: { type: "string" } } }, description: "CSV export of survey responses" })
  async exportResponses(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: ExportResponsesInput,
    @CurrentUser() u: CurrentUserContext,
    @Res() res: Response,
  ) {
    await this.forms.get(u.orgId, surveyId);
    const result = await this.exports.exportResponsesCsv(u.orgId, surveyId, body);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=responses.csv");
    if (result.truncated) res.setHeader("X-Export-Truncated", "true");
    res.setHeader("X-Export-Row-Count", String(result.rowCount));
    res.send(result.csv);
  }
}
