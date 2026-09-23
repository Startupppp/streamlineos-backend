import { Injectable, OnModuleInit } from "@nestjs/common";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";
import { approvalPriority } from "../../attention/approval-priority";
import { ApprovalsService } from "./approvals.service";
import type {
  BuildApprovalInboxItem,
  InboxSourcePosition,
} from "../../notifications/dto/unified-inbox.schemas";

@Injectable()
export class TimesheetApprovalAdapter implements OnModuleInit {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly registry: ApprovalAdapterRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      module: "timesheets",
      kindLabel: "timesheet",
      permission: "timesheets:approvals:view",
      supportsAfterCursor: true,
      fetch: (orgId, _userId, membershipId, limit, cursor) =>
        this.fetchTimesheets(orgId, membershipId, limit, cursor),
      countPending: (orgId, _userId, membershipId) => {
        if (membershipId === null) return Promise.resolve(0);
        return this.approvals.countPendingRoutedTo(orgId, membershipId);
      },
    });
  }

  private async fetchTimesheets(
    orgId: string,
    membershipId: number | null,
    limit: number,
    cursor: InboxSourcePosition | null,
  ): Promise<BuildApprovalInboxItem[]> {
    if (membershipId === null) return [];
    const rows = await this.approvals.pendingRoutedToPage(
      orgId,
      membershipId,
      limit,
      cursor,
    );
    return rows.map(
      (row): BuildApprovalInboxItem => ({
        kind: "build_approval",
        id: row.id,
        approvalKind: "timesheet",
        status: "pending",
        priority: approvalPriority(row.approvalDueAt, "pending"),
        projectId: null,
        ticketId: null,
        dueAt: row.approvalDueAt ? row.approvalDueAt.toISOString() : null,
        dedupKey: `approval:timesheet:${String(row.id)}`,
        sourceModule: "timesheets",
        subject: `Timesheet · ${row.periodStart} to ${row.periodEnd}`,
        timestamp: row.submittedAt.toISOString(),
        isRead: false,
        deepLink: "/timesheets/approvals",
        actor: row.userEmail
          ? {
              id: row.userEmail,
              name: row.userName ?? null,
              image: null,
            }
          : null,
      }),
    );
  }
}
