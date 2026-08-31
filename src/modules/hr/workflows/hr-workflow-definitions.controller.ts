import { Controller, Get, Post, Patch, Delete, Body, Param, Query, ParseIntPipe, UseGuards, HttpCode } from "@nestjs/common";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../../access/permission.guard";
import { RequirePermission } from "../../access/require-permission.decorator";
import { RequireModule } from "../../../common/rbac/require-module.decorator";
import { CurrentUser } from "../../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { HrWorkflowDefinitionsService } from "./hr-workflow-definitions.service";
import {
  CreateWorkflowDefinitionSchema,
  UpdateWorkflowDefinitionSchema,
  WorkflowDefinitionQuerySchema,
  WorkflowInstanceQuerySchema,
  SimulateWorkflowSchema,
  type CreateWorkflowDefinitionDto,
  type UpdateWorkflowDefinitionDto,
  type WorkflowDefinitionQueryDto,
  type WorkflowInstanceQueryDto,
  type SimulateWorkflowDto,
} from "./dto/workflow.schemas";
import { HrWorkflowInstancesService } from "./hr-workflow-instances.service";
import { Validate } from "../../../common/validation/validate.decorator";
import { z } from "zod";

const workflowIdParams = z.object({ workflowId: z.coerce.number().int().positive() }).strict();

@RequireModule("hr")
@UseGuards(JwtAuthGuard)
@Controller("hr/workflows")
export class HrWorkflowDefinitionsController {
  constructor(
    private readonly definitionsService: HrWorkflowDefinitionsService,
    private readonly instancesService: HrWorkflowInstancesService,
  ) {}

  @Get()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:view")
  @Validate({ query: WorkflowDefinitionQuerySchema })
  list(
    @CurrentUser() u: CurrentUserContext,
    @Query() query: WorkflowDefinitionQueryDto,
  ) {
    return this.definitionsService.list(u.orgId, query);
  }

  @Post()
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:manage")
  @Validate({ body: CreateWorkflowDefinitionSchema })
  create(
    @CurrentUser() u: CurrentUserContext,
    @Body() body: CreateWorkflowDefinitionDto,
  ) {
    return this.definitionsService.create(u.orgId, body);
  }

  @Get(":workflowId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:view")
  @Validate({ params: workflowIdParams })
  get(
    @CurrentUser() u: CurrentUserContext,
    @Param("workflowId", ParseIntPipe) workflowId: number,
  ) {
    return this.definitionsService.get(u.orgId, workflowId);
  }

  @Patch(":workflowId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:manage")
  @Validate({ params: workflowIdParams, body: UpdateWorkflowDefinitionSchema })
  update(
    @CurrentUser() u: CurrentUserContext,
    @Param("workflowId", ParseIntPipe) workflowId: number,
    @Body() body: UpdateWorkflowDefinitionDto,
  ) {
    return this.definitionsService.update(u.orgId, workflowId, body);
  }

  @Delete(":workflowId")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:manage")
  @HttpCode(204)
  @Validate({ params: workflowIdParams })
  remove(
    @CurrentUser() u: CurrentUserContext,
    @Param("workflowId", ParseIntPipe) workflowId: number,
  ) {
    return this.definitionsService.softDelete(u.orgId, workflowId);
  }

  @Post(":workflowId/activate")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:manage")
  @HttpCode(200)
  @Validate({ params: workflowIdParams })
  activate(
    @CurrentUser() u: CurrentUserContext,
    @Param("workflowId", ParseIntPipe) workflowId: number,
  ) {
    return this.definitionsService.activate(u.orgId, workflowId);
  }

  @Post(":workflowId/archive")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:manage")
  @HttpCode(200)
  @Validate({ params: workflowIdParams })
  archive(
    @CurrentUser() u: CurrentUserContext,
    @Param("workflowId", ParseIntPipe) workflowId: number,
  ) {
    return this.definitionsService.archive(u.orgId, workflowId);
  }

  @Post(":workflowId/duplicate")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:manage")
  @Validate({ params: workflowIdParams })
  duplicate(
    @CurrentUser() u: CurrentUserContext,
    @Param("workflowId", ParseIntPipe) workflowId: number,
  ) {
    return this.definitionsService.duplicate(u.orgId, workflowId);
  }

  @Post(":workflowId/simulate")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:view")
  @HttpCode(200)
  @Validate({ params: workflowIdParams, body: SimulateWorkflowSchema })
  simulate(
    @CurrentUser() u: CurrentUserContext,
    @Param("workflowId", ParseIntPipe) workflowId: number,
    @Body() body: SimulateWorkflowDto,
  ) {
    return this.definitionsService.simulate(u.orgId, workflowId, body);
  }

  @Get(":workflowId/instances")
  @UseGuards(PermissionGuard)
  @RequirePermission("hr:workflows:view")
  @Validate({ params: workflowIdParams, query: WorkflowInstanceQuerySchema })
  listInstances(
    @CurrentUser() u: CurrentUserContext,
    @Param("workflowId", ParseIntPipe) workflowId: number,
    @Query() query: WorkflowInstanceQueryDto,
  ) {
    return this.instancesService.listForDefinition(u.orgId, workflowId, query);
  }
}
