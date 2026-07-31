import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { changeRequests, projects } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CreateChangeRequestInput, ListCrQuery, UpdateChangeRequestInput } from "./dto/change-requests.schemas";

@Injectable()
export class ChangeRequestsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async assertProject(orgId: string, projectId: number) {
    const p = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      columns: { id: true },
    });
    if (!p) throw new NotFoundException("Project not found");
  }

  async listChangeRequests(orgId: string, projectId: number, query: ListCrQuery) {
    await this.assertProject(orgId, projectId);
    const conditions = [
      eq(changeRequests.orgId, orgId),
      eq(changeRequests.projectId, projectId),
      isNull(changeRequests.deletedAt),
    ];
    if (query.status) conditions.push(eq(changeRequests.status, query.status));
    return this.db
      .select()
      .from(changeRequests)
      .where(and(...conditions))
      .orderBy(changeRequests.crNumber);
  }

  async getChangeRequest(orgId: string, projectId: number, crId: number) {
    const cr = await this.db.query.changeRequests.findFirst({
      where: and(
        eq(changeRequests.id, crId),
        eq(changeRequests.orgId, orgId),
        eq(changeRequests.projectId, projectId),
        isNull(changeRequests.deletedAt),
      ),
    });
    if (!cr) throw new NotFoundException("Change request not found");
    return cr;
  }

  async createChangeRequest(orgId: string, userId: string, projectId: number, input: CreateChangeRequestInput) {
    await this.assertProject(orgId, projectId);
    const [cr] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${changeRequests.crNumber}), 0)` })
        .from(changeRequests)
        .where(and(eq(changeRequests.projectId, projectId), eq(changeRequests.orgId, orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      return tx
        .insert(changeRequests)
        .values({
          orgId,
          projectId,
          crNumber: nextNumber,
          title: input.title,
          description: input.description,
          impact: input.impact,
          estimateMinutes: input.estimateMinutes,
          budgetImpactCents: input.budgetImpactCents,
          timelineImpactDays: input.timelineImpactDays,
          status: "submitted",
          requestedById: userId,
          createdBy: userId,
        })
        .returning();
    });
    this.audit.log({
      action: "change_request.created",
      userId,
      orgId,
      resourceType: "change_request",
      resourceId: String(cr.id),
      metadata: { crId: cr.id, projectId, crNumber: cr.crNumber, title: cr.title },
    });
    return cr;
  }

  async updateChangeRequest(
    orgId: string,
    userId: string,
    projectId: number,
    crId: number,
    input: UpdateChangeRequestInput,
  ) {
    const existing = await this.db.query.changeRequests.findFirst({
      where: and(
        eq(changeRequests.id, crId),
        eq(changeRequests.orgId, orgId),
        eq(changeRequests.projectId, projectId),
        isNull(changeRequests.deletedAt),
      ),
      columns: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException("Change request not found");

    const isDecision = input.status === "approved" || input.status === "rejected";
    const [updated] = await this.db
      .update(changeRequests)
      .set({
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.impact !== undefined && { impact: input.impact }),
        ...(input.estimateMinutes !== undefined && { estimateMinutes: input.estimateMinutes }),
        ...(input.budgetImpactCents !== undefined && { budgetImpactCents: input.budgetImpactCents }),
        ...(input.timelineImpactDays !== undefined && { timelineImpactDays: input.timelineImpactDays }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.approvalOwnerId !== undefined && { approvalOwnerId: input.approvalOwnerId }),
        ...(input.decisionComment !== undefined && { decisionComment: input.decisionComment }),
        ...(isDecision && { decidedAt: new Date(), approvalOwnerId: input.approvalOwnerId ?? userId }),
        updatedAt: new Date(),
      })
      .where(and(eq(changeRequests.id, crId), eq(changeRequests.orgId, orgId)))
      .returning();
    if (input.status !== undefined && input.status !== existing.status) {
      this.audit.log({
        action: "change_request.status_changed",
        userId,
        orgId,
        resourceType: "change_request",
        resourceId: String(crId),
        metadata: { crId, projectId, from: existing.status, to: input.status },
      });
    }
    return updated;
  }

  async deleteChangeRequest(orgId: string, projectId: number, crId: number) {
    const existing = await this.db.query.changeRequests.findFirst({
      where: and(
        eq(changeRequests.id, crId),
        eq(changeRequests.orgId, orgId),
        eq(changeRequests.projectId, projectId),
        isNull(changeRequests.deletedAt),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Change request not found");
    await this.db
      .update(changeRequests)
      .set({ deletedAt: new Date() })
      .where(and(eq(changeRequests.id, crId), eq(changeRequests.orgId, orgId)));
    return { success: true };
  }
}
