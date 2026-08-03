import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
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
  list(@Query(new ZodValidationPipe(listSurveysSchema)) query: ListSurveysInput, @CurrentUser() u: CurrentUserContext) {
    return this.forms.list(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("surveys:create")
  create(@Body(new ZodValidationPipe(createSurveySchema)) body: CreateSurveyInput, @CurrentUser() u: CurrentUserContext) {
    return this.forms.create(u.orgId, u.userId, body);
  }

  @Get(":surveyId")
  @RequirePermission("surveys:view")
  get(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.forms.get(u.orgId, surveyId);
  }

  @Patch(":surveyId")
  @RequirePermission("surveys:update")
  patch(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body(new ZodValidationPipe(patchSurveySchema)) body: PatchSurveyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.forms.patch(u.orgId, surveyId, body);
  }

  @Post(":surveyId/publish")
  @RequirePermission("surveys:publish")
  publish(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.forms.publish(u.orgId, surveyId);
  }

  @Post(":surveyId/pause")
  @RequirePermission("surveys:publish")
  pause(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.forms.pause(u.orgId, surveyId);
  }

  @Post(":surveyId/close")
  @RequirePermission("surveys:publish")
  close(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.forms.close(u.orgId, surveyId);
  }

  @Post(":surveyId/archive")
  @RequirePermission("surveys:delete")
  archive(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.forms.archive(u.orgId, surveyId);
  }

  @Post(":surveyId/duplicate")
  @RequirePermission("surveys:create")
  duplicate(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.forms.duplicate(u.orgId, surveyId, u.userId);
  }
}
