import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../../access/permission.guard";
import { RequirePermission } from "../../../access/require-permission.decorator";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { RequireModule } from "../../../../common/rbac/require-module.decorator";
import { ProjectsAutomationsService } from "./projects-automations.service";
import { BuildAutomationRunHistoryService } from "./build-automation-run-history.service";
import {
  createAutomationSchema,
  updateAutomationSchema,
  listAutomationRunsQuerySchema,
  listAutomationsQuerySchema,
  type CreateAutomationInput,
  type UpdateAutomationInput,
  type ListAutomationRunsQuery,
  type ListAutomationsQuery,
} from "../dto/automation.schemas";
import { Validate } from "../../../../common/validation/validate.decorator";
import { z } from "zod";
import { NoContentResponse, ResponseSchema } from "../../../../common/openapi/zod-operation-contracts";
import {
  projectAutomationListItemSchema,
  projectAutomationRowSchema,
  automationRunListSchema,
} from "../dto/build-core-response.schemas";

const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() }).strict();
const projectIdautomationIdParams = z.object({ projectId: z.coerce.number().int().positive(), automationId: z.coerce.number().int().positive() }).strict();

@RequireModule("build")
@Controller("build")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ProjectsAutomationsController {
  constructor(
    private readonly automations: ProjectsAutomationsService,
    private readonly runHistory: BuildAutomationRunHistoryService,
  ) {}

  @Get(":projectId/automations")
  @RequirePermission("build:view")
  @ResponseSchema(z.array(projectAutomationListItemSchema))
  @Validate({ params: projectIdParams, query: listAutomationsQuerySchema })
  list(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListAutomationsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.listAutomations(u, projectId, query);
  }

  /**
   * Phase 5 read surface: automation run history, cursor-paginated (BE-24/25),
   * permission-gated on the same `build:view` key `list()` above already uses
   * for the automation rules themselves — run history is visibility into what
   * those rules did, not a distinct resource with its own permission key.
   */
  @Get(":projectId/automations/runs")
  @RequirePermission("build:view")
  @ResponseSchema(automationRunListSchema)
  @Validate({ params: projectIdParams, query: listAutomationRunsQuerySchema })
  listRuns(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Query() query: ListAutomationRunsQuery,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.runHistory.listRuns(u, projectId, query);
  }

  @Post(":projectId/automations")
  @RequirePermission("build:manage")
  @HttpCode(201)
  @ResponseSchema(projectAutomationRowSchema)
  @Validate({ params: projectIdParams, body: createAutomationSchema })
  create(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Body() body: CreateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.createAutomation(u, projectId, body);
  }

  @Patch(":projectId/automations/:automationId")
  @RequirePermission("build:manage")
  @ResponseSchema(projectAutomationRowSchema)
  @Validate({ params: projectIdautomationIdParams, body: updateAutomationSchema })
  update(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("automationId", ParseIntPipe) automationId: number,
    @Body() body: UpdateAutomationInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.updateAutomation(u, projectId, automationId, body);
  }

  @Delete(":projectId/automations/:automationId")
  @RequirePermission("build:manage")
  @HttpCode(204)
  @NoContentResponse()
  @Validate({ params: projectIdautomationIdParams })
  delete(
    @Param("projectId", ParseIntPipe) projectId: number,
    @Param("automationId", ParseIntPipe) automationId: number,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.automations.deleteAutomation(u, projectId, automationId);
  }
}
