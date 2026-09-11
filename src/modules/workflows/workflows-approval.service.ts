import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  workflows,
  workflowExecutions,
  workflowExecutionSteps,
  workflowApprovals,
  workflowAuditLogs,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { ApprovalActionDto } from "./dto/workflow.schemas";

@Injectable()
export class WorkflowsApprovalService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

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
      .orderBy(desc(workflowApprovals.createdAt))
      .limit(100);

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

    if (!approval)
      throw new NotFoundException("Approval not found or already actioned");

    const now = new Date();
    const [updated] = await this.db
      .update(workflowApprovals)
      .set({
        status: dto.action === "approve" ? "approved" : "rejected",
        comment: dto.comment,
        approvedAt: dto.action === "approve" ? now : null,
        rejectedAt: dto.action === "reject" ? now : null,
      })
      .where(
        and(
          eq(workflowApprovals.id, approvalId),
          eq(workflowApprovals.approverId, userId),
          eq(workflowApprovals.status, "pending"),
        ),
      )
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
