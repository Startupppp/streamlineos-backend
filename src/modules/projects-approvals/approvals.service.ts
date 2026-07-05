import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { projectApprovals, projects } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { AccessService } from "../access/access.service";
import type {
  CreateApprovalInput,
  DecideApprovalInput,
  ListApprovalsQuery,
  UpdateApprovalInput,
} from "./dto/approvals.schemas";

type ApprovalPatch = Partial<
  Pick<typeof projectApprovals.$inferInsert, "approverId" | "dueAt" | "status">
>;

const DECIDABLE = new Set<string>(["pending", "escalated", "changes_requested"]);

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  private async assertProject(orgId: string, projectId: number): Promise<void> {
    const p = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      columns: { id: true },
    });
    if (!p) throw new NotFoundException("Project not found");
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

  async getInbox(orgId: string, userId: string) {
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
          eq(projectApprovals.approverId, userId),
          or(
            eq(projectApprovals.status, "pending"),
            eq(projectApprovals.status, "escalated"),
          ),
          isNull(projectApprovals.deletedAt),
        ),
      )
      .orderBy(sql`${projectApprovals.dueAt} ASC NULLS LAST`);
  }

  async listApprovals(orgId: string, projectId: number, query: ListApprovalsQuery) {
    await this.assertProject(orgId, projectId);
    return this.db
      .select()
      .from(projectApprovals)
      .where(
        and(
          eq(projectApprovals.orgId, orgId),
          eq(projectApprovals.projectId, projectId),
          isNull(projectApprovals.deletedAt),
          query.status ? eq(projectApprovals.status, query.status) : undefined,
          query.entityType ? eq(projectApprovals.entityType, query.entityType) : undefined,
        ),
      )
      .orderBy(sql`${projectApprovals.dueAt} ASC NULLS LAST`);
  }

  async getApproval(orgId: string, projectId: number, approvalId: number) {
    return this.loadApproval(orgId, projectId, approvalId);
  }

  async createApproval(
    orgId: string,
    userId: string,
    projectId: number,
    input: CreateApprovalInput,
  ) {
    if (input.approverId === userId) {
      throw new BadRequestException("Approver cannot be the requester");
    }
    await this.assertProject(orgId, projectId);
    const [approval] = await this.db
      .insert(projectApprovals)
      .values({
        orgId,
        projectId,
        entityType: input.entityType,
        entityId: input.entityId,
        title: input.title,
        approverId: input.approverId,
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
    return approval;
  }

  async decideApproval(
    orgId: string,
    userId: string,
    projectId: number,
    approvalId: number,
    input: DecideApprovalInput,
  ) {
    const approval = await this.loadApproval(orgId, projectId, approvalId);

    if (approval.approverId !== userId) {
      const perms = await this.access.resolveUserPermissions(orgId, userId);
      if (!perms.has("projects:approvals:manage")) {
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
    if (input.approverId !== undefined) patch.approverId = input.approverId;
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
