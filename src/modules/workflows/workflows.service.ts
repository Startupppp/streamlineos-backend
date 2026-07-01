import { Inject, Injectable, NotFoundException, ForbiddenException } from "@nestjs/common";
import { and, eq, ilike, desc, sql, count, gte } from "drizzle-orm";
import {
  workflows,
  workflowVersions,
  workflowExecutions,
  workflowExecutionSteps,
  workflowApprovals,
  workflowSchedules,
  workflowSecrets,
  workflowVariables,
  workflowAuditLogs,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
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
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listWorkflows(orgId: string, query: WorkflowListQueryDto) {
    const { page, limit, status, search } = query;
    const offset = (page - 1) * limit;

    const conditions = [eq(workflows.orgId, orgId)];
    if (status) conditions.push(eq(workflows.status, status));
    if (search) conditions.push(ilike(workflows.name, `%${search}%`));

    const where = and(...conditions);

    const [data, [countRow]] = await Promise.all([
      this.db.select().from(workflows).where(where).orderBy(desc(workflows.updatedAt)).limit(limit).offset(offset),
      this.db.select({ total: count() }).from(workflows).where(where),
    ]);

    return { data, total: countRow?.total ?? 0, page, limit };
  }

  async getWorkflow(orgId: string, workflowId: string) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      with: { versions: { orderBy: [desc(workflowVersions.version)], limit: 1 } },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");
    return workflow;
  }

  async createWorkflow(orgId: string, userId: string, dto: CreateWorkflowDto) {
    const [workflow] = await this.db
      .insert(workflows)
      .values({ orgId, name: dto.name, description: dto.description, createdBy: userId })
      .returning();

    await this.db.insert(workflowAuditLogs).values({
      orgId,
      workflowId: workflow.id,
      actorId: userId,
      event: "created",
      metadata: { name: dto.name },
    });

    return workflow;
  }

  async updateWorkflow(orgId: string, userId: string, workflowId: string, dto: UpdateWorkflowDto) {
    const existing = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Workflow not found");

    const [updated] = await this.db
      .update(workflows)
      .set({ ...dto, updatedAt: new Date() })
      .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)))
      .returning();

    await this.db.insert(workflowAuditLogs).values({
      orgId,
      workflowId,
      actorId: userId,
      event: "updated",
      metadata: dto as Record<string, unknown>,
    });

    return updated;
  }

  async deleteWorkflow(orgId: string, userId: string, workflowId: string) {
    const existing = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Workflow not found");

    await this.db.delete(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)));

    await this.db.insert(workflowAuditLogs).values({
      orgId,
      workflowId,
      actorId: userId,
      event: "deleted",
    });
  }

  async publishWorkflow(orgId: string, userId: string, workflowId: string, dto: PublishWorkflowDto) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true, version: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    const nextVersion = workflow.version + 1;

    return this.db.transaction(async (tx) => {
      const [version] = await tx
        .insert(workflowVersions)
        .values({
          workflowId,
          version: nextVersion,
          definitionJson: dto.definitionJson,
          publishedBy: userId,
          publishedAt: new Date(),
        })
        .returning();

      const [updated] = await tx
        .update(workflows)
        .set({ version: nextVersion, status: "published", updatedAt: new Date() })
        .where(eq(workflows.id, workflowId))
        .returning();

      await tx.insert(workflowAuditLogs).values({
        orgId,
        workflowId,
        actorId: userId,
        event: "published",
        metadata: { version: nextVersion },
      });

      return { workflow: updated, version };
    });
  }

  async duplicateWorkflow(orgId: string, userId: string, workflowId: string) {
    const original = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
    });
    if (!original) throw new NotFoundException("Workflow not found");

    const [copy] = await this.db
      .insert(workflows)
      .values({
        orgId,
        name: `${original.name} (Copy)`,
        description: original.description,
        status: "draft",
        version: 1,
        createdBy: userId,
      })
      .returning();

    await this.db.insert(workflowAuditLogs).values({
      orgId,
      workflowId: copy.id,
      actorId: userId,
      event: "duplicated",
      metadata: { sourceId: workflowId },
    });

    return copy;
  }

  async triggerWorkflow(orgId: string, userId: string, workflowId: string, dto: TriggerWorkflowDto) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId), eq(workflows.status, "published")),
      with: { versions: { orderBy: [desc(workflowVersions.version)], limit: 1 } },
    });
    if (!workflow) throw new NotFoundException("Published workflow not found");

    const latestVersion = workflow.versions[0];
    if (!latestVersion) throw new NotFoundException("No published version found");

    const [execution] = await this.db
      .insert(workflowExecutions)
      .values({
        workflowId,
        workflowVersionId: latestVersion.id,
        orgId,
        status: "pending",
        triggerType: "manual",
        triggerData: dto.triggerData,
        triggeredBy: userId,
      })
      .returning();

    await this.db.insert(workflowAuditLogs).values({
      orgId,
      workflowId,
      executionId: execution.id,
      actorId: userId,
      event: "executed",
    });

    return execution;
  }

  async listExecutions(orgId: string, workflowId: string, query: WorkflowExecutionQueryDto) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    const { page, limit, status } = query;
    const offset = (page - 1) * limit;

    const conditions = [eq(workflowExecutions.workflowId, workflowId), eq(workflowExecutions.orgId, orgId)];
    if (status) conditions.push(eq(workflowExecutions.status, status));

    const where = and(...conditions);

    const [data, [countRow]] = await Promise.all([
      this.db.select().from(workflowExecutions).where(where).orderBy(desc(workflowExecutions.createdAt)).limit(limit).offset(offset),
      this.db.select({ total: count() }).from(workflowExecutions).where(where),
    ]);

    return { data, total: countRow?.total ?? 0, page, limit };
  }

  async getExecution(orgId: string, workflowId: string, executionId: string) {
    const execution = await this.db.query.workflowExecutions.findFirst({
      where: and(
        eq(workflowExecutions.id, executionId),
        eq(workflowExecutions.workflowId, workflowId),
        eq(workflowExecutions.orgId, orgId),
      ),
      with: { steps: true },
    });
    if (!execution) throw new NotFoundException("Execution not found");
    return execution;
  }

  async cancelExecution(orgId: string, userId: string, workflowId: string, executionId: string) {
    const execution = await this.db.query.workflowExecutions.findFirst({
      where: and(
        eq(workflowExecutions.id, executionId),
        eq(workflowExecutions.workflowId, workflowId),
        eq(workflowExecutions.orgId, orgId),
      ),
      columns: { id: true, status: true },
    });
    if (!execution) throw new NotFoundException("Execution not found");
    if (!["pending", "running", "waiting"].includes(execution.status)) {
      throw new ForbiddenException("Execution cannot be cancelled in its current state");
    }

    const [updated] = await this.db
      .update(workflowExecutions)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(workflowExecutions.id, executionId))
      .returning();

    await this.db.insert(workflowAuditLogs).values({
      orgId,
      workflowId,
      executionId,
      actorId: userId,
      event: "cancelled",
    });

    return updated;
  }

  async getApprovals(orgId: string, userId: string) {
    const data = await this.db
      .select({
        id: workflowApprovals.id,
        executionId: workflowApprovals.executionId,
        stepId: workflowApprovals.stepId,
        approverId: workflowApprovals.approverId,
        status: workflowApprovals.status,
        comment: workflowApprovals.comment,
        approvedAt: workflowApprovals.approvedAt,
        rejectedAt: workflowApprovals.rejectedAt,
        expiresAt: workflowApprovals.expiresAt,
        createdAt: workflowApprovals.createdAt,
        workflowId: workflows.id,
        workflowName: workflows.name,
      })
      .from(workflowApprovals)
      .innerJoin(workflowExecutionSteps, eq(workflowApprovals.stepId, workflowExecutionSteps.id))
      .innerJoin(workflowExecutions, eq(workflowApprovals.executionId, workflowExecutions.id))
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .where(and(
        eq(workflowApprovals.approverId, userId),
        eq(workflowApprovals.status, "pending"),
        eq(workflowExecutions.orgId, orgId),
      ))
      .orderBy(desc(workflowApprovals.createdAt));

    return data.map((row) => ({
      id: row.id,
      executionId: row.executionId,
      stepId: row.stepId,
      approverId: row.approverId,
      status: row.status,
      comment: row.comment,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      rejectedAt: row.rejectedAt ? row.rejectedAt.toISOString() : null,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      workflow: { id: row.workflowId, name: row.workflowName },
    }));
  }

  async handleApproval(orgId: string, userId: string, approvalId: string, dto: ApprovalActionDto) {
    const approval = await this.db.query.workflowApprovals.findFirst({
      where: and(eq(workflowApprovals.id, approvalId), eq(workflowApprovals.approverId, userId), eq(workflowApprovals.status, "pending")),
      with: { execution: { columns: { orgId: true, workflowId: true } } },
    });
    if (!approval) throw new NotFoundException("Approval not found or already actioned");
    if (approval.execution.orgId !== orgId) throw new ForbiddenException("Access denied");

    const now = new Date();
    const [updated] = await this.db
      .update(workflowApprovals)
      .set({
        status: dto.action === "approve" ? "approved" : "rejected",
        comment: dto.comment,
        approvedAt: dto.action === "approve" ? now : null,
        rejectedAt: dto.action === "reject" ? now : null,
      })
      .where(eq(workflowApprovals.id, approvalId))
      .returning();

    await this.db.insert(workflowAuditLogs).values({
      orgId,
      workflowId: approval.execution.workflowId,
      executionId: approval.executionId,
      actorId: userId,
      event: dto.action === "approve" ? "approved" : "rejected",
      metadata: { approvalId, comment: dto.comment },
    });

    return updated;
  }

  async listTemplates() {
    return [];
  }

  async getAnalytics(orgId: string) {
    const [
      [workflowStats],
      [executionStats],
      [pendingApprovalCount],
    ] = await Promise.all([
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
        .innerJoin(workflowExecutions, eq(workflowApprovals.executionId, workflowExecutions.id))
        .where(and(eq(workflowExecutions.orgId, orgId), eq(workflowApprovals.status, "pending"))),
    ]);

    const totalExecutions = executionStats?.total ?? 0;
    const completedExecutions = executionStats?.completed ?? 0;
    const successRate = totalExecutions > 0 ? Math.round((completedExecutions / totalExecutions) * 100) : 0;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const trendRows = await this.db
      .select({
        date: sql<string>`date_trunc('day', ${workflowExecutions.createdAt})::text`,
        count: sql<number>`count(*)::int`,
        successCount: sql<number>`sum(case when ${workflowExecutions.status} = 'completed' then 1 else 0 end)::int`,
      })
      .from(workflowExecutions)
      .where(and(eq(workflowExecutions.orgId, orgId), gte(workflowExecutions.createdAt, thirtyDaysAgo)))
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

  async listAllExecutions(orgId: string, query: WorkflowExecutionQueryDto) {
    const { page, limit, status } = query;
    const offset = (page - 1) * limit;

    const conditions = [eq(workflowExecutions.orgId, orgId)];
    if (status) conditions.push(eq(workflowExecutions.status, status));

    const where = and(...conditions);

    const [data, [countRow]] = await Promise.all([
      this.db.select().from(workflowExecutions).where(where).orderBy(desc(workflowExecutions.createdAt)).limit(limit).offset(offset),
      this.db.select({ total: count() }).from(workflowExecutions).where(where),
    ]);

    return { data, total: countRow?.total ?? 0, page, limit };
  }

  async listAllSchedules(orgId: string) {
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

    return this.db.select().from(workflowSchedules).where(and(eq(workflowSchedules.workflowId, workflowId), eq(workflowSchedules.orgId, orgId)));
  }

  async createSchedule(orgId: string, workflowId: string, dto: CreateScheduleDto) {
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

  async updateSchedule(orgId: string, workflowId: string, scheduleId: string, dto: UpdateScheduleDto) {
    const existing = await this.db.query.workflowSchedules.findFirst({
      where: and(eq(workflowSchedules.id, scheduleId), eq(workflowSchedules.workflowId, workflowId), eq(workflowSchedules.orgId, orgId)),
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

  async deleteSchedule(orgId: string, workflowId: string, scheduleId: string) {
    const existing = await this.db.query.workflowSchedules.findFirst({
      where: and(eq(workflowSchedules.id, scheduleId), eq(workflowSchedules.workflowId, workflowId), eq(workflowSchedules.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Schedule not found");

    await this.db.delete(workflowSchedules).where(eq(workflowSchedules.id, scheduleId));
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
      .values({ orgId, name: dto.name, encryptedValue: dto.value, description: dto.description })
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
      where: and(eq(workflowSecrets.id, secretId), eq(workflowSecrets.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Secret not found");

    await this.db.delete(workflowSecrets).where(eq(workflowSecrets.id, secretId));
  }

  async disableWorkflow(orgId: string, userId: string, workflowId: string) {
    const [updated] = await this.db
      .update(workflows)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Workflow not found");
    await this.db.insert(workflowAuditLogs).values({ orgId, workflowId, actorId: userId, event: "disabled" });
    return updated;
  }

  async archiveWorkflow(orgId: string, userId: string, workflowId: string) {
    const [updated] = await this.db
      .update(workflows)
      .set({ status: "archived", updatedAt: new Date() })
      .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Workflow not found");
    await this.db.insert(workflowAuditLogs).values({ orgId, workflowId, actorId: userId, event: "archived" });
    return updated;
  }

  async listGlobalSecrets(orgId: string) {
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
      .values({ orgId, name: dto.name, encryptedValue: dto.value, description: dto.description })
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
      where: and(eq(workflowSecrets.id, secretId), eq(workflowSecrets.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Secret not found");
    await this.db.delete(workflowSecrets).where(eq(workflowSecrets.id, secretId));
  }

  async listGlobalVariables(orgId: string) {
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
      .innerJoin(workflowVersions, eq(workflowVariables.workflowVersionId, workflowVersions.id))
      .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
      .where(eq(workflows.orgId, orgId))
      .orderBy(desc(workflowVariables.createdAt));
  }

  async deleteGlobalVariable(orgId: string, variableId: string) {
    const existing = await this.db
      .select({ id: workflowVariables.id })
      .from(workflowVariables)
      .innerJoin(workflowVersions, eq(workflowVariables.workflowVersionId, workflowVersions.id))
      .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
      .where(and(eq(workflowVariables.id, variableId), eq(workflows.orgId, orgId)))
      .limit(1);
    if (!existing.length) throw new NotFoundException("Variable not found");
    await this.db.delete(workflowVariables).where(eq(workflowVariables.id, variableId));
  }
}
