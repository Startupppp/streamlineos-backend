import { NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  workflows,
  workflowExecutions,
  workflowExecutionSteps,
  workflowApprovals,
  workflowAuditLogs,
} from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import type { ApprovalActionDto } from "../dto/workflow.schemas";

/**
 * The approver's side of workflow execution: the inbox of steps waiting on this
 * person, and the act of approving or rejecting one.
 *
 * Everything else in `workflows-execution.service.ts` is keyed on a WORKFLOW —
 * trigger it, list its runs, fetch or cancel one run. These two are keyed on a
 * PERSON: the rows they touch are the ones where `workflow_approvals.approver_id`
 * is the caller, across every workflow in the org. Different key, different
 * table, different caller (the approver rather than whoever manages the
 * workflow), and nothing on the execution side reads an approval. That is the
 * seam.
 *
 * Both functions carry three predicates and each one is load-bearing:
 * `approver_id = caller` is what makes an approval actionable only by the person
 * it is addressed to, `status = 'pending'` is what makes a decision final, and
 * `workflow_executions.org_id = org` (reached through the join, because approvals
 * have no `org_id` of their own) is the tenant boundary. A cross-tenant or
 * wrong-approver probe is a 404, never a 403 — `workflow-approval-oracle.spec.ts`
 * holds that — because a 403 would confirm the approval exists.
 *
 * Bodies moved verbatim, call order included; the oracle spec drives a
 * select → innerJoin → where → limit chain positionally.
 */

export interface WorkflowApprovalDeps {
  readonly db: Db;
}

export async function getApprovals(
  deps: WorkflowApprovalDeps,
  orgId: string,
  userId: string,
) {
  const data = await deps.db
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

export async function handleApproval(
  deps: WorkflowApprovalDeps,
  orgId: string,
  userId: string,
  approvalId: string,
  dto: ApprovalActionDto,
) {
  const [approval] = await deps.db
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
  const [updated] = await deps.db
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

  await deps.db.insert(workflowAuditLogs).values({
    orgId,
    workflowId: approval.workflowId,
    executionId: approval.executionId,
    actorId: userId,
    event: dto.action === "approve" ? "approved" : "rejected",
    metadata: { approvalId, comment: dto.comment },
  });

  return updated;
}
