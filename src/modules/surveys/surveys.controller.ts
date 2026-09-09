import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards, Req } from "@nestjs/common";
import type { Request } from "express";
import { readRequestScope } from "../organization/core/read-request-scope";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SurveyFormsService } from "./survey-forms.service";
import { SurveyTemplateService } from "./survey-template.service";
import {
  createSurveySchema,
  listSurveysSchema,
  patchSurveySchema,
  type CreateSurveyInput,
  type ListSurveysInput,
  type PatchSurveyInput,
} from "./dto/survey-forms.schemas";

@Controller("surveys")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SurveysController {
  constructor(
    private readonly forms: SurveyFormsService,
    private readonly templates: SurveyTemplateService,
  ) {}

  @Get("templates")
  @RequirePermission("surveys:view")
  listTemplates() {
    return this.templates.list();
  }

  @Get()
  @RequirePermission("surveys:view")
  list(@Query(new ZodValidationPipe(listSurveysSchema)) query: ListSurveysInput, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.forms.list(u.orgId, u.userId, query, readRequestScope(req));
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("surveys:create")
  create(@Body(new ZodValidationPipe(createSurveySchema)) body: CreateSurveyInput, @CurrentUser() u: CurrentUserContext) {
    return this.forms.create(u.orgId, u.userId, body);
  }

  @Get(":surveyId")
  @RequirePermission("surveys:view")
  get(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.forms.get(u.orgId, u.userId, surveyId, readRequestScope(req));
  }

  @Patch(":surveyId")
  @RequirePermission("surveys:update")
  patch(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body(new ZodValidationPipe(patchSurveySchema)) body: PatchSurveyInput,
    @CurrentUser() u: CurrentUserContext, @Req() req: Request
  ) {
    return this.forms.patch(u.orgId, u.userId, surveyId, body, readRequestScope(req));
  }

  @Post(":surveyId/publish")
  @Idempotent("surveys.survey.publish")
  @RequirePermission("surveys:publish")
  publish(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.forms.publish(u.orgId, u.userId, surveyId, readRequestScope(req));
  }

  @Post(":surveyId/pause")
  @RequirePermission("surveys:publish")
  pause(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.forms.pause(u.orgId, u.userId, surveyId, readRequestScope(req));
  }

  @Post(":surveyId/close")
  @RequirePermission("surveys:publish")
  close(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.forms.close(u.orgId, u.userId, surveyId, readRequestScope(req));
  }

  @Post(":surveyId/archive")
  @RequirePermission("surveys:delete")
  archive(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.forms.archive(u.orgId, u.userId, surveyId, readRequestScope(req));
  }

  @Post(":surveyId/duplicate")
  @RequirePermission("surveys:create")
  duplicate(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext, @Req() req: Request) {
    return this.forms.duplicate(u.orgId, surveyId, u.userId, readRequestScope(req));
  }
}
