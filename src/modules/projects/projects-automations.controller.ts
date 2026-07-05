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

@RequireModule("projects")
@Controller("projects")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsAutomationsController {
  constructor(private readonly automations: ProjectsAutomationsService) {}

  @Get(":projectId/automations")
  @RequirePermission("projects:view")
  list(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.listAutomations(u.orgId, projectId);
  }

  @Post(":projectId/automations")
  @RequirePermission("projects:manage")
  @HttpCode(201)
  create(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createAutomationSchema)) body: CreateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.createAutomation(u.orgId, projectId, u.userId, body);
  }

  @Patch(":projectId/automations/:automationId")
  @RequirePermission("projects:manage")
  update(
    @Param("automationId", ParseIntPipe) automationId: number,
    @Body(new ZodValidationPipe(updateAutomationSchema)) body: UpdateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.updateAutomation(u.orgId, automationId, body);
  }

  @Delete(":projectId/automations/:automationId")
  @RequirePermission("projects:manage")
  @HttpCode(204)
  delete(
    @Param("automationId", ParseIntPipe) automationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.deleteAutomation(u.orgId, automationId);
  }
}
