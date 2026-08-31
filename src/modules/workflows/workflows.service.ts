import { Injectable } from "@nestjs/common";
import { WorkflowsCrudService } from "./workflows-crud.service";
import { WorkflowsExecutionService } from "./workflows-execution.service";
import { WorkflowsSchedulesService } from "./workflows-schedules.service";
import { WorkflowsSecretsService } from "./workflows-secrets.service";
import { WorkflowsVariablesService } from "./workflows-variables.service";
import { WorkflowsAnalyticsService } from "./workflows-analytics.service";
import type {
  CreateWorkflowDto,
  UpdateWorkflowDto,
  PublishWorkflowDto,
  WorkflowListQueryDto,
  WorkflowExecutionQueryDto,
  TriggerWorkflowDto,
  ApprovalActionDto,
  CreateScheduleDto,
  UpdateScheduleDto,
  CreateSecretDto,
} from "./dto/workflow.schemas";

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly crud: WorkflowsCrudService,
    private readonly execution: WorkflowsExecutionService,
    private readonly schedules: WorkflowsSchedulesService,
    private readonly secrets: WorkflowsSecretsService,
    private readonly variables: WorkflowsVariablesService,
    private readonly analytics: WorkflowsAnalyticsService,
  ) {}

  listWorkflows(orgId: string, query: WorkflowListQueryDto) {
    return this.crud.listWorkflows(orgId, query);
  }

  getWorkflow(orgId: string, workflowId: string) {
    return this.crud.getWorkflow(orgId, workflowId);
  }

  createWorkflow(orgId: string, userId: string, dto: CreateWorkflowDto) {
    return this.crud.createWorkflow(orgId, userId, dto);
  }

  updateWorkflow(orgId: string, userId: string, workflowId: string, dto: UpdateWorkflowDto) {
    return this.crud.updateWorkflow(orgId, userId, workflowId, dto);
  }

  deleteWorkflow(orgId: string, userId: string, workflowId: string) {
    return this.crud.deleteWorkflow(orgId, userId, workflowId);
  }

  publishWorkflow(orgId: string, userId: string, workflowId: string, dto: PublishWorkflowDto) {
    return this.crud.publishWorkflow(orgId, userId, workflowId, dto);
  }

  duplicateWorkflow(orgId: string, userId: string, workflowId: string) {
    return this.crud.duplicateWorkflow(orgId, userId, workflowId);
  }

  disableWorkflow(orgId: string, userId: string, workflowId: string) {
    return this.crud.disableWorkflow(orgId, userId, workflowId);
  }

  archiveWorkflow(orgId: string, userId: string, workflowId: string) {
    return this.crud.archiveWorkflow(orgId, userId, workflowId);
  }

  triggerWorkflow(orgId: string, userId: string, workflowId: string, dto: TriggerWorkflowDto) {
    return this.execution.triggerWorkflow(orgId, userId, workflowId, dto);
  }

  listExecutions(orgId: string, workflowId: string, query: WorkflowExecutionQueryDto) {
    return this.execution.listExecutions(orgId, workflowId, query);
  }

  getExecution(orgId: string, workflowId: string, executionId: string) {
    return this.execution.getExecution(orgId, workflowId, executionId);
  }

  cancelExecution(orgId: string, userId: string, workflowId: string, executionId: string) {
    return this.execution.cancelExecution(orgId, userId, workflowId, executionId);
  }

  listAllExecutions(orgId: string, query: WorkflowExecutionQueryDto) {
    return this.execution.listAllExecutions(orgId, query);
  }

  getApprovals(orgId: string, userId: string) {
    return this.execution.getApprovals(orgId, userId);
  }

  handleApproval(orgId: string, userId: string, approvalId: string, dto: ApprovalActionDto) {
    return this.execution.handleApproval(orgId, userId, approvalId, dto);
  }

  listTemplates() {
    return Promise.resolve([]);
  }

  getAnalytics(orgId: string) {
    return this.analytics.getAnalytics(orgId);
  }

  listAllSchedules(orgId: string) {
    return this.schedules.listAllSchedules(orgId);
  }

  listSchedules(orgId: string, workflowId: string) {
    return this.schedules.listSchedules(orgId, workflowId);
  }

  createSchedule(orgId: string, workflowId: string, dto: CreateScheduleDto) {
    return this.schedules.createSchedule(orgId, workflowId, dto);
  }

  updateSchedule(orgId: string, workflowId: string, scheduleId: string, dto: UpdateScheduleDto) {
    return this.schedules.updateSchedule(orgId, workflowId, scheduleId, dto);
  }

  deleteSchedule(orgId: string, workflowId: string, scheduleId: string) {
    return this.schedules.deleteSchedule(orgId, workflowId, scheduleId);
  }

  listSecrets(orgId: string, workflowId: string) {
    return this.secrets.listSecrets(orgId, workflowId);
  }

  createSecret(orgId: string, workflowId: string, dto: CreateSecretDto) {
    return this.secrets.createSecret(orgId, workflowId, dto);
  }

  deleteSecret(orgId: string, workflowId: string, secretId: string) {
    return this.secrets.deleteSecret(orgId, workflowId, secretId);
  }

  listGlobalSecrets(orgId: string) {
    return this.secrets.listGlobalSecrets(orgId);
  }

  createGlobalSecret(orgId: string, dto: CreateSecretDto) {
    return this.secrets.createGlobalSecret(orgId, dto);
  }

  deleteGlobalSecret(orgId: string, secretId: string) {
    return this.secrets.deleteGlobalSecret(orgId, secretId);
  }

  listGlobalVariables(orgId: string) {
    return this.variables.listGlobalVariables(orgId);
  }

  deleteGlobalVariable(orgId: string, variableId: string) {
    return this.variables.deleteGlobalVariable(orgId, variableId);
  }
}
