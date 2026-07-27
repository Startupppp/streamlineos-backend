import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ProjectsAutomationsService } from "./projects-automations.service";
import {
  createAutomationSchema,
  updateAutomationSchema,
  type CreateAutomationInput,
  type UpdateAutomationInput,
} from "./dto/automation.schemas";

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsAutomationsController {
  constructor(private readonly automations: ProjectsAutomationsService) {}

  @Get(":projectId/automations")
  @RequirePermission("build:view")
  list(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.listAutomations(u, projectId);
  }

  @Post(":projectId/automations")
  @RequirePermission("build:view")
  @HttpCode(201)
  create(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createAutomationSchema)) body: CreateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.createAutomation(u, projectId, body);
  }

  @Patch(":projectId/automations/:automationId")
  @RequirePermission("build:view")
  update(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("automationId", ParseIntPipe) automationId: number,
    @Body(new ZodValidationPipe(updateAutomationSchema)) body: UpdateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.updateAutomation(u, projectId, automationId, body);
  }

  @Delete(":projectId/automations/:automationId")
  @RequirePermission("build:view")
  @HttpCode(204)
  delete(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("automationId", ParseIntPipe) automationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.deleteAutomation(u, projectId, automationId);
  }
}
