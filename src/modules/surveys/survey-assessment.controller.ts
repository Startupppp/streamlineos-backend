import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { SurveyAssessmentService } from "./survey-assessment.service";
import {
  createAttemptSchema,
  listAttemptsSchema,
  type CreateAttemptInput,
  type ListAttemptsInput,
} from "./dto/survey-assessment.schemas";

const surveyIdParams = z.object({ surveyId: z.coerce.number().int().positive() }).strict();

@RequireModule("surveys")
@Controller("surveys/:surveyId")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SurveyAssessmentController {
  constructor(private readonly assessments: SurveyAssessmentService) {}

  @Get("assessment/attempts")
  @RequirePermission("surveys:assessments:manage")
  @Validate({ params: surveyIdParams, query: listAttemptsSchema })
  listAttempts(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Query() query: ListAttemptsInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assessments.listAttempts(u.orgId, surveyId, query);
  }

  @Post("assessment/attempts")
  @HttpCode(201)
  @Idempotent("surveys:assessment.attempt")
  @RequirePermission("surveys:assessments:manage")
  @Validate({ params: surveyIdParams, body: createAttemptSchema })
  createAttempt(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: CreateAttemptInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.assessments.createAttempt(u.orgId, surveyId, body.participantId ?? null);
  }

  @Get("certificates")
  @RequirePermission("surveys:assessments:manage")
  @Validate({ params: surveyIdParams })
  listCertificates(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.assessments.listCertificates(u.orgId, surveyId);
  }
}
