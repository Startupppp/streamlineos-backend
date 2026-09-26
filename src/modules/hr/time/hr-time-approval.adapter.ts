import { Injectable, OnModuleInit } from "@nestjs/common";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";
import { LeavesService } from "./leaves.service";
import { WfhService } from "./wfh.service";
import type {
  BuildApprovalInboxItem,
  InboxSourcePosition,
} from "../../notifications/dto/unified-inbox.schemas";

export const LEAVE_REQUEST_OBJECT_TYPE = "leave_request";
export const WFH_REQUEST_OBJECT_TYPE = "wfh_request";

function displayName(
  name: string | null | undefined,
  first: string | null | undefined,
  last: string | null | undefined,
): string | null {
  if (name) return name;
  const parts = [first, last].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(" ") : null;
}

@Injectable()
export class HrTimeApprovalAdapter implements OnModuleInit {
  constructor(
    private readonly leaves: LeavesService,
    private readonly wfh: WfhService,
    private readonly registry: ApprovalAdapterRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      module: "hr",
      kindLabel: "leave",
      permission: "hr:leaves:approve",
      supportsAfterCursor: true,
      fetch: (orgId, _userId, membershipId, limit, cursor) =>
        this.fetchLeaves(orgId, membershipId, limit, cursor),
    });

    this.registry.register({
      module: "hr",
      kindLabel: "wfh",
      permission: "hr:attendance:manage",
      supportsAfterCursor: true,
      fetch: (orgId, _userId, membershipId, limit, cursor) =>
        this.fetchWfh(orgId, membershipId, limit, cursor),
    });
  }

  private async fetchLeaves(
    orgId: string,
    membershipId: number | null,
    limit: number,
    cursor: InboxSourcePosition | null,
  ): Promise<BuildApprovalInboxItem[]> {
    if (membershipId === null) return [];
    const rows = await this.leaves.pendingRoutedToPage(
      orgId,
      membershipId,
      limit,
      cursor,
    );
    return rows.map(
      (row): BuildApprovalInboxItem => ({
        kind: "build_approval",
        id: row.id,
        approvalKind: "leave",
        status: "pending",
        projectId: null,
        ticketId: null,
        dueAt: null,
        objectType: LEAVE_REQUEST_OBJECT_TYPE,
        objectId: String(row.id),
        dedupKey: `approval:leave:${String(row.id)}`,
        sourceModule: "hr",
        subject: `${row.leaveTypeName ?? "Leave"} · ${row.startDate} to ${row.endDate}`,
        timestamp: row.createdAt.toISOString(),
        isRead: false,
        deepLink: "/hr/leaves?tab=pending",
        actor: row.userId
          ? {
              id: row.userId,
              name: displayName(
                row.userName,
                row.userFirstName,
                row.userLastName,
              ),
              image: row.userImage ?? null,
            }
          : null,
      }),
    );
  }

  private async fetchWfh(
    orgId: string,
    membershipId: number | null,
    limit: number,
    cursor: InboxSourcePosition | null,
  ): Promise<BuildApprovalInboxItem[]> {
    if (membershipId === null) return [];
    const rows = await this.wfh.pendingRoutedToPage(
      orgId,
      membershipId,
      limit,
      cursor,
    );
    return rows.map(
      (row): BuildApprovalInboxItem => ({
        kind: "build_approval",
        id: row.id,
        approvalKind: "wfh",
        status: "pending",
        projectId: null,
        ticketId: null,
        dueAt: null,
        objectType: WFH_REQUEST_OBJECT_TYPE,
        objectId: String(row.id),
        dedupKey: `approval:wfh:${String(row.id)}`,
        sourceModule: "hr",
        subject: `Work from home · ${row.date}`,
        timestamp: row.createdAt.toISOString(),
        isRead: false,
        deepLink: "/hr/attendance",
        actor: {
          id: row.userId,
          name: displayName(row.userName, row.userFirstName, row.userLastName),
          image: null,
        },
      }),
    );
  }
}
