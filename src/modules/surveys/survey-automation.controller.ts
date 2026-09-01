import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { Validate } from "../../common/validation/validate.decorator";
import { SurveyAutomationService } from "./survey-automation.service";
import {
  createAutomationSchema,
  patchAutomationSchema,
  type CreateAutomationInput,
  type PatchAutomationInput,
} from "./dto/survey-automation.schemas";

const surveyIdParams = z.object({ surveyId: z.coerce.number().int().positive() }).strict();
const surveyAndAutomationIdParams = z.object({ surveyId: z.coerce.number().int().positive(), automationId: z.string().min(1) }).strict();

@RequireModule("surveys")
@Controller("surveys/:surveyId/automations")
@UseGuards(JwtAuthGuard, ModuleGuard, PermissionGuard)
export class SurveyAutomationController {
  constructor(private readonly automations: SurveyAutomationService) {}

  @Get()
  @RequirePermission("surveys:automations:manage")
  @Validate({ params: surveyIdParams })
  list(@Param("surveyId", ParseIntPipe) surveyId: number, @CurrentUser() u: CurrentUserContext) {
    return this.automations.list(u.orgId, surveyId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("surveys:automations:manage")
  @Validate({ params: surveyIdParams, body: createAutomationSchema })
  create(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Body() body: CreateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.create(u.orgId, surveyId, body);
  }

  @Patch(":automationId")
  @RequirePermission("surveys:automations:manage")
  @Validate({ params: surveyAndAutomationIdParams, body: patchAutomationSchema })
  patch(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("automationId") automationId: string,
    @Body() body: PatchAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.patch(u.orgId, surveyId, automationId, body);
  }

  @Delete(":automationId")
  @RequirePermission("surveys:automations:manage")
  @Validate({ params: surveyAndAutomationIdParams })
  remove(
    @Param("surveyId", ParseIntPipe) surveyId: number,
    @Param("automationId") automationId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.remove(u.orgId, surveyId, automationId);
  }
}
