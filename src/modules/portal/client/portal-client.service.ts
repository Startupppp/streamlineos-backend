import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
import type { SubmitChangeRequestInput } from "./dto/portal-client.schemas";

type GrantRow = typeof projectClientGrants.$inferSelect;

@Injectable()
export class PortalClientService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async loadActiveGrant(
    orgId: string,
    membershipId: string,
    projectId: number,
  ): Promise<GrantRow> {
    const [grant] = await this.db
      .select()
      .from(projectClientGrants)
      .where(
        and(
          eq(projectClientGrants.organizationId, orgId),
          eq(projectClientGrants.portalMembershipId, membershipId),
          eq(projectClientGrants.projectId, projectId),
          eq(projectClientGrants.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!grant) throw new NotFoundException("Project not found");
    return grant;
  }

  async listGrantedProjects(orgId: string, membershipId: string) {
    const grants = await this.db
      .select({ projectId: projectClientGrants.projectId })
      .from(projectClientGrants)
      .where(
        and(
          eq(projectClientGrants.organizationId, orgId),
          eq(projectClientGrants.portalMembershipId, membershipId),
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
      .where(and(eq(projects.orgId, orgId), inArray(projects.id, projectIds), isNull(projects.deletedAt)))
      .limit(100);
  }

  async getProjectOverview(orgId: string, membershipId: string, projectId: number) {
    const grant = await this.loadActiveGrant(orgId, membershipId, projectId);

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
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
      .limit(1);

    if (!project) throw new NotFoundException("Project not found");

    const [milestones, projectTasks, attachments, comments] = await Promise.all([
      grant.canViewMilestones
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
                eq(projectMilestones.orgId, orgId),
                eq(projectMilestones.projectId, projectId),
                eq(projectMilestones.clientVisible, true),
                isNull(projectMilestones.deletedAt),
              ),
            )
            .limit(100)
        : Promise.resolve([]),

      grant.canViewTasks
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
                eq(tickets.orgId, orgId),
                eq(tickets.projectId, projectId),
                eq(tickets.clientVisible, true),
                isNull(tickets.deletedAt),
              ),
            )
            .limit(100)
        : Promise.resolve([]),

      grant.canViewAttachments
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
                eq(tickets.orgId, orgId),
                isNull(tickets.deletedAt),
              ),
            )
            .where(
              and(
                eq(ticketAttachments.orgId, orgId),
                eq(ticketAttachments.clientVisible, true),
              ),
            )
            .limit(100)
        : Promise.resolve([]),

      grant.canViewComments
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
                eq(tickets.orgId, orgId),
                isNull(tickets.deletedAt),
              ),
            )
            .leftJoin(users, eq(users.id, ticketComments.userId))
            .where(
              and(
                eq(ticketComments.orgId, orgId),
                eq(ticketComments.clientVisible, true),
                isNull(ticketComments.deletedAt),
              ),
            )
            .limit(100)
        : Promise.resolve([]),
    ]);

    return { project, milestones, tasks: projectTasks, attachments, comments };
  }

  async submitChangeRequest(
    orgId: string,
    membershipId: string,
    portalUserMembershipId: number | null,
    projectId: number,
    input: SubmitChangeRequestInput,
  ) {
    const grant = await this.loadActiveGrant(orgId, membershipId, projectId);

    if (!grant.canSubmitChangeRequests) {
      throw new ForbiddenException("Change request submission not permitted for this project");
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);

      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${changeRequests.crNumber}), 0)` })
        .from(changeRequests)
        .where(
          and(
            eq(changeRequests.projectId, projectId),
            eq(changeRequests.orgId, orgId),
          ),
        );

      const nextNumber = (maxRow?.maxNum ?? 0) + 1;

      const [cr] = await tx
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
          requestedById: null,
          createdBy: null,
        })
        .returning({
          id: changeRequests.id,
          crNumber: changeRequests.crNumber,
          title: changeRequests.title,
          status: changeRequests.status,
          createdAt: changeRequests.createdAt,
        });

      return cr;
    });
  }
}
