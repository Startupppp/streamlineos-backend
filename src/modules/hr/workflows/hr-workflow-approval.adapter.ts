import { Injectable, OnModuleInit } from "@nestjs/common";
import { ApprovalAdapterRegistry } from "../../attention/approval-adapter.registry";
import { HrWorkflowInstancesService } from "./hr-workflow-instances.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { BuildApprovalInboxItem } from "../../notifications/dto/unified-inbox.schemas";

function minimalContext(
  orgId: string,
  userId: string,
  membershipId: number,
): CurrentUserContext {
  return {
    orgId,
    userId,
    role: "member",
    isOrgOwner: false,
    sessionId: "",
    tokenScopes: null,
    principal: humanSessionPrincipal(membershipId, false),
  };
}

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
      supportsAfterCursor: false,
      fetch: (orgId, userId, membershipId, limit) =>
        this.fetchWorkflows(orgId, userId, membershipId, limit),
    });
  }

  private async fetchWorkflows(
    orgId: string,
    userId: string,
    membershipId: number | null,
    limit: number,
  ): Promise<BuildApprovalInboxItem[]> {
    if (membershipId === null) return [];
    const u = minimalContext(orgId, userId, membershipId);
    const result = await this.workflows.getInbox(u, 1, limit);
    return result.data.map((row): BuildApprovalInboxItem => ({
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
      deepLink: null,
      actor: null,
    }));
  }
}
