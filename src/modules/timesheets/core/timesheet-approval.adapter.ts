import { Injectable, OnModuleInit } from "@nestjs/common";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";
import { ApprovalsService } from "./approvals.service";
import type { BuildApprovalInboxItem } from "../../notifications/dto/unified-inbox.schemas";

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
      supportsAfterCursor: false,
      fetch: (orgId, _userId, membershipId, limit) =>
        this.fetchTimesheets(orgId, membershipId, limit),
    });
  }

  private async fetchTimesheets(
    orgId: string,
    membershipId: number | null,
    limit: number,
  ): Promise<BuildApprovalInboxItem[]> {
    if (membershipId === null) return [];
    const rows = await this.approvals.pendingRoutedTo(
      orgId,
      membershipId,
      limit,
    );
    return rows.map(
      (row): BuildApprovalInboxItem => ({
        kind: "build_approval",
        id: row.id,
        approvalKind: "timesheet",
        status: "pending",
        projectId: null,
        ticketId: null,
        dueAt: row.approvalDueAt ? row.approvalDueAt.toISOString() : null,
        dedupKey: `approval:timesheet:${String(row.id)}`,
        sourceModule: "timesheets",
        subject: `Timesheet · ${row.periodStart} to ${row.periodEnd}`,
        timestamp: (
          row.submittedAt ??
          row.approvalDueAt ??
          new Date(0)
        ).toISOString(),
        isRead: false,
        deepLink: null,
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
