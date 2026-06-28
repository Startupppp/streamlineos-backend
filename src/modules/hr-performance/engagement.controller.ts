import {
  Body,
  Controller,
  ForbiddenException,
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
import { canManagePerformance } from "./ability.helpers";
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

@Controller("hr")
@UseGuards(JwtAuthGuard)
export class EngagementController {
  constructor(
    private readonly goalsService: PerformanceGoalsService,
    private readonly engagement: EngagementService,
  ) {}

  @Get("my-goals")
  myGoals(@CurrentUser() u: CurrentUserContext) {
    return this.goalsService.myGoals(u.orgId, u.userId);
  }

  @Get("feedback")
  listFeedback(@CurrentUser() u: CurrentUserContext) {
    return this.engagement.listFeedback(u.orgId, u.userId);
  }

  @Post("feedback")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:feedback:manage")
  @HttpCode(201)
  createFeedback(
    @Body(new ZodValidationPipe(createFeedbackSchema)) body: CreateFeedbackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.createFeedback(u.orgId, body);
  }

  @Patch("feedback/:feedbackId")
  submitFeedback(
    @Param("feedbackId", ParseIntPipe) feedbackId: number,
    @Body(new ZodValidationPipe(submitFeedbackSchema)) body: SubmitFeedbackInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.submitFeedback(u.userId, feedbackId, body);
  }

  @Get("assessments")
  listAssessments(@CurrentUser() u: CurrentUserContext) {
    return this.engagement.listAssessments(u.orgId);
  }

  @Post("assessments")
  @HttpCode(201)
  createOrSubmitAssessment(
    @Headers("x-action") action: string | undefined,
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.createOrSubmitAssessment(
      u.orgId,
      u.userId,
      canManagePerformance(u),
      action,
      body,
    );
  }

  @Get("recognition")
  listRecognitions(@CurrentUser() u: CurrentUserContext) {
    return this.engagement.listRecognitions(u.orgId);
  }

  @Post("recognition")
  @HttpCode(201)
  createRecognition(
    @Body(new ZodValidationPipe(createRecognitionSchema)) body: CreateRecognitionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.createRecognition(u.orgId, u.userId, body);
  }

  @Get("enps")
  listEnps(@CurrentUser() u: CurrentUserContext) {
    if (!canManagePerformance(u)) {
      throw new ForbiddenException("Only admins can view eNPS scores.");
    }
    return this.engagement.listEnps(u.orgId);
  }

  @Post("enps")
  @HttpCode(201)
  createEnps(
    @Body(new ZodValidationPipe(createEnpsSchema)) body: CreateEnpsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.createEnps(u.orgId, u.userId, body);
  }

  @Get("surveys")
  listSurveys(@CurrentUser() u: CurrentUserContext) {
    return this.engagement.listSurveys(u.orgId);
  }

  @Post("surveys")
  @HttpCode(201)
  createOrRespondSurvey(
    @Headers("x-action") action: string | undefined,
    @Body() body: unknown,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.engagement.createOrRespondSurvey(
      u.orgId,
      u.userId,
      canManagePerformance(u),
      action,
      body,
    );
  }

  @Patch("surveys/:surveyId")
  updateSurvey(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body(new ZodValidationPipe(updateSurveySchema)) body: UpdateSurveyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!canManagePerformance(u)) throw new ForbiddenException("Forbidden.");
    return this.engagement.updateSurvey(u.orgId, surveyId, body);
  }
}
