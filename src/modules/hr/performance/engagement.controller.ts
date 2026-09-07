import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

import { PerformanceGoalsService } from "./performance-goals.service";
import { EngagementService } from "./engagement.service";
import {
  createEnpsSchema,
  createFeedbackSchema,
  createOrRespondSurveySchema,
  createOrSubmitAssessmentSchema,
  createRecognitionSchema,
  submitFeedbackSchema,
  updateSurveySchema,
  type CreateEnpsInput,
  type CreateFeedbackInput,
  type CreateRecognitionInput,
  type SubmitFeedbackInput,
  type UpdateSurveyInput,
} from "./dto/engagement.schemas";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";
import { ResponseSchema } from "../../../common/openapi/zod-operation-contracts"
import { listFeedbackResponseSchema, createFeedbackResponseSchema, submitFeedbackResponseSchema, listAssessmentsResponseSchema, createOrSubmitAssessmentResponseSchema, listRecognitionsResponseSchema, createRecognitionResponseSchema, listEnpsResponseSchema, createEnpsResponseSchema, listSurveysResponseSchema, createOrRespondSurveyResponseSchema, updateSurveyResponseSchema } from "./dto/engagement-response.schemas"
import { myGoalsResponseSchema } from "./dto/performance-response.schemas"

const feedbackIdParams = z.object({ feedbackId: z.coerce.number().int().positive() }).strict();
const surveyIdParams = z.object({ surveyId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@Controller("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EngagementController {
  constructor(
    private readonly goalsService: PerformanceGoalsService,
    private readonly engagement: EngagementService,
  ) {}

  @ResponseSchema(myGoalsResponseSchema)
  @Get("my-goals")
  @RequirePermission("hr:performance:view")
  myGoals(@CurrentUser() u: CurrentUserContext) {
    return this.goalsService.myGoals(u.orgId, u.userId);
  }

  @ResponseSchema(listFeedbackResponseSchema)
  @Get("feedback")
  @RequirePermission("hr:feedback:view")
  listFeedback(@CurrentUser() u: CurrentUserContext) {
    return this.engagement.listFeedback(u.orgId, u.userId);
  }

  @ResponseSchema(createFeedbackResponseSchema)
  @Post("feedback")
  @RequirePermission("hr:feedback:manage")
  @HttpCode(201)
  @Validate({ body: createFeedbackSchema })
  createFeedback(
    @Body() body: CreateFeedbackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.createFeedback(u.orgId, body);
  }

  @ResponseSchema(submitFeedbackResponseSchema)
  @Patch("feedback/:feedbackId")
  @RequirePermission("hr:feedback:view")
  @Validate({ params: feedbackIdParams, body: submitFeedbackSchema })
  submitFeedback(
    @Param("feedbackId", ParseIntPipe) feedbackId: number,
    @Body() body: SubmitFeedbackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.submitFeedback(u.orgId, u.userId, feedbackId, body);
  }

  @ResponseSchema(listAssessmentsResponseSchema)
  @Get("assessments")
  @RequirePermission("hr:engagement:view")
  listAssessments(@CurrentUser() u: CurrentUserContext) {
    return this.engagement.listAssessments(u.orgId);
  }

  @ResponseSchema(createOrSubmitAssessmentResponseSchema)
  @Post("assessments")
  @HttpCode(201)
  @RequirePermission("hr:engagement:view")
  @Validate({ body: createOrSubmitAssessmentSchema })
  createOrSubmitAssessment(
    @Headers("x-action") action: string | undefined,
    @Body() body: z.infer<typeof createOrSubmitAssessmentSchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isManager = u.isOrgOwner;
    return this.engagement.createOrSubmitAssessment(
      u.orgId,
      u.userId,
      isManager,
      action,
      body,
    );
  }

  @ResponseSchema(listRecognitionsResponseSchema)
  @Get("recognition")
  @RequirePermission("hr:engagement:view")
  listRecognitions(@CurrentUser() u: CurrentUserContext) {
    return this.engagement.listRecognitions(u.orgId);
  }

  @ResponseSchema(createRecognitionResponseSchema)
  @Post("recognition")
  @HttpCode(201)
  @RequirePermission("hr:engagement:view")
  @Validate({ body: createRecognitionSchema })
  createRecognition(
    @Body() body: CreateRecognitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.createRecognition(u, body);
  }

  @ResponseSchema(listEnpsResponseSchema)
  @Get("enps")
  @RequirePermission("hr:engagement:manage")
  listEnps(@CurrentUser() u: CurrentUserContext) {
    return this.engagement.listEnps(u.orgId);
  }

  @ResponseSchema(createEnpsResponseSchema)
  @Post("enps")
  @HttpCode(201)
  @RequirePermission("hr:engagement:view")
  @Validate({ body: createEnpsSchema })
  createEnps(
    @Body() body: CreateEnpsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.createEnps(u.orgId, u.userId, body);
  }

  @ResponseSchema(listSurveysResponseSchema)
  @Get("surveys")
  @RequirePermission("hr:engagement:view")
  listSurveys(@CurrentUser() u: CurrentUserContext) {
    return this.engagement.listSurveys(u.orgId);
  }

  @ResponseSchema(createOrRespondSurveyResponseSchema)
  @Post("surveys")
  @HttpCode(201)
  @RequirePermission("hr:engagement:view")
  @Validate({ body: createOrRespondSurveySchema })
  createOrRespondSurvey(
    @Headers("x-action") action: string | undefined,
    @Body() body: z.infer<typeof createOrRespondSurveySchema>,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isManager = u.isOrgOwner;
    return this.engagement.createOrRespondSurvey(
      u.orgId,
      u.userId,
      isManager,
      action,
      body,
    );
  }

  @ResponseSchema(updateSurveyResponseSchema)
  @Patch("surveys/:surveyId")
  @RequirePermission("hr:engagement:manage")
  @Validate({ params: surveyIdParams, body: updateSurveySchema })
  updateSurvey(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: UpdateSurveyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.updateSurvey(u.orgId, surveyId, body);
  }
}
