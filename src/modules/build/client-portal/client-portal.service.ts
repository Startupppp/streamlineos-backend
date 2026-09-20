import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  changeRequests,
  projectClientGrants,
  projectMilestones,
  projects,
  ticketAttachments,
  ticketComments,
  tickets,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CreatePortalCrInput } from "./dto/client-portal.schemas";
import { assertProjectAccess } from "../core/project-access";

@Injectable()
export class ClientPortalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async createPortalChangeRequest(u: CurrentUserContext, projectId: number, input: CreatePortalCrInput) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const [cr] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${changeRequests.crNumber}), 0)` })
        .from(changeRequests)
        .where(and(eq(changeRequests.projectId, projectId), eq(changeRequests.orgId, u.orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      return tx
        .insert(changeRequests)
        .values({
          orgId: u.orgId,
          projectId,
          crNumber: nextNumber,
          title: input.title,
          description: input.description,
          impact: input.impact,
          estimateMinutes: input.estimateMinutes,
          budgetImpactCents: input.budgetImpactCents,
          timelineImpactDays: input.timelineImpactDays,
          status: "submitted",
          requestedById: u.userId,
          createdBy: u.userId,
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
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "change_request",
      resourceId: String(cr.id),
      metadata: { crId: cr.id, projectId, crNumber: cr.crNumber, title: cr.title, source: "portal" },
    });
    return cr;
  }

  async listPortalProjects(orgId: string) {
    const grants = await this.db
      .select({ projectId: projectClientGrants.projectId })
      .from(projectClientGrants)
      .where(
        and(
          eq(projectClientGrants.organizationId, orgId),
          eq(projectClientGrants.status, "ACTIVE"),
        ),
      )
      .limit(100);

    if (grants.length === 0) return [];

    const projectIds = grants.map((g) => g.projectId);
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
      .where(
        and(eq(projects.orgId, orgId), inArray(projects.id, projectIds), isNull(projects.deletedAt)),
      )
      .limit(100);
  }

  async getProjectOverview(u: CurrentUserContext, projectId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);

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
      .where(and(eq(projects.id, projectId), eq(projects.orgId, u.orgId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw new NotFoundException("Project not found");

    const [grantRow] = await this.db
      .select({
        canViewMilestones: projectClientGrants.canViewMilestones,
        canViewTasks: projectClientGrants.canViewTasks,
        canViewAttachments: projectClientGrants.canViewAttachments,
        canViewComments: projectClientGrants.canViewComments,
      })
      .from(projectClientGrants)
      .where(
        and(
          eq(projectClientGrants.organizationId, u.orgId),
          eq(projectClientGrants.projectId, projectId),
          eq(projectClientGrants.status, "ACTIVE"),
        ),
      )
      .orderBy(desc(projectClientGrants.createdAt))
      .limit(1);

    const capabilities = grantRow ?? {
      canViewMilestones: false,
      canViewTasks: false,
      canViewAttachments: false,
      canViewComments: false,
    };

    const [milestones, tasks, attachments, comments] = await Promise.all([
      capabilities.canViewMilestones
        ? this.db
            .select({
              id: projectMilestones.id,
              name: projectMilestones.name,
              dueDate: projectMilestones.targetDate,
              status: projectMilestones.status,
            })
            .from(projectMilestones)
            .where(
              and(
                eq(projectMilestones.orgId, u.orgId),
                eq(projectMilestones.projectId, projectId),
                eq(projectMilestones.clientVisible, true),
                isNull(projectMilestones.deletedAt),
              ),
            )
            .limit(100)
        : Promise.resolve([]),

      capabilities.canViewTasks
        ? this.db
            .select({
              id: tickets.id,
              ticketNumber: tickets.ticketNumber,
              title: tickets.title,
              status: tickets.status,
              dueDate: tickets.dueDate,
            })
            .from(tickets)
            .where(
              and(
                eq(tickets.orgId, u.orgId),
                eq(tickets.projectId, projectId),
                eq(tickets.clientVisible, true),
                isNull(tickets.deletedAt),
              ),
            )
            .limit(100)
        : Promise.resolve([]),

      capabilities.canViewAttachments
        ? this.db
            .select({
              id: ticketAttachments.id,
              filename: ticketAttachments.fileName,
              url: ticketAttachments.fileUrl,
            })
            .from(ticketAttachments)
            .innerJoin(
              tickets,
              and(
                eq(tickets.id, ticketAttachments.ticketId),
                eq(tickets.projectId, projectId),
                eq(tickets.orgId, u.orgId),
                isNull(tickets.deletedAt),
              ),
            )
            .where(
              and(
                eq(ticketAttachments.orgId, u.orgId),
                eq(ticketAttachments.clientVisible, true),
              ),
            )
            .limit(100)
        : Promise.resolve([]),

      capabilities.canViewComments
        ? this.db
            .select({
              id: ticketComments.id,
              body: ticketComments.content,
              authorName: sql<string>`COALESCE(${users.name}, ${users.email}, 'Unknown')`,
              createdAt: ticketComments.createdAt,
            })
            .from(ticketComments)
            .innerJoin(
              tickets,
              and(
                eq(tickets.id, ticketComments.ticketId),
                eq(tickets.projectId, projectId),
                eq(tickets.orgId, u.orgId),
                isNull(tickets.deletedAt),
              ),
            )
            .leftJoin(users, eq(users.id, ticketComments.userId))
            .where(
              and(
                eq(ticketComments.orgId, u.orgId),
                eq(ticketComments.clientVisible, true),
                isNull(ticketComments.deletedAt),
              ),
            )
            .limit(100)
        : Promise.resolve([]),
    ]);

    return { project, milestones, tasks, attachments, comments };
  }

  async listPortalChangeRequests(u: CurrentUserContext, projectId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
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
      .where(
        and(
          eq(changeRequests.orgId, u.orgId),
          eq(changeRequests.projectId, projectId),
          isNull(changeRequests.deletedAt),
        ),
      )
      .limit(100);
  }
}
