import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, HttpCode } from "@nestjs/common";
import { Idempotent } from "../../common/idempotency/idempotent.decorator";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { WorkflowsService } from "./workflows.service";
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
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Get()
  @RequirePermission("workflows:workflows:view")
  @Validate({ query: WorkflowListQuerySchema })
  listWorkflows(
    @Query() query: WorkflowListQueryDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.listWorkflows(u.orgId, query);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("workflows:workflows:create")
  @Validate({ body: CreateWorkflowSchema })
  createWorkflow(
    @Body() body: CreateWorkflowDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.createWorkflow(u.orgId, u.userId, body);
  }

  @Get("analytics")
  @RequirePermission("workflows:analytics:view")
  getAnalytics(@CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.getAnalytics(u.orgId);
  }

  @Get("templates")
  @RequirePermission("workflows:templates:view")
  listTemplates() {
    return this.workflowsService.listTemplates();
  }

  @Get("approvals/pending")
  @RequirePermission("workflows:approvals:view")
  getPendingApprovals(@CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.getApprovals(u.orgId, u.userId);
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
    return this.workflowsService.handleApproval(u.orgId, u.userId, approvalId, body);
  }

  @Get("executions")
  @RequirePermission("workflows:executions:view")
  @Validate({ query: WorkflowExecutionQuerySchema })
  listAllExecutions(
    @Query() query: WorkflowExecutionQueryDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.listAllExecutions(u.orgId, query);
  }

  @Get("schedules")
  @RequirePermission("workflows:schedules:manage")
  listAllSchedules(@CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.listAllSchedules(u.orgId);
  }

  @Get("secrets")
  @RequirePermission("workflows:secrets:manage")
  listGlobalSecrets(@CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.listGlobalSecrets(u.orgId);
  }

  @Post("secrets")
  @HttpCode(201)
  @RequirePermission("workflows:secrets:manage")
  @Validate({ body: CreateSecretSchema })
  createGlobalSecret(
    @Body() body: CreateSecretDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.createGlobalSecret(u.orgId, body);
  }

  @Delete("secrets/:secretId")
  @RequirePermission("workflows:secrets:manage")
  @HttpCode(204)
  @Validate({ params: secretIdParams })
  deleteGlobalSecret(
    @Param("secretId") secretId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.deleteGlobalSecret(u.orgId, secretId);
  }

  @Get("variables")
  @RequirePermission("workflows:variables:manage")
  listGlobalVariables(@CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.listGlobalVariables(u.orgId);
  }

  @Delete("variables/:variableId")
  @RequirePermission("workflows:variables:manage")
  @HttpCode(204)
  @Validate({ params: variableIdParams })
  deleteGlobalVariable(
    @Param("variableId") variableId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.deleteGlobalVariable(u.orgId, variableId);
  }

  @Get(":workflowId")
  @RequirePermission("workflows:workflows:view")
  @Validate({ params: workflowIdParams })
  getWorkflow(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.getWorkflow(u.orgId, workflowId);
  }

  @Patch(":workflowId")
  @RequirePermission("workflows:workflows:update")
  @Validate({ params: workflowIdParams, body: UpdateWorkflowSchema })
  updateWorkflow(
    @Param("workflowId") workflowId: string,
    @Body() body: UpdateWorkflowDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.updateWorkflow(u.orgId, u.userId, workflowId, body);
  }

  @Delete(":workflowId")
  @RequirePermission("workflows:workflows:delete")
  @HttpCode(204)
  @Validate({ params: workflowIdParams })
  deleteWorkflow(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.deleteWorkflow(u.orgId, u.userId, workflowId);
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
    return this.workflowsService.publishWorkflow(u.orgId, u.userId, workflowId, body);
  }

  @Post(":workflowId/duplicate")
  @BodylessAction()
  @RequirePermission("workflows:workflows:create")
  @Validate({ params: workflowIdParams })
  duplicateWorkflow(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.duplicateWorkflow(u.orgId, u.userId, workflowId);
  }

  @Post(":workflowId/disable")
  @BodylessAction()
  @RequirePermission("workflows:workflows:update")
  @HttpCode(200)
  @Validate({ params: workflowIdParams })
  disableWorkflow(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.disableWorkflow(u.orgId, u.userId, workflowId);
  }

  @Post(":workflowId/archive")
  @BodylessAction()
  @RequirePermission("workflows:workflows:update")
  @HttpCode(200)
  @Validate({ params: workflowIdParams })
  archiveWorkflow(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.archiveWorkflow(u.orgId, u.userId, workflowId);
  }

  @Post(":workflowId/trigger")
  @RequirePermission("workflows:executions:manage")
  @Validate({ params: workflowIdParams, body: TriggerWorkflowSchema })
  triggerWorkflow(
    @Param("workflowId") workflowId: string,
    @Body() body: TriggerWorkflowDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.triggerWorkflow(u.orgId, u.userId, workflowId, body);
  }

  @Get(":workflowId/executions")
  @RequirePermission("workflows:executions:view")
  @Validate({ params: workflowIdParams, query: WorkflowExecutionQuerySchema })
  listExecutions(
    @Param("workflowId") workflowId: string,
    @Query() query: WorkflowExecutionQueryDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.listExecutions(u.orgId, workflowId, query);
  }

  @Get(":workflowId/executions/:executionId")
  @RequirePermission("workflows:executions:view")
  @Validate({ params: workflowIdexecutionIdParams })
  getExecution(
    @Param("workflowId") workflowId: string,
    @Param("executionId") executionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.getExecution(u.orgId, workflowId, executionId);
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
    return this.workflowsService.cancelExecution(u.orgId, u.userId, workflowId, executionId);
  }

  @Get(":workflowId/schedules")
  @RequirePermission("workflows:schedules:manage")
  @Validate({ params: workflowIdParams })
  listSchedules(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.listSchedules(u.orgId, workflowId);
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
    return this.workflowsService.createSchedule(u.orgId, workflowId, body);
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
    return this.workflowsService.updateSchedule(u.orgId, workflowId, scheduleId, body);
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
    return this.workflowsService.deleteSchedule(u.orgId, workflowId, scheduleId);
  }

  @Get(":workflowId/secrets")
  @RequirePermission("workflows:secrets:manage")
  @Validate({ params: workflowIdParams })
  listSecrets(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.listSecrets(u.orgId, workflowId);
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
    return this.workflowsService.createSecret(u.orgId, workflowId, body);
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
    return this.workflowsService.deleteSecret(u.orgId, workflowId, secretId);
  }
}
