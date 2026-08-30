import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  workflows,
  workflowVersions,
  workflowExecutions,
  workflowExecutionSteps,
  workflowApprovals,
  workflowAuditLogs,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import type {
  WorkflowExecutionQueryDto,
  TriggerWorkflowDto,
  ApprovalActionDto,
} from "./dto/workflow.schemas";

@Injectable()
export class WorkflowsExecutionService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async triggerWorkflow(
    orgId: string,
    userId: string,
    workflowId: string,
    dto: TriggerWorkflowDto,
  ) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(
        eq(workflows.id, workflowId),
        eq(workflows.orgId, orgId),
        eq(workflows.status, "published"),
      ),
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

  async listExecutions(
    orgId: string,
    workflowId: string,
    query: WorkflowExecutionQueryDto,
  ) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    const { cursor, limit, direction, status } = query;

    const conditions: ReturnType<typeof eq>[] = [
      eq(workflowExecutions.workflowId, workflowId),
      eq(workflowExecutions.orgId, orgId),
    ];
    if (status) conditions.push(eq(workflowExecutions.status, status));

    const decoded = decodeCursor(cursor);
    if (decoded) {
      const cursorDate = new Date(decoded.sortValue);
      const cursorId = decoded.id;
      const cursorCond =
        direction === "desc"
          ? sql`(${workflowExecutions.createdAt}, ${workflowExecutions.id}::text) < (${sql.param(cursorDate, workflowExecutions.createdAt)}, ${cursorId})`
          : sql`(${workflowExecutions.createdAt}, ${workflowExecutions.id}::text) > (${sql.param(cursorDate, workflowExecutions.createdAt)}, ${cursorId})`;
      conditions.push(cursorCond as ReturnType<typeof eq>);
    }

    const orderFn = direction === "asc" ? asc : desc;

    const rows = await this.db
      .select()
      .from(workflowExecutions)
      .where(and(...conditions))
      .orderBy(orderFn(workflowExecutions.createdAt), orderFn(workflowExecutions.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: row.id,
    }));
  }

  async getExecution(
    orgId: string,
    workflowId: string,
    executionId: string,
  ) {
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

  async cancelExecution(
    orgId: string,
    userId: string,
    workflowId: string,
    executionId: string,
  ) {
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
      throw new ForbiddenException(
        "Execution cannot be cancelled in its current state",
      );
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

  async listAllExecutions(orgId: string, query: WorkflowExecutionQueryDto) {
    const { cursor, limit, direction, status } = query;

    const conditions: ReturnType<typeof eq>[] = [eq(workflowExecutions.orgId, orgId)];
    if (status) conditions.push(eq(workflowExecutions.status, status));

    const decoded = decodeCursor(cursor);
    if (decoded) {
      const cursorDate = new Date(decoded.sortValue);
      const cursorId = decoded.id;
      const cursorCond =
        direction === "desc"
          ? sql`(${workflowExecutions.createdAt}, ${workflowExecutions.id}::text) < (${sql.param(cursorDate, workflowExecutions.createdAt)}, ${cursorId})`
          : sql`(${workflowExecutions.createdAt}, ${workflowExecutions.id}::text) > (${sql.param(cursorDate, workflowExecutions.createdAt)}, ${cursorId})`;
      conditions.push(cursorCond as ReturnType<typeof eq>);
    }

    const orderFn = direction === "asc" ? asc : desc;

    const rows = await this.db
      .select()
      .from(workflowExecutions)
      .where(and(...conditions))
      .orderBy(orderFn(workflowExecutions.createdAt), orderFn(workflowExecutions.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: row.id,
    }));
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
      .innerJoin(
        workflowExecutionSteps,
        eq(workflowApprovals.stepId, workflowExecutionSteps.id),
      )
      .innerJoin(
        workflowExecutions,
        eq(workflowApprovals.executionId, workflowExecutions.id),
      )
      .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
      .where(
        and(
          eq(workflowApprovals.approverId, userId),
          eq(workflowApprovals.status, "pending"),
          eq(workflowExecutions.orgId, orgId),
        ),
      )
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

  async handleApproval(
    orgId: string,
    userId: string,
    approvalId: string,
    dto: ApprovalActionDto,
  ) {
    const [approval] = await this.db
      .select({
        id: workflowApprovals.id,
        executionId: workflowApprovals.executionId,
        stepId: workflowApprovals.stepId,
        workflowId: workflowExecutions.workflowId,
      })
      .from(workflowApprovals)
      .innerJoin(
        workflowExecutions,
        and(
          eq(workflowExecutions.id, workflowApprovals.executionId),
          eq(workflowExecutions.orgId, orgId),
        ),
      )
      .where(
        and(
          eq(workflowApprovals.id, approvalId),
          eq(workflowApprovals.approverId, userId),
          eq(workflowApprovals.status, "pending"),
        ),
      )
      .limit(1);
    if (!approval) throw new NotFoundException("Approval not found or already actioned");

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
      workflowId: approval.workflowId,
      executionId: approval.executionId,
      actorId: userId,
      event: dto.action === "approve" ? "approved" : "rejected",
      metadata: { approvalId, comment: dto.comment },
    });

    return updated;
  }
}
