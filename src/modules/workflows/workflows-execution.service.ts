import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  workflows,
  workflowVersions,
  workflowExecutions,
  workflowAuditLogs,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetAfter, keysetBefore } from "../../common/pagination/keyset";
import type {
  WorkflowExecutionQueryDto,
  TriggerWorkflowDto,
  ApprovalActionDto,
} from "./dto/workflow.schemas";
import { WorkflowsApprovalService } from "./workflows-approval.service";

@Injectable()
export class WorkflowsExecutionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly approval: WorkflowsApprovalService,
  ) {}

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
      with: {
        versions: { orderBy: [desc(workflowVersions.version)], limit: 1 },
      },
    });
    if (!workflow) throw new NotFoundException("Published workflow not found");

    const latestVersion = workflow.versions[0];
    if (!latestVersion)
      throw new NotFoundException("No published version found");

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
      const cursorCond =
        direction === "desc"
          ? keysetBefore(
              workflowExecutions.createdAt,
              workflowExecutions.id,
              decoded,
            )
          : keysetAfter(
              workflowExecutions.createdAt,
              workflowExecutions.id,
              decoded,
            );
      conditions.push(cursorCond as ReturnType<typeof eq>);
    }

    const orderFn = direction === "asc" ? asc : desc;

    const rows = await this.db
      .select({
        id: workflowExecutions.id,
        workflowId: workflowExecutions.workflowId,
        workflowVersionId: workflowExecutions.workflowVersionId,
        orgId: workflowExecutions.orgId,
        status: workflowExecutions.status,
        triggerType: workflowExecutions.triggerType,
        triggerData: workflowExecutions.triggerData,
        startedAt: workflowExecutions.startedAt,
        completedAt: workflowExecutions.completedAt,
        durationMs: workflowExecutions.durationMs,
        triggeredBy: workflowExecutions.triggeredBy,
        createdAt: workflowExecutions.createdAt,
      })
      .from(workflowExecutions)
      .where(and(...conditions))
      .orderBy(
        orderFn(workflowExecutions.createdAt),
        orderFn(workflowExecutions.id),
      )
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: row.id,
    }));
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
      .where(
        and(
          eq(workflowExecutions.id, executionId),
          eq(workflowExecutions.orgId, orgId),
          inArray(workflowExecutions.status, ["pending", "running", "waiting"]),
        ),
      )
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

    const conditions: ReturnType<typeof eq>[] = [
      eq(workflowExecutions.orgId, orgId),
    ];
    if (status) conditions.push(eq(workflowExecutions.status, status));

    const decoded = decodeCursor(cursor);
    if (decoded) {
      const cursorCond =
        direction === "desc"
          ? keysetBefore(
              workflowExecutions.createdAt,
              workflowExecutions.id,
              decoded,
            )
          : keysetAfter(
              workflowExecutions.createdAt,
              workflowExecutions.id,
              decoded,
            );
      conditions.push(cursorCond as ReturnType<typeof eq>);
    }

    const orderFn = direction === "asc" ? asc : desc;

    const rows = await this.db
      .select({
        id: workflowExecutions.id,
        workflowId: workflowExecutions.workflowId,
        workflowVersionId: workflowExecutions.workflowVersionId,
        orgId: workflowExecutions.orgId,
        status: workflowExecutions.status,
        triggerType: workflowExecutions.triggerType,
        triggerData: workflowExecutions.triggerData,
        startedAt: workflowExecutions.startedAt,
        completedAt: workflowExecutions.completedAt,
        durationMs: workflowExecutions.durationMs,
        triggeredBy: workflowExecutions.triggeredBy,
        createdAt: workflowExecutions.createdAt,
      })
      .from(workflowExecutions)
      .where(and(...conditions))
      .orderBy(
        orderFn(workflowExecutions.createdAt),
        orderFn(workflowExecutions.id),
      )
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: row.id,
    }));
  }

  getApprovals(orgId: string, userId: string) {
    return this.approval.getApprovals(orgId, userId);
  }

  handleApproval(orgId: string, userId: string, approvalId: string, dto: ApprovalActionDto) {
    return this.approval.handleApproval(orgId, userId, approvalId, dto);
  }
}
