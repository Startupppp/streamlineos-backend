import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  changeRequests,
  projectMilestones,
  projects,
  ticketAttachments,
  ticketComments,
  tickets,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CreatePortalCrInput } from "./dto/client-portal.schemas";

@Injectable()
export class ClientPortalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async assertClientProject(orgId: string, userId: string, projectId: number) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId), eq(projects.clientId, userId), isNull(projects.deletedAt)),
      columns: { id: true },
    });
    if (!project) throw new NotFoundException("Project not found");
  }

  async listPortalProjects(orgId: string, userId: string) {
    return this.db
      .select({
        id: projects.id,
        name: projects.name,
        key: projects.key,
        status: projects.status,
        startDate: projects.startDate,
        targetEndDate: projects.endDate,
      })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.clientId, userId), isNull(projects.deletedAt)))
      .limit(100);
  }

  async getProjectOverview(orgId: string, userId: string, projectId: number) {
    const [project] = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        key: projects.key,
        status: projects.status,
        startDate: projects.startDate,
        targetEndDate: projects.endDate,
      })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), eq(projects.clientId, userId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw new NotFoundException("Project not found");

    const [milestones, tasks, attachments, comments] = await Promise.all([
      this.db
        .select({
          id: projectMilestones.id,
          name: projectMilestones.name,
          dueDate: projectMilestones.targetDate,
          status: projectMilestones.status,
        })
        .from(projectMilestones)
        .where(and(
          eq(projectMilestones.orgId, orgId),
          eq(projectMilestones.projectId, projectId),
          eq(projectMilestones.clientVisible, true),
        ))
        .limit(100),

      this.db
        .select({
          id: tickets.id,
          ticketNumber: tickets.ticketNumber,
          title: tickets.title,
          status: tickets.status,
          dueDate: tickets.dueDate,
        })
        .from(tickets)
        .where(and(
          eq(tickets.orgId, orgId),
          eq(tickets.projectId, projectId),
          eq(tickets.clientVisible, true),
          isNull(tickets.deletedAt),
        ))
        .limit(100),

      this.db
        .select({
          id: ticketAttachments.id,
          filename: ticketAttachments.fileName,
          url: ticketAttachments.fileUrl,
        })
        .from(ticketAttachments)
        .innerJoin(tickets, and(
          eq(tickets.id, ticketAttachments.ticketId),
          eq(tickets.projectId, projectId),
          eq(tickets.orgId, orgId),
          isNull(tickets.deletedAt),
        ))
        .where(and(
          eq(ticketAttachments.orgId, orgId),
          eq(ticketAttachments.clientVisible, true),
        ))
        .limit(100),

      this.db
        .select({
          id: ticketComments.id,
          body: ticketComments.content,
          authorName: sql<string>`COALESCE(${users.name}, ${users.email}, 'Unknown')`,
          createdAt: ticketComments.createdAt,
        })
        .from(ticketComments)
        .innerJoin(tickets, and(
          eq(tickets.id, ticketComments.ticketId),
          eq(tickets.projectId, projectId),
          eq(tickets.orgId, orgId),
          isNull(tickets.deletedAt),
        ))
        .leftJoin(users, eq(users.id, ticketComments.userId))
        .where(and(
          eq(ticketComments.orgId, orgId),
          eq(ticketComments.clientVisible, true),
          isNull(ticketComments.deletedAt),
        ))
        .limit(100),
    ]);

    return { project, milestones, tasks, attachments, comments };
  }

  async listPortalChangeRequests(orgId: string, userId: string, projectId: number) {
    await this.assertClientProject(orgId, userId, projectId);
    return this.db
      .select({
        id: changeRequests.id,
        crNumber: changeRequests.crNumber,
        title: changeRequests.title,
        description: changeRequests.description,
        impact: changeRequests.impact,
        status: changeRequests.status,
        estimateMinutes: changeRequests.estimateMinutes,
        budgetImpactCents: changeRequests.budgetImpactCents,
        timelineImpactDays: changeRequests.timelineImpactDays,
        decisionComment: changeRequests.decisionComment,
        createdAt: changeRequests.createdAt,
      })
      .from(changeRequests)
      .where(and(
        eq(changeRequests.orgId, orgId),
        eq(changeRequests.projectId, projectId),
        isNull(changeRequests.deletedAt),
      ))
      .limit(100);
  }

  async createPortalChangeRequest(orgId: string, userId: string, projectId: number, input: CreatePortalCrInput) {
    await this.assertClientProject(orgId, userId, projectId);
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
        .returning({
          id: changeRequests.id,
          crNumber: changeRequests.crNumber,
          title: changeRequests.title,
          description: changeRequests.description,
          impact: changeRequests.impact,
          status: changeRequests.status,
          estimateMinutes: changeRequests.estimateMinutes,
          budgetImpactCents: changeRequests.budgetImpactCents,
          timelineImpactDays: changeRequests.timelineImpactDays,
          decisionComment: changeRequests.decisionComment,
          createdAt: changeRequests.createdAt,
        });
    });
    this.audit.log({
      action: "change_request.created",
      userId,
      orgId,
      resourceType: "change_request",
      resourceId: String(cr.id),
      metadata: { crId: cr.id, projectId, crNumber: cr.crNumber, title: cr.title, source: "portal" },
    });
    return cr;
  }
}
