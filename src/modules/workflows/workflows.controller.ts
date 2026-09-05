import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, HttpCode } from "@nestjs/common";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { WorkflowsCrudService } from "./workflows-crud.service";
import { WorkflowsExecutionService } from "./workflows-execution.service";
import { WorkflowsSchedulesService } from "./workflows-schedules.service";
import { WorkflowsSecretsService } from "./workflows-secrets.service";
import { WorkflowsVariablesService } from "./workflows-variables.service";
import { WorkflowsAnalyticsService } from "./workflows-analytics.service";
import {
  CreateWorkflowSchema,
  UpdateWorkflowSchema,
  PublishWorkflowSchema,
  WorkflowListQuerySchema,
  WorkflowExecutionQuerySchema,
  TriggerWorkflowSchema,
  ApprovalActionSchema,
  CreateScheduleSchema,
  UpdateScheduleSchema,
  CreateSecretSchema,
  ScheduleListQuerySchema,
  SecretListQuerySchema,
  type CreateWorkflowDto,
  type UpdateWorkflowDto,
  type PublishWorkflowDto,
  type WorkflowListQueryDto,
  type WorkflowExecutionQueryDto,
  type TriggerWorkflowDto,
  type ApprovalActionDto,
  type CreateScheduleDto,
  type UpdateScheduleDto,
  type CreateSecretDto,
  type ScheduleListQueryDto,
  type SecretListQueryDto,
} from "./dto/workflow.schemas";
import { Validate } from "../../common/validation/validate.decorator";
import { BodylessAction } from "../../common/openapi/zod-operation-contracts";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { z } from "zod";

const approvalIdParams = z.object({ approvalId: z.string().min(1) }).strict();
const secretIdParams = z.object({ secretId: z.string().min(1) }).strict();
const variableIdParams = z.object({ variableId: z.string().min(1) }).strict();
const workflowIdParams = z.object({ workflowId: z.string().min(1) }).strict();
const workflowIdexecutionIdParams = z.object({ workflowId: z.string().min(1), executionId: z.string().min(1) }).strict();
const workflowIdscheduleIdParams = z.object({ workflowId: z.string().min(1), scheduleId: z.string().min(1) }).strict();
const workflowIdsecretIdParams = z.object({ workflowId: z.string().min(1), secretId: z.string().min(1) }).strict();

@Controller("workflows")
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequireModule("workflows")
export class WorkflowsController {
  constructor(
    private readonly crud: WorkflowsCrudService,
    private readonly execution: WorkflowsExecutionService,
    private readonly schedules: WorkflowsSchedulesService,
    private readonly secrets: WorkflowsSecretsService,
    private readonly variables: WorkflowsVariablesService,
    private readonly analytics: WorkflowsAnalyticsService,
  ) {}

  @Get()
  @RequirePermission("workflows:workflows:view")
  @Validate({ query: WorkflowListQuerySchema })
  listWorkflows(
    @Query() query: WorkflowListQueryDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.crud.listWorkflows(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("workflows:workflows:create")
  @Validate({ body: CreateWorkflowSchema })
  createWorkflow(
    @Body() body: CreateWorkflowDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.crud.createWorkflow(u.orgId, u.userId, body);
  }

  @Get("analytics")
  @RequirePermission("workflows:analytics:view")
  getAnalytics(@CurrentUser() u: CurrentUserContext) {
    return this.analytics.getAnalytics(u.orgId);
  }

  @Get("templates")
  @RequirePermission("workflows:templates:view")
  listTemplates() {
    return [];
  }

  @Get("approvals/pending")
  @RequirePermission("workflows:approvals:view")
  getPendingApprovals(@CurrentUser() u: CurrentUserContext) {
    return this.execution.getApprovals(u.orgId, u.userId);
  }

  @Post("approvals/:approvalId/action")
  @RequirePermission("workflows:approvals:manage")
  @HttpCode(200)
  @Validate({ params: approvalIdParams, body: ApprovalActionSchema })
  handleApproval(
    @Param("approvalId") approvalId: string,
    @Body() body: ApprovalActionDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.execution.handleApproval(u.orgId, u.userId, approvalId, body);
  }

  @Get("executions")
  @RequirePermission("workflows:executions:view")
  @Validate({ query: WorkflowExecutionQuerySchema })
  listAllExecutions(
    @Query() query: WorkflowExecutionQueryDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.execution.listAllExecutions(u.orgId, query);
  }

  @Get("schedules")
  @RequirePermission("workflows:schedules:manage")
  @Validate({ query: ScheduleListQuerySchema })
  listAllSchedules(@Query() query: ScheduleListQueryDto, @CurrentUser() u: CurrentUserContext) {
    return this.schedules.listAllSchedules(u.orgId, query);
  }

  @Get("secrets")
  @RequirePermission("workflows:secrets:manage")
  @Validate({ query: SecretListQuerySchema })
  listGlobalSecrets(@Query() query: SecretListQueryDto, @CurrentUser() u: CurrentUserContext) {
    return this.secrets.listGlobalSecrets(u.orgId, query);
  }

  @Post("secrets")
  @HttpCode(201)
  @RequirePermission("workflows:secrets:manage")
  @Validate({ body: CreateSecretSchema })
  createGlobalSecret(
    @Body() body: CreateSecretDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.secrets.createGlobalSecret(u.orgId, body);
  }

  @Delete("secrets/:secretId")
  @RequirePermission("workflows:secrets:manage")
  @HttpCode(204)
  @Validate({ params: secretIdParams })
  deleteGlobalSecret(
    @Param("secretId") secretId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.secrets.deleteGlobalSecret(u.orgId, secretId);
  }

  @Get("variables")
  @RequirePermission("workflows:variables:manage")
  listGlobalVariables(@CurrentUser() u: CurrentUserContext) {
    return this.variables.listGlobalVariables(u.orgId);
  }

  @Delete("variables/:variableId")
  @RequirePermission("workflows:variables:manage")
  @HttpCode(204)
  @Validate({ params: variableIdParams })
  deleteGlobalVariable(
    @Param("variableId") variableId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.variables.deleteGlobalVariable(u.orgId, variableId);
  }

  @Get(":workflowId")
  @RequirePermission("workflows:workflows:view")
  @Validate({ params: workflowIdParams })
  getWorkflow(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.crud.getWorkflow(u.orgId, workflowId);
  }

  @Patch(":workflowId")
  @RequirePermission("workflows:workflows:update")
  @Validate({ params: workflowIdParams, body: UpdateWorkflowSchema })
  updateWorkflow(
    @Param("workflowId") workflowId: string,
    @Body() body: UpdateWorkflowDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.crud.updateWorkflow(u.orgId, u.userId, workflowId, body);
  }

  @Delete(":workflowId")
  @RequirePermission("workflows:workflows:delete")
  @HttpCode(204)
  @Validate({ params: workflowIdParams })
  deleteWorkflow(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.crud.deleteWorkflow(u.orgId, u.userId, workflowId);
  }

  @Post(":workflowId/publish")
  @Idempotent("workflows.workflow.publish")
  @RequirePermission("workflows:workflows:publish")
  @Validate({ params: workflowIdParams, body: PublishWorkflowSchema })
  publishWorkflow(
    @Param("workflowId") workflowId: string,
    @Body() body: PublishWorkflowDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.crud.publishWorkflow(u.orgId, u.userId, workflowId, body);
  }

  @Post(":workflowId/duplicate")
  @BodylessAction()
  @RequirePermission("workflows:workflows:create")
  @Validate({ params: workflowIdParams })
  duplicateWorkflow(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.crud.duplicateWorkflow(u.orgId, u.userId, workflowId);
  }

  @Post(":workflowId/disable")
  @BodylessAction()
  @RequirePermission("workflows:workflows:update")
  @HttpCode(200)
  @Validate({ params: workflowIdParams })
  disableWorkflow(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.crud.disableWorkflow(u.orgId, u.userId, workflowId);
  }

  @Post(":workflowId/archive")
  @BodylessAction()
  @RequirePermission("workflows:workflows:update")
  @HttpCode(200)
  @Validate({ params: workflowIdParams })
  archiveWorkflow(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.crud.archiveWorkflow(u.orgId, u.userId, workflowId);
  }

  @Post(":workflowId/trigger")
  @RequirePermission("workflows:executions:manage")
  @Validate({ params: workflowIdParams, body: TriggerWorkflowSchema })
  triggerWorkflow(
    @Param("workflowId") workflowId: string,
    @Body() body: TriggerWorkflowDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.execution.triggerWorkflow(u.orgId, u.userId, workflowId, body);
  }

  @Get(":workflowId/executions")
  @RequirePermission("workflows:executions:view")
  @Validate({ params: workflowIdParams, query: WorkflowExecutionQuerySchema })
  listExecutions(
    @Param("workflowId") workflowId: string,
    @Query() query: WorkflowExecutionQueryDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.execution.listExecutions(u.orgId, workflowId, query);
  }

  @Get(":workflowId/executions/:executionId")
  @RequirePermission("workflows:executions:view")
  @Validate({ params: workflowIdexecutionIdParams })
  getExecution(
    @Param("workflowId") workflowId: string,
    @Param("executionId") executionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.execution.getExecution(u.orgId, workflowId, executionId);
  }

  @Post(":workflowId/executions/:executionId/cancel")
  @BodylessAction()
  @RequirePermission("workflows:executions:manage")
  @HttpCode(200)
  @Validate({ params: workflowIdexecutionIdParams })
  cancelExecution(
    @Param("workflowId") workflowId: string,
    @Param("executionId") executionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.execution.cancelExecution(u.orgId, u.userId, workflowId, executionId);
  }

  @Get(":workflowId/schedules")
  @RequirePermission("workflows:schedules:manage")
  @Validate({ params: workflowIdParams, query: ScheduleListQuerySchema })
  listSchedules(
    @Param("workflowId") workflowId: string,
    @Query() query: ScheduleListQueryDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.schedules.listSchedules(u.orgId, workflowId, query);
  }

  @Post(":workflowId/schedules")
  @HttpCode(201)
  @RequirePermission("workflows:schedules:manage")
  @Validate({ params: workflowIdParams, body: CreateScheduleSchema })
  createSchedule(
    @Param("workflowId") workflowId: string,
    @Body() body: CreateScheduleDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.schedules.createSchedule(u.orgId, workflowId, body);
  }

  @Patch(":workflowId/schedules/:scheduleId")
  @RequirePermission("workflows:schedules:manage")
  @Validate({ params: workflowIdscheduleIdParams, body: UpdateScheduleSchema })
  updateSchedule(
    @Param("workflowId") workflowId: string,
    @Param("scheduleId") scheduleId: string,
    @Body() body: UpdateScheduleDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.schedules.updateSchedule(u.orgId, workflowId, scheduleId, body);
  }

  @Delete(":workflowId/schedules/:scheduleId")
  @RequirePermission("workflows:schedules:manage")
  @HttpCode(204)
  @Validate({ params: workflowIdscheduleIdParams })
  deleteSchedule(
    @Param("workflowId") workflowId: string,
    @Param("scheduleId") scheduleId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.schedules.deleteSchedule(u.orgId, workflowId, scheduleId);
  }

  @Get(":workflowId/secrets")
  @RequirePermission("workflows:secrets:manage")
  @Validate({ params: workflowIdParams, query: SecretListQuerySchema })
  listSecrets(
    @Param("workflowId") workflowId: string,
    @Query() query: SecretListQueryDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.secrets.listSecrets(u.orgId, workflowId, query);
  }

  @Post(":workflowId/secrets")
  @HttpCode(201)
  @RequirePermission("workflows:secrets:manage")
  @Validate({ params: workflowIdParams, body: CreateSecretSchema })
  createSecret(
    @Param("workflowId") workflowId: string,
    @Body() body: CreateSecretDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.secrets.createSecret(u.orgId, workflowId, body);
  }

  @Delete(":workflowId/secrets/:secretId")
  @RequirePermission("workflows:secrets:manage")
  @HttpCode(204)
  @Validate({ params: workflowIdsecretIdParams })
  deleteSecret(
    @Param("workflowId") workflowId: string,
    @Param("secretId") secretId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.secrets.deleteSecret(u.orgId, workflowId, secretId);
  }
}
