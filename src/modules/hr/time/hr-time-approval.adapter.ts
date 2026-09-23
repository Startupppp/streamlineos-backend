import { Injectable, OnModuleInit } from "@nestjs/common";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";
import { LeavesService } from "./leaves.service";
import { WfhService } from "./wfh.service";
import type { BuildApprovalInboxItem } from "../../notifications/dto/unified-inbox.schemas";

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
      supportsAfterCursor: false,
      fetch: (orgId, _userId, membershipId, limit) =>
        this.fetchLeaves(orgId, membershipId, limit),
    });

    this.registry.register({
      module: "hr",
      kindLabel: "wfh",
      permission: "hr:attendance:manage",
      supportsAfterCursor: false,
      fetch: (orgId, _userId, membershipId, limit) =>
        this.fetchWfh(orgId, membershipId, limit),
    });
  }

  private async fetchLeaves(
    orgId: string,
    membershipId: number | null,
    limit: number,
  ): Promise<BuildApprovalInboxItem[]> {
    if (membershipId === null) return [];
    const rows = await this.leaves.pendingRoutedTo(orgId, membershipId, limit);
    return rows.map(
      (row): BuildApprovalInboxItem => ({
        kind: "build_approval",
        id: row.id,
        approvalKind: "leave",
        status: "pending",
        projectId: null,
        ticketId: null,
        dueAt: null,
        dedupKey: `approval:leave:${String(row.id)}`,
        sourceModule: "hr",
        subject: `${row.leaveType?.name ?? "Leave"} · ${row.startDate} to ${row.endDate}`,
        timestamp: row.createdAt.toISOString(),
        isRead: false,
        deepLink: null,
        actor: row.user
          ? {
              id: row.user.id,
              name: displayName(
                row.user.name,
                row.user.firstName,
                row.user.lastName,
              ),
              image: row.user.image ?? null,
            }
          : null,
      }),
    );
  }

  private async fetchWfh(
    orgId: string,
    membershipId: number | null,
    limit: number,
  ): Promise<BuildApprovalInboxItem[]> {
    if (membershipId === null) return [];
    const rows = await this.wfh.pendingRoutedTo(orgId, membershipId, limit);
    return rows.map(
      (row): BuildApprovalInboxItem => ({
        kind: "build_approval",
        id: row.id,
        approvalKind: "wfh",
        status: "pending",
        projectId: null,
        ticketId: null,
        dueAt: null,
        dedupKey: `approval:wfh:${String(row.id)}`,
        sourceModule: "hr",
        subject: `Work from home · ${row.date}`,
        timestamp: row.createdAt.toISOString(),
        isRead: false,
        deepLink: null,
        actor: {
          id: row.userId,
          name: displayName(row.userName, row.userFirstName, row.userLastName),
          image: null,
        },
      }),
    );
  }
}
