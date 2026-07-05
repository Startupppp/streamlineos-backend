import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { SurveyAutomationService } from "./survey-automation.service";
import {
  createAutomationSchema,
  patchAutomationSchema,
  type CreateAutomationInput,
  type PatchAutomationInput,
} from "./dto/survey-automation.schemas";

@Controller("surveys/:surveyId/automations")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class SurveyAutomationController {
  constructor(private readonly automations: SurveyAutomationService) {}

  @Get()
  @RequirePermission("surveys:automations:manage")
  list(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.automations.list(u.orgId, surveyId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("surveys:automations:manage")
  create(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body(new ZodValidationPipe(createAutomationSchema)) body: CreateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.create(u.orgId, surveyId, body);
  }

  @Patch(":automationId")
  @RequirePermission("surveys:automations:manage")
  patch(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("automationId") automationId: string,
    @Body(new ZodValidationPipe(patchAutomationSchema)) body: PatchAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.patch(u.orgId, surveyId, automationId, body);
  }

  @Delete(":automationId")
  @RequirePermission("surveys:automations:manage")
  remove(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("automationId") automationId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.remove(u.orgId, surveyId, automationId);
  }
}
