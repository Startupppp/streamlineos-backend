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
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { PerformanceGoalsService } from "./performance-goals.service";
import { EngagementService } from "./engagement.service";
import {
  createEnpsSchema,
  createFeedbackSchema,
  createRecognitionSchema,
  submitFeedbackSchema,
  updateSurveySchema,
  type CreateEnpsInput,
  type CreateFeedbackInput,
  type CreateRecognitionInput,
  type SubmitFeedbackInput,
  type UpdateSurveyInput,
} from "./dto/engagement.schemas";
import { RequireModule } from "../../common/rbac/require-module.decorator";

@RequireModule("hr")
@Controller("hr")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class EngagementController {
  constructor(
    private readonly goalsService: PerformanceGoalsService,
    private readonly engagement: EngagementService,
  ) {}

  @Get("my-goals")
  @RequirePermission("hr:performance:view")
  myGoals(@CurrentUser() u: CurrentUserContext) {
    return this.goalsService.myGoals(u.orgId, u.userId);
  }

  @Get("feedback")
  @RequirePermission("hr:feedback:view")
  listFeedback(@CurrentUser() u: CurrentUserContext) {
    return this.engagement.listFeedback(u.orgId, u.userId);
  }

  @Post("feedback")
  @RequirePermission("hr:feedback:manage")
  @HttpCode(201)
  createFeedback(
    @Body(new ZodValidationPipe(createFeedbackSchema)) body: CreateFeedbackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.createFeedback(u.orgId, body);
  }

  @Patch("feedback/:feedbackId")
  @RequirePermission("hr:feedback:view")
  submitFeedback(
    @Param("feedbackId", ParseIntPipe) feedbackId: number,
    @Body(new ZodValidationPipe(submitFeedbackSchema)) body: SubmitFeedbackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.submitFeedback(u.orgId, u.userId, feedbackId, body);
  }

  @Get("assessments")
  @RequirePermission("hr:engagement:view")
  listAssessments(@CurrentUser() u: CurrentUserContext) {
    return this.engagement.listAssessments(u.orgId);
  }

  @Post("assessments")
  @HttpCode(201)
  @RequirePermission("hr:engagement:view")
  createOrSubmitAssessment(
    @Headers("x-action") action: string | undefined,
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isManager = u.isOrgOwner || u.isPlatformAdmin;
    return this.engagement.createOrSubmitAssessment(
      u.orgId,
      u.userId,
      isManager,
      action,
      body,
    );
  }

  @Get("recognition")
  @RequirePermission("hr:engagement:view")
  listRecognitions(@CurrentUser() u: CurrentUserContext) {
    return this.engagement.listRecognitions(u.orgId);
  }

  @Post("recognition")
  @HttpCode(201)
  @RequirePermission("hr:engagement:view")
  createRecognition(
    @Body(new ZodValidationPipe(createRecognitionSchema)) body: CreateRecognitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.createRecognition(u.orgId, u.userId, body);
  }

  @Get("enps")
  @RequirePermission("hr:engagement:manage")
  listEnps(@CurrentUser() u: CurrentUserContext) {
    return this.engagement.listEnps(u.orgId);
  }

  @Post("enps")
  @HttpCode(201)
  @RequirePermission("hr:engagement:view")
  createEnps(
    @Body(new ZodValidationPipe(createEnpsSchema)) body: CreateEnpsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.createEnps(u.orgId, u.userId, body);
  }

  @Get("surveys")
  @RequirePermission("hr:engagement:view")
  listSurveys(@CurrentUser() u: CurrentUserContext) {
    return this.engagement.listSurveys(u.orgId);
  }

  @Post("surveys")
  @HttpCode(201)
  @RequirePermission("hr:engagement:view")
  createOrRespondSurvey(
    @Headers("x-action") action: string | undefined,
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    const isManager = u.isOrgOwner || u.isPlatformAdmin;
    return this.engagement.createOrRespondSurvey(
      u.orgId,
      u.userId,
      isManager,
      action,
      body,
    );
  }

  @Patch("surveys/:surveyId")
  @RequirePermission("hr:engagement:manage")
  updateSurvey(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body(new ZodValidationPipe(updateSurveySchema)) body: UpdateSurveyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.updateSurvey(u.orgId, surveyId, body);
  }
}
