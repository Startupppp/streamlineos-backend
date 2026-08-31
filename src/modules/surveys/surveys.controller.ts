import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";

const surveyIdParams = z.object({ surveyId: z.coerce.number().int().positive() }).strict();
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
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
  @Validate({ query: listSurveysSchema })
  list(@Query() query: ListSurveysInput, @CurrentUser() u: CurrentUserContext) {
    return this.forms.list(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("surveys:create")
  @Validate({ body: createSurveySchema })
  create(@Body() body: CreateSurveyInput, @CurrentUser() u: CurrentUserContext) {
    return this.forms.create(u.orgId, u.userId, body);
  }

  @Get(":surveyId")
  @RequirePermission("surveys:view")
  @Validate({ params: surveyIdParams })
  get(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.forms.get(u.orgId, surveyId);
  }

  @Patch(":surveyId")
  @RequirePermission("surveys:update")
  @Validate({ params: surveyIdParams, body: patchSurveySchema })
  patch(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: PatchSurveyInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.forms.patch(u.orgId, surveyId, body);
  }

  @Post(":surveyId/publish")
  @BodylessAction()
  @Idempotent("surveys.survey.publish")
  @RequirePermission("surveys:publish")
  @Validate({ params: surveyIdParams })
  publish(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.forms.publish(u.orgId, surveyId);
  }

  @Post(":surveyId/pause")
  @BodylessAction()
  @RequirePermission("surveys:publish")
  @Validate({ params: surveyIdParams })
  pause(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.forms.pause(u.orgId, surveyId);
  }

  @Post(":surveyId/close")
  @BodylessAction()
  @RequirePermission("surveys:publish")
  @Validate({ params: surveyIdParams })
  close(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.forms.close(u.orgId, surveyId);
  }

  @Post(":surveyId/archive")
  @BodylessAction()
  @RequirePermission("surveys:delete")
  @Validate({ params: surveyIdParams })
  archive(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.forms.archive(u.orgId, surveyId);
  }

  @Post(":surveyId/duplicate")
  @BodylessAction()
  @RequirePermission("surveys:create")
  @Validate({ params: surveyIdParams })
  duplicate(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.forms.duplicate(u.orgId, surveyId, u.userId);
  }
}
