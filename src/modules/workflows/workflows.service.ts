import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import {
  workflows,
  workflowVersions,
  workflowExecutions,
  workflowApprovals,
  workflowSchedules,
  workflowSecrets,
  workflowVariables,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { WorkflowsCrudService } from "./workflows-crud.service";
import { WorkflowsExecutionService } from "./workflows-execution.service";
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
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly crud: WorkflowsCrudService,
    private readonly execution: WorkflowsExecutionService,
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

  updateWorkflow(
    orgId: string,
    userId: string,
    workflowId: string,
    dto: UpdateWorkflowDto,
  ) {
    return this.crud.updateWorkflow(orgId, userId, workflowId, dto);
  }

  deleteWorkflow(orgId: string, userId: string, workflowId: string) {
    return this.crud.deleteWorkflow(orgId, userId, workflowId);
  }

  publishWorkflow(
    orgId: string,
    userId: string,
    workflowId: string,
    dto: PublishWorkflowDto,
  ) {
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

  triggerWorkflow(
    orgId: string,
    userId: string,
    workflowId: string,
    dto: TriggerWorkflowDto,
  ) {
    return this.execution.triggerWorkflow(orgId, userId, workflowId, dto);
  }

  listExecutions(
    orgId: string,
    workflowId: string,
    query: WorkflowExecutionQueryDto,
  ) {
    return this.execution.listExecutions(orgId, workflowId, query);
  }

  getExecution(orgId: string, workflowId: string, executionId: string) {
    return this.execution.getExecution(orgId, workflowId, executionId);
  }

  cancelExecution(
    orgId: string,
    userId: string,
    workflowId: string,
    executionId: string,
  ) {
    return this.execution.cancelExecution(
      orgId,
      userId,
      workflowId,
      executionId,
    );
  }

  listAllExecutions(orgId: string, query: WorkflowExecutionQueryDto) {
    return this.execution.listAllExecutions(orgId, query);
  }

  getApprovals(orgId: string, userId: string) {
    return this.execution.getApprovals(orgId, userId);
  }

  handleApproval(
    orgId: string,
    userId: string,
    approvalId: string,
    dto: ApprovalActionDto,
  ) {
    return this.execution.handleApproval(orgId, userId, approvalId, dto);
  }

  listTemplates() {
    return Promise.resolve([]);
  }

  async getAnalytics(orgId: string) {
    const [[workflowStats], [executionStats], [pendingApprovalCount]] =
      await Promise.all([
        this.db
          .select({
            total: count(),
            active: sql<number>`sum(case when ${workflows.status} = 'published' then 1 else 0 end)::int`,
          })
          .from(workflows)
          .where(eq(workflows.orgId, orgId)),
        this.db
          .select({
            total: count(),
            completed: sql<number>`sum(case when ${workflowExecutions.status} = 'completed' then 1 else 0 end)::int`,
            avgDuration: sql<number>`avg(${workflowExecutions.durationMs})::int`,
          })
          .from(workflowExecutions)
          .where(eq(workflowExecutions.orgId, orgId)),
        this.db
          .select({ total: count() })
          .from(workflowApprovals)
          .innerJoin(
            workflowExecutions,
            eq(workflowApprovals.executionId, workflowExecutions.id),
          )
          .where(
            and(
              eq(workflowExecutions.orgId, orgId),
              eq(workflowApprovals.status, "pending"),
            ),
          ),
      ]);

    const totalExecutions = executionStats?.total ?? 0;
    const completedExecutions = executionStats?.completed ?? 0;
    const successRate =
      totalExecutions > 0
        ? Math.round((completedExecutions / totalExecutions) * 100)
        : 0;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const trendRows = await this.db
      .select({
        date: sql<string>`date_trunc('day', ${workflowExecutions.createdAt})::text`,
        count: sql<number>`count(*)::int`,
        successCount: sql<number>`sum(case when ${workflowExecutions.status} = 'completed' then 1 else 0 end)::int`,
      })
      .from(workflowExecutions)
      .where(
        and(
          eq(workflowExecutions.orgId, orgId),
          gte(workflowExecutions.createdAt, thirtyDaysAgo),
        ),
      )
      .groupBy(sql`date_trunc('day', ${workflowExecutions.createdAt})`)
      .orderBy(sql`date_trunc('day', ${workflowExecutions.createdAt})`);

    return {
      totalWorkflows: workflowStats?.total ?? 0,
      activeWorkflows: workflowStats?.active ?? 0,
      totalExecutions,
      successRate,
      avgDuration: executionStats?.avgDuration ?? 0,
      pendingApprovals: pendingApprovalCount?.total ?? 0,
      executionTrend: trendRows,
    };
  }

  listAllSchedules(orgId: string) {
    return this.db
      .select()
      .from(workflowSchedules)
      .where(eq(workflowSchedules.orgId, orgId))
      .orderBy(desc(workflowSchedules.createdAt));
  }

  async listSchedules(orgId: string, workflowId: string) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    return this.db
      .select()
      .from(workflowSchedules)
      .where(
        and(
          eq(workflowSchedules.workflowId, workflowId),
          eq(workflowSchedules.orgId, orgId),
        ),
      );
  }

  async createSchedule(
    orgId: string,
    workflowId: string,
    dto: CreateScheduleDto,
  ) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    const [schedule] = await this.db
      .insert(workflowSchedules)
      .values({ workflowId, orgId, ...dto })
      .returning();

    return schedule;
  }

  async updateSchedule(
    orgId: string,
    workflowId: string,
    scheduleId: string,
    dto: UpdateScheduleDto,
  ) {
    const existing = await this.db.query.workflowSchedules.findFirst({
      where: and(
        eq(workflowSchedules.id, scheduleId),
        eq(workflowSchedules.workflowId, workflowId),
        eq(workflowSchedules.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Schedule not found");

    const [updated] = await this.db
      .update(workflowSchedules)
      .set({ ...dto, updatedAt: new Date() })
      .where(eq(workflowSchedules.id, scheduleId))
      .returning();

    return updated;
  }

  async deleteSchedule(
    orgId: string,
    workflowId: string,
    scheduleId: string,
  ) {
    const existing = await this.db.query.workflowSchedules.findFirst({
      where: and(
        eq(workflowSchedules.id, scheduleId),
        eq(workflowSchedules.workflowId, workflowId),
        eq(workflowSchedules.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Schedule not found");

    await this.db
      .delete(workflowSchedules)
      .where(eq(workflowSchedules.id, scheduleId));
  }

  async listSecrets(orgId: string, workflowId: string) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    return this.db
      .select({
        id: workflowSecrets.id,
        orgId: workflowSecrets.orgId,
        name: workflowSecrets.name,
        description: workflowSecrets.description,
        createdAt: workflowSecrets.createdAt,
        updatedAt: workflowSecrets.updatedAt,
      })
      .from(workflowSecrets)
      .where(eq(workflowSecrets.orgId, orgId));
  }

  async createSecret(orgId: string, workflowId: string, dto: CreateSecretDto) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    const [secret] = await this.db
      .insert(workflowSecrets)
      .values({
        orgId,
        name: dto.name,
        encryptedValue: dto.value,
        description: dto.description,
      })
      .returning({
        id: workflowSecrets.id,
        orgId: workflowSecrets.orgId,
        name: workflowSecrets.name,
        description: workflowSecrets.description,
        createdAt: workflowSecrets.createdAt,
        updatedAt: workflowSecrets.updatedAt,
      });

    return secret;
  }

  async deleteSecret(orgId: string, workflowId: string, secretId: string) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    const existing = await this.db.query.workflowSecrets.findFirst({
      where: and(
        eq(workflowSecrets.id, secretId),
        eq(workflowSecrets.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Secret not found");

    await this.db
      .delete(workflowSecrets)
      .where(eq(workflowSecrets.id, secretId));
  }

  listGlobalSecrets(orgId: string) {
    return this.db
      .select({
        id: workflowSecrets.id,
        name: workflowSecrets.name,
        description: workflowSecrets.description,
        createdAt: workflowSecrets.createdAt,
        updatedAt: workflowSecrets.updatedAt,
      })
      .from(workflowSecrets)
      .where(eq(workflowSecrets.orgId, orgId))
      .orderBy(desc(workflowSecrets.createdAt));
  }

  async createGlobalSecret(orgId: string, dto: CreateSecretDto) {
    const [secret] = await this.db
      .insert(workflowSecrets)
      .values({
        orgId,
        name: dto.name,
        encryptedValue: dto.value,
        description: dto.description,
      })
      .returning({
        id: workflowSecrets.id,
        name: workflowSecrets.name,
        description: workflowSecrets.description,
        createdAt: workflowSecrets.createdAt,
        updatedAt: workflowSecrets.updatedAt,
      });
    return secret;
  }

  async deleteGlobalSecret(orgId: string, secretId: string) {
    const existing = await this.db.query.workflowSecrets.findFirst({
      where: and(
        eq(workflowSecrets.id, secretId),
        eq(workflowSecrets.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Secret not found");
    await this.db
      .delete(workflowSecrets)
      .where(eq(workflowSecrets.id, secretId));
  }

  listGlobalVariables(orgId: string) {
    return this.db
      .select({
        id: workflowVariables.id,
        key: workflowVariables.key,
        valueType: workflowVariables.valueType,
        defaultValue: workflowVariables.defaultValue,
        workflowVersionId: workflowVariables.workflowVersionId,
        createdAt: workflowVariables.createdAt,
        workflowId: workflows.id,
        workflowName: workflows.name,
      })
      .from(workflowVariables)
      .innerJoin(
        workflowVersions,
        eq(workflowVariables.workflowVersionId, workflowVersions.id),
      )
      .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
      .where(eq(workflows.orgId, orgId))
      .orderBy(desc(workflowVariables.createdAt));
  }

  async deleteGlobalVariable(orgId: string, variableId: string) {
    const existing = await this.db
      .select({ id: workflowVariables.id })
      .from(workflowVariables)
      .innerJoin(
        workflowVersions,
        eq(workflowVariables.workflowVersionId, workflowVersions.id),
      )
      .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
      .where(
        and(
          eq(workflowVariables.id, variableId),
          eq(workflows.orgId, orgId),
        ),
      )
      .limit(1);
    if (!existing.length) throw new NotFoundException("Variable not found");
    await this.db
      .delete(workflowVariables)
      .where(eq(workflowVariables.id, variableId));
  }
}
