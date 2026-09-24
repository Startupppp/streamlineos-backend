import { Injectable, OnModuleInit } from "@nestjs/common";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";
import { HrWorkflowInstancesService } from "./hr-workflow-instances.service";
import type {
  BuildApprovalInboxItem,
  InboxSourcePosition,
} from "../../notifications/dto/unified-inbox.schemas";

/**
 * The workflow inbox resolves step approvers in-memory after an over-fetch
 * (see WORKFLOW_INBOX_OVERFETCH / WORKFLOW_INBOX_MAX_BATCHES), so an exact
 * single-query SQL count is not available. countPending therefore re-uses
 * pendingRoutedToPage with this cap and returns the array length.
 */
export const WORKFLOW_PENDING_COUNT_CAP = 50;

@Injectable()
export class HrWorkflowApprovalAdapter implements OnModuleInit {
  constructor(
    private readonly workflows: HrWorkflowInstancesService,
    private readonly registry: ApprovalAdapterRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      module: "hr",
      kindLabel: "workflow",
      permission: "hr:workflows:approve",
      supportsAfterCursor: true,
      fetch: (orgId, _userId, membershipId, limit, cursor) =>
        this.fetchWorkflows(orgId, membershipId, limit, cursor),
      countPending: async (orgId, _userId, membershipId) => {
        if (membershipId === null) return 0;
        const rows = await this.workflows.pendingRoutedToPage(
          orgId,
          membershipId,
          WORKFLOW_PENDING_COUNT_CAP,
          null,
        );
        return rows.length;
      },
    });
  }

  private async fetchWorkflows(
    orgId: string,
    membershipId: number | null,
    limit: number,
    cursor: InboxSourcePosition | null,
  ): Promise<BuildApprovalInboxItem[]> {
    if (membershipId === null) return [];
    const rows = await this.workflows.pendingRoutedToPage(
      orgId,
      membershipId,
      limit,
      cursor,
    );
    return rows.map(
      (row): BuildApprovalInboxItem => ({
        kind: "build_approval",
        id: row.id,
        approvalKind: "workflow",
        status: row.status,
        projectId: null,
        ticketId: null,
        dueAt: row.dueAt ? row.dueAt.toISOString() : null,
        dedupKey: `approval:workflow:${String(row.id)}`,
        sourceModule: "hr",
        subject: `${row.objectType} approval`,
        timestamp: row.createdAt.toISOString(),
        isRead: false,
        deepLink: "/hr/approvals",
        actor: null,
      }),
    );
  }
}
