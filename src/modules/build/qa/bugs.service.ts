import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, ilike, isNull, sql } from "drizzle-orm";
import { bugs, organizationMembers } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { assertProjectAccess } from "../core/project-access";
import { AuditService } from "../../../common/audit/audit.service";
import type { BugListQuery, CreateBugInput, UpdateBugInput } from "./dto/bugs.schemas";

@Injectable()
export class BugsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async listBugs(u: CurrentUserContext, projectId: number, query: BugListQuery) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const conditions = [
      eq(bugs.orgId, u.orgId),
      eq(bugs.projectId, projectId),
      isNull(bugs.deletedAt),
    ];
    if (query.status) conditions.push(eq(bugs.status, query.status));
    if (query.severity) conditions.push(eq(bugs.severity, query.severity));
    if (query.assigneeId) conditions.push(sql`${bugs.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${u.orgId} AND user_id = ${query.assigneeId} AND status = 'ACTIVE')`);
    if (query.q) conditions.push(ilike(bugs.title, `%${query.q}%`));
    return this.db
      .select()
      .from(bugs)
      .where(and(...conditions))
      .orderBy(bugs.bugNumber)
      .limit(100);
  }

  async getBug(orgId: string, projectId: number, bugId: number) {
    const bug = await this.db.query.bugs.findFirst({
      where: and(
        eq(bugs.id, bugId),
        eq(bugs.orgId, orgId),
        eq(bugs.projectId, projectId),
        isNull(bugs.deletedAt),
      ),
    });
    if (!bug) throw new NotFoundException("Bug not found");
    return bug;
  }

  async createBug(u: CurrentUserContext, projectId: number, input: CreateBugInput) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const [bug] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${bugs.bugNumber}), 0)` })
        .from(bugs)
        .where(and(eq(bugs.projectId, projectId), eq(bugs.orgId, u.orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      const assigneeMembershipId = input.assigneeId
        ? (await tx.query.organizationMembers.findFirst({
            where: and(eq(organizationMembers.orgId, u.orgId), eq(organizationMembers.userId, input.assigneeId), eq(organizationMembers.status, "ACTIVE")),
            columns: { id: true },
          }))?.id ?? null
        : null;
      return tx
        .insert(bugs)
        .values({
          orgId: u.orgId,
          projectId,
          bugNumber: nextNumber,
          title: input.title,
          description: input.description,
          severity: input.severity ?? "major",
          priority: input.priority ?? "medium",
          status: "new",
          stepsToReproduce: input.stepsToReproduce,
          expectedResult: input.expectedResult,
          actualResult: input.actualResult,
          environment: input.environment,
          browserDevice: input.browserDevice,
          affectedReleaseId: input.affectedReleaseId ?? null,
          fixedReleaseId: input.fixedReleaseId ?? null,
          assigneeMembershipId,
          qaOwnerId: input.qaOwnerId ?? null,
          linkedTicketId: input.linkedTicketId ?? null,
          linkedTestCaseId: input.linkedTestCaseId ?? null,
          reporterId: u.userId,
          createdBy: u.userId,
        })
        .returning();
    });
    this.audit.log({
      action: "bug.created",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "bug",
      resourceId: String(bug.id),
      metadata: { bugId: bug.id, projectId, title: bug.title },
    });
    return bug;
  }

  async updateBug(orgId: string, userId: string, projectId: number, bugId: number, input: UpdateBugInput) {
    const existing = await this.db.query.bugs.findFirst({
      where: and(
        eq(bugs.id, bugId),
        eq(bugs.orgId, orgId),
        eq(bugs.projectId, projectId),
        isNull(bugs.deletedAt),
      ),
      columns: { id: true, status: true, reopenCount: true },
    });
    if (!existing) throw new NotFoundException("Bug not found");
    const isReopening = input.status === "reopened" && existing.status !== "reopened";
    const [updated] = await this.db
      .update(bugs)
      .set({
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.severity !== undefined && { severity: input.severity }),
        ...(input.priority !== undefined && { priority: input.priority }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.stepsToReproduce !== undefined && { stepsToReproduce: input.stepsToReproduce }),
        ...(input.expectedResult !== undefined && { expectedResult: input.expectedResult }),
        ...(input.actualResult !== undefined && { actualResult: input.actualResult }),
        ...(input.environment !== undefined && { environment: input.environment }),
        ...(input.browserDevice !== undefined && { browserDevice: input.browserDevice }),
        ...(input.affectedReleaseId !== undefined && { affectedReleaseId: input.affectedReleaseId }),
        ...(input.fixedReleaseId !== undefined && { fixedReleaseId: input.fixedReleaseId }),
        ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId }),
        ...(input.qaOwnerId !== undefined && { qaOwnerId: input.qaOwnerId }),
        ...(input.linkedTicketId !== undefined && { linkedTicketId: input.linkedTicketId }),
        ...(input.linkedTestCaseId !== undefined && { linkedTestCaseId: input.linkedTestCaseId }),
        ...(isReopening && { reopenCount: existing.reopenCount + 1 }),
        updatedAt: new Date(),
      })
      .where(and(eq(bugs.id, bugId), eq(bugs.orgId, orgId)))
      .returning();
    if (input.status !== undefined) {
      this.audit.log({
        action: "bug.status_changed",
        userId,
        orgId,
        resourceType: "bug",
        resourceId: String(bugId),
        metadata: { bugId, projectId, from: existing.status, to: input.status },
      });
    }
    return updated;
  }

  async deleteBug(orgId: string, projectId: number, bugId: number) {
    const existing = await this.db.query.bugs.findFirst({
      where: and(
        eq(bugs.id, bugId),
        eq(bugs.orgId, orgId),
        eq(bugs.projectId, projectId),
        isNull(bugs.deletedAt),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Bug not found");
    await this.db
      .update(bugs)
      .set({ deletedAt: new Date() })
      .where(and(eq(bugs.id, bugId), eq(bugs.orgId, orgId)));
    return { success: true };
  }
}
