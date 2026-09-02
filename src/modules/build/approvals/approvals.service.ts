import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { projectApprovals, projects } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import { ChatChannelsService } from "../../chat/chat-channels.service";
import { ChatMessagesService } from "../../chat/chat-messages.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import {
  assertOrganizationActor,
  OrganizationActorError,
  organizationActorHttpError,
} from "../../../common/organization/organization-actor";
import type { OrganizationActor } from "../../../common/organization/organization-actor";
import { assertProjectAccess } from "../core/project-access";
import type {
  CreateApprovalInput,
  DecideApprovalInput,
  ListApprovalsQuery,
  UpdateApprovalInput,
} from "./dto/approvals.schemas";

type ApprovalPatch = Partial<
  Pick<typeof projectApprovals.$inferInsert, "approverMembershipId" | "dueAt" | "status">
>;

const DECIDABLE = new Set<string>(["pending", "escalated", "changes_requested"]);

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly chatChannels: ChatChannelsService,
    private readonly chatMessages: ChatMessagesService,
  ) {}

  private async notifyProjectChannel(
    orgId: string,
    projectId: number,
    requestedById: string,
    title: string,
  ): Promise<void> {
    const channel = await this.chatChannels.getOrCreateEntityChannel(
      "project",
      String(projectId),
      { orgId, userId: requestedById, isOrgOwner: false },
    );
    await this.chatMessages.sendSystemMessage(
      channel.id,
      requestedById,
      orgId,
      `Approval requested: ${title}`,
      { type: "approval_requested", projectId },
    );
  }

  private async loadApproval(orgId: string, projectId: number, approvalId: number) {
    const row = await this.db.query.projectApprovals.findFirst({
      where: and(
        eq(projectApprovals.id, approvalId),
        eq(projectApprovals.orgId, orgId),
        eq(projectApprovals.projectId, projectId),
        isNull(projectApprovals.deletedAt),
      ),
    });
    if (!row) throw new NotFoundException("Approval not found");
    return row;
  }

  async getInbox(orgId: string, membershipId: number) {
    return this.db
      .select({
        id: projectApprovals.id,
        projectId: projectApprovals.projectId,
        projectName: projects.name,
        projectKey: projects.key,
        entityType: projectApprovals.entityType,
        entityId: projectApprovals.entityId,
        title: projectApprovals.title,
        status: projectApprovals.status,
        level: projectApprovals.level,
        dueAt: projectApprovals.dueAt,
        requestedById: projectApprovals.requestedById,
        decidedAt: projectApprovals.decidedAt,
      })
      .from(projectApprovals)
      .innerJoin(projects, eq(projects.id, projectApprovals.projectId))
      .where(
        and(
          eq(projectApprovals.orgId, orgId),
          eq(projectApprovals.approverMembershipId, membershipId),
          or(
            eq(projectApprovals.status, "pending"),
            eq(projectApprovals.status, "escalated"),
          ),
          isNull(projectApprovals.deletedAt),
        ),
      )
      .orderBy(sql`${projectApprovals.dueAt} ASC NULLS LAST`)
      .limit(100);
  }

  async listApprovals(u: CurrentUserContext, projectId: number, query: ListApprovalsQuery) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    return this.db
      .select()
      .from(projectApprovals)
      .where(
        and(
          eq(projectApprovals.orgId, u.orgId),
          eq(projectApprovals.projectId, projectId),
          isNull(projectApprovals.deletedAt),
          query.status ? eq(projectApprovals.status, query.status) : undefined,
          query.entityType ? eq(projectApprovals.entityType, query.entityType) : undefined,
        ),
      )
      .orderBy(sql`${projectApprovals.dueAt} ASC NULLS LAST`)
      .limit(100);
  }

  async getApproval(orgId: string, projectId: number, approvalId: number) {
    return this.loadApproval(orgId, projectId, approvalId);
  }

  async createApproval(
    u: CurrentUserContext,
    projectId: number,
    input: CreateApprovalInput,
  ) {
    if (input.approverId === u.userId) {
      throw new BadRequestException("Approver cannot be the requester");
    }
    await assertProjectAccess(this.db, this.access, u, projectId);
    const { orgId, userId } = u;

    let approverActor: OrganizationActor;
    try {
      approverActor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId: input.approverId });
    } catch (e) {
      if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
      throw e;
    }

    const existing = await this.db.query.projectApprovals.findFirst({
      where: and(
        eq(projectApprovals.orgId, orgId),
        eq(projectApprovals.projectId, projectId),
        eq(projectApprovals.entityType, input.entityType),
        eq(projectApprovals.entityId, input.entityId),
        eq(projectApprovals.approverMembershipId, approverActor.membershipId),
        inArray(projectApprovals.status, ["pending", "requested", "escalated"]),
        isNull(projectApprovals.deletedAt),
      ),
      columns: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        "A pending approval for this item and approver already exists",
      );
    }

    const [approval] = await this.db
      .insert(projectApprovals)
      .values({
        orgId,
        projectId,
        entityType: input.entityType,
        entityId: input.entityId,
        title: input.title,
        reason: input.reason ?? null,
        approverMembershipId: approverActor.membershipId,
        dueAt: input.dueAt ?? null,
        level: input.level ?? 1,
        requestedById: userId,
        status: "pending",
        createdBy: userId,
      })
      .returning();
    if (!approval) throw new NotFoundException("Failed to create approval");
    this.audit.log({
      action: "approval.requested",
      userId,
      orgId,
      resourceType: "project_approval",
      resourceId: String(approval.id),
      metadata: { projectId, approvalId: approval.id, title: approval.title, approverId: input.approverId },
    });
    registerAfterCommit(() =>
      runInNewTenantTransaction(this.db, orgId, () =>
        this.notifyProjectChannel(orgId, projectId, userId, approval.title),
      ).catch((error: unknown) => {
        this.logger.error(
          `approval notification failed for project ${projectId} in org ${orgId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }),
    );
    return approval;
  }

  async decideApproval(
    user: CurrentUserContext,
    projectId: number,
    approvalId: number,
    input: DecideApprovalInput,
  ) {
    const { orgId, userId } = user;
    const approval = await this.loadApproval(orgId, projectId, approvalId);

    const callerMid = actingMembershipId(user.principal);
    if (approval.approverMembershipId !== callerMid || callerMid === null) {
      if (!(await this.access.holds(user, "build:approvals:manage"))) {
        throw new NotFoundException("Approval not found");
      }
    }

    if (!DECIDABLE.has(approval.status)) {
      throw new ConflictException("Approval has already been decided");
    }

    const [updated] = await this.db
      .update(projectApprovals)
      .set({
        status: input.decision,
        decidedAt: new Date(),
        decisionComment: input.decisionComment ?? null,
      })
      .where(and(eq(projectApprovals.id, approvalId), eq(projectApprovals.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Approval not found");

    this.audit.log({
      action: "approval.decided",
      userId,
      orgId,
      resourceType: "project_approval",
      resourceId: String(approvalId),
      metadata: { projectId, approvalId, decision: input.decision },
    });
    return updated;
  }

  async updateApproval(
    orgId: string,
    userId: string,
    projectId: number,
    approvalId: number,
    input: UpdateApprovalInput,
  ) {
    await this.loadApproval(orgId, projectId, approvalId);

    const patch: ApprovalPatch = {};
    if (input.approverId !== undefined) {
      try {
        const actor = await assertOrganizationActor(this.db, orgId, { kind: "user", userId: input.approverId });
        patch.approverMembershipId = actor.membershipId;
      } catch (e) {
        if (e instanceof OrganizationActorError) throw organizationActorHttpError(e);
        throw e;
      }
    }
    if (input.dueAt !== undefined) patch.dueAt = input.dueAt ?? null;
    if (input.status !== undefined) patch.status = input.status;

    const [updated] = await this.db
      .update(projectApprovals)
      .set(patch)
      .where(and(eq(projectApprovals.id, approvalId), eq(projectApprovals.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Approval not found");

    if (input.approverId !== undefined) {
      this.audit.log({
        action: "approval.delegated",
        userId,
        orgId,
        resourceType: "project_approval",
        resourceId: String(approvalId),
        metadata: { projectId, approvalId, newApproverId: input.approverId },
      });
    }
    if (input.status === "escalated") {
      this.audit.log({
        action: "approval.escalated",
        userId,
        orgId,
        resourceType: "project_approval",
        resourceId: String(approvalId),
        metadata: { projectId, approvalId },
      });
    }
    if (input.status === "cancelled") {
      this.audit.log({
        action: "approval.cancelled",
        userId,
        orgId,
        resourceType: "project_approval",
        resourceId: String(approvalId),
        metadata: { projectId, approvalId },
      });
    }
    return updated;
  }

  async softDeleteApproval(orgId: string, projectId: number, approvalId: number) {
    await this.loadApproval(orgId, projectId, approvalId);
    await this.db
      .update(projectApprovals)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectApprovals.id, approvalId), eq(projectApprovals.orgId, orgId)));
  }
}
