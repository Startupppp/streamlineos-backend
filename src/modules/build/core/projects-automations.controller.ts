import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { ProjectsAutomationsService } from "./projects-automations.service";
import {
  createAutomationSchema,
  updateAutomationSchema,
  type CreateAutomationInput,
  type UpdateAutomationInput,
} from "./dto/automation.schemas";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectIdautomationIdParams = z.object({ projectId: z.coerce.number().int().positive(), automationId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsAutomationsController {
  constructor(private readonly automations: ProjectsAutomationsService) {}

  @Get(":projectId/automations")
  @RequirePermission("build:view")
  @Validate({ params: projectIdParams })
  list(
    @Param("projectId", ParseIntPipe) projectId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.listAutomations(u, projectId);
  }

  @Post(":projectId/automations")
  @RequirePermission("build:manage")
  @HttpCode(201)
  @Validate({ params: projectIdParams })
  create(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body(new ZodValidationPipe(createAutomationSchema)) body: CreateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.createAutomation(u, projectId, body);
  }

  @Patch(":projectId/automations/:automationId")
  @RequirePermission("build:manage")
  @Validate({ params: projectIdautomationIdParams })
  update(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("automationId", ParseIntPipe) automationId: number,
    @Body(new ZodValidationPipe(updateAutomationSchema)) body: UpdateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.updateAutomation(u, projectId, automationId, body);
  }

  @Delete(":projectId/automations/:automationId")
  @RequirePermission("build:manage")
  @HttpCode(204)
  @Validate({ params: projectIdautomationIdParams })
  delete(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("automationId", ParseIntPipe) automationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.deleteAutomation(u, projectId, automationId);
  }
}
