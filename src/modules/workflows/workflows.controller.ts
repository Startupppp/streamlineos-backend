import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, HttpCode } from "@nestjs/common";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
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

@Controller("workflows")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Get()
  @RequirePermission("workflows:workflows:view")
  listWorkflows(
    @Query(new ZodValidationPipe(WorkflowListQuerySchema)) query: WorkflowListQueryDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.listWorkflows(u.orgId, query);
  }

  @Post()
  @RequirePermission("workflows:workflows:create")
  createWorkflow(
    @Body(new ZodValidationPipe(CreateWorkflowSchema)) body: CreateWorkflowDto,
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
  handleApproval(
    @Param("approvalId") approvalId: string,
    @Body(new ZodValidationPipe(ApprovalActionSchema)) body: ApprovalActionDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.handleApproval(u.orgId, u.userId, approvalId, body);
  }

  @Get("executions")
  @RequirePermission("workflows:executions:view")
  listAllExecutions(
    @Query(new ZodValidationPipe(WorkflowExecutionQuerySchema)) query: WorkflowExecutionQueryDto,
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
  @RequirePermission("workflows:secrets:manage")
  createGlobalSecret(
    @Body(new ZodValidationPipe(CreateSecretSchema)) body: CreateSecretDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.createGlobalSecret(u.orgId, body);
  }

  @Delete("secrets/:secretId")
  @RequirePermission("workflows:secrets:manage")
  @HttpCode(204)
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
  deleteGlobalVariable(
    @Param("variableId") variableId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.deleteGlobalVariable(u.orgId, variableId);
  }

  @Get(":workflowId")
  @RequirePermission("workflows:workflows:view")
  getWorkflow(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.getWorkflow(u.orgId, workflowId);
  }

  @Patch(":workflowId")
  @RequirePermission("workflows:workflows:update")
  updateWorkflow(
    @Param("workflowId") workflowId: string,
    @Body(new ZodValidationPipe(UpdateWorkflowSchema)) body: UpdateWorkflowDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.updateWorkflow(u.orgId, u.userId, workflowId, body);
  }

  @Delete(":workflowId")
  @RequirePermission("workflows:workflows:delete")
  @HttpCode(204)
  deleteWorkflow(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.deleteWorkflow(u.orgId, u.userId, workflowId);
  }

  @Post(":workflowId/publish")
  @RequirePermission("workflows:workflows:publish")
  publishWorkflow(
    @Param("workflowId") workflowId: string,
    @Body(new ZodValidationPipe(PublishWorkflowSchema)) body: PublishWorkflowDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.publishWorkflow(u.orgId, u.userId, workflowId, body);
  }

  @Post(":workflowId/duplicate")
  @RequirePermission("workflows:workflows:create")
  duplicateWorkflow(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.duplicateWorkflow(u.orgId, u.userId, workflowId);
  }

  @Post(":workflowId/disable")
  @RequirePermission("workflows:workflows:update")
  @HttpCode(200)
  disableWorkflow(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.disableWorkflow(u.orgId, u.userId, workflowId);
  }

  @Post(":workflowId/archive")
  @RequirePermission("workflows:workflows:update")
  @HttpCode(200)
  archiveWorkflow(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.archiveWorkflow(u.orgId, u.userId, workflowId);
  }

  @Post(":workflowId/trigger")
  @RequirePermission("workflows:executions:manage")
  triggerWorkflow(
    @Param("workflowId") workflowId: string,
    @Body(new ZodValidationPipe(TriggerWorkflowSchema)) body: TriggerWorkflowDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.triggerWorkflow(u.orgId, u.userId, workflowId, body);
  }

  @Get(":workflowId/executions")
  @RequirePermission("workflows:executions:view")
  listExecutions(
    @Param("workflowId") workflowId: string,
    @Query(new ZodValidationPipe(WorkflowExecutionQuerySchema)) query: WorkflowExecutionQueryDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.listExecutions(u.orgId, workflowId, query);
  }

  @Get(":workflowId/executions/:executionId")
  @RequirePermission("workflows:executions:view")
  getExecution(
    @Param("workflowId") workflowId: string,
    @Param("executionId") executionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.getExecution(u.orgId, workflowId, executionId);
  }

  @Post(":workflowId/executions/:executionId/cancel")
  @RequirePermission("workflows:executions:manage")
  @HttpCode(200)
  cancelExecution(
    @Param("workflowId") workflowId: string,
    @Param("executionId") executionId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.cancelExecution(u.orgId, u.userId, workflowId, executionId);
  }

  @Get(":workflowId/schedules")
  @RequirePermission("workflows:schedules:manage")
  listSchedules(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.listSchedules(u.orgId, workflowId);
  }

  @Post(":workflowId/schedules")
  @RequirePermission("workflows:schedules:manage")
  createSchedule(
    @Param("workflowId") workflowId: string,
    @Body(new ZodValidationPipe(CreateScheduleSchema)) body: CreateScheduleDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.createSchedule(u.orgId, workflowId, body);
  }

  @Patch(":workflowId/schedules/:scheduleId")
  @RequirePermission("workflows:schedules:manage")
  updateSchedule(
    @Param("workflowId") workflowId: string,
    @Param("scheduleId") scheduleId: string,
    @Body(new ZodValidationPipe(UpdateScheduleSchema)) body: UpdateScheduleDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.updateSchedule(u.orgId, workflowId, scheduleId, body);
  }

  @Delete(":workflowId/schedules/:scheduleId")
  @RequirePermission("workflows:schedules:manage")
  @HttpCode(204)
  deleteSchedule(
    @Param("workflowId") workflowId: string,
    @Param("scheduleId") scheduleId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.deleteSchedule(u.orgId, workflowId, scheduleId);
  }

  @Get(":workflowId/secrets")
  @RequirePermission("workflows:secrets:manage")
  listSecrets(@Param("workflowId") workflowId: string, @CurrentUser() u: CurrentUserContext) {
    return this.workflowsService.listSecrets(u.orgId, workflowId);
  }

  @Post(":workflowId/secrets")
  @RequirePermission("workflows:secrets:manage")
  createSecret(
    @Param("workflowId") workflowId: string,
    @Body(new ZodValidationPipe(CreateSecretSchema)) body: CreateSecretDto,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.createSecret(u.orgId, workflowId, body);
  }

  @Delete(":workflowId/secrets/:secretId")
  @RequirePermission("workflows:secrets:manage")
  @HttpCode(204)
  deleteSecret(
    @Param("workflowId") workflowId: string,
    @Param("secretId") secretId: string,
    @CurrentUser() u: CurrentUserContext,
  ) {
    return this.workflowsService.deleteSecret(u.orgId, workflowId, secretId);
  }
}
