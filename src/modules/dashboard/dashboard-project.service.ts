import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { organizationMembers, projectMembers, projects, sprints, tickets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import { resolveBuildDashboardScope } from "./dashboard-scope";
import { DASHBOARD_PROJECT_ID_CAP } from "./dashboard-read-limits";

@Injectable()
export class DashboardProjectService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  private async resolveProjectIds(
    orgId: string,
    userId: string,
    isAll: boolean,
  ): Promise<number[]> {
    if (isAll) {
      const allProjects = await this.db.query.projects.findMany({
        where: and(eq(projects.orgId, orgId), isNull(projects.deletedAt)),
        columns: { id: true },
        orderBy: [desc(projects.id)],
        limit: DASHBOARD_PROJECT_ID_CAP,
      });
      return allProjects.map((p) => p.id);
    }
    const memberOf = await this.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, projectMembers.orgId), eq(organizationMembers.id, projectMembers.membershipId)))
      .where(and(eq(projectMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
      .orderBy(desc(projectMembers.projectId))
      .limit(DASHBOARD_PROJECT_ID_CAP);
    return memberOf.map((m) => m.projectId);
  }

  async getRecentProjects(orgId: string, u: CurrentUserContext) {
    const scope = await resolveBuildDashboardScope(this.access, u);
    if (scope === "none") return [];

    if (scope === "all") {
      return this.db.query.projects.findMany({
        where: and(eq(projects.orgId, orgId), isNull(projects.deletedAt)),
        orderBy: [desc(projects.id)],
        limit: 5,
        with: {
          manager: { with: { user: { columns: { id: true, name: true, firstName: true, lastName: true, image: true } } } },
        },
      });
    }

    const managerMember = await this.db.query.organizationMembers.findFirst({ where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, u.userId)), columns: { id: true } });
    const memberOf = await this.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, projectMembers.orgId), eq(organizationMembers.id, projectMembers.membershipId)))
      .where(and(eq(projectMembers.orgId, orgId), eq(organizationMembers.userId, u.userId)));

    const projectIds = memberOf.map((m) => m.projectId);

    return this.db.query.projects.findMany({
      where: and(
        eq(projects.orgId, orgId),
        isNull(projects.deletedAt),
        or(
          eq(projects.managerMembershipId, managerMember?.id ?? -1),
          projectIds.length > 0 ? inArray(projects.id, projectIds) : undefined,
        ),
      ),
      orderBy: [desc(projects.id)],
      limit: 5,
      with: {
        manager: { with: { user: { columns: { id: true, name: true, firstName: true, lastName: true, image: true } } } },
      },
    });
  }

  async getMyIssues(orgId: string, userId: string) {
    const member = await this.db.query.organizationMembers.findFirst({ where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)), columns: { id: true } });
    if (!member) return [];
    const issues = await this.db.query.tickets.findMany({
      where: and(eq(tickets.orgId, orgId), eq(tickets.assigneeMembershipId, member.id), isNull(tickets.deletedAt)),
      orderBy: [desc(tickets.updatedAt)],
      limit: 10,
      with: {
        project: { columns: { id: true, name: true, key: true } },
        assignee: { with: { user: { columns: { id: true, firstName: true, lastName: true, image: true } } } },
      },
    });

    return issues.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status ?? "TODO",
      type: t.type ?? "TASK",
      priority: t.priority ?? "MEDIUM",
      ticketNumber: String(t.ticketNumber),
      updatedAt: t.updatedAt,
      projectName: t.project?.name ?? "",
      projectId: t.project?.id,
      projectKey: t.project?.key ?? "",
      assignee: t.assignee?.user
        ? {
            id: t.assignee.id,
            firstName: t.assignee.user.firstName,
            lastName: t.assignee.user.lastName,
            image: t.assignee.user.image,
          }
        : null,
    }));
  }

  async getActiveSprintSummary(orgId: string, u: CurrentUserContext) {
    const scope = await resolveBuildDashboardScope(this.access, u);
    if (scope === "none") return null;
    const projectIds = await this.resolveProjectIds(orgId, u.userId, scope === "all");
    if (projectIds.length === 0) return null;

    const activeSprint = await this.db.query.sprints.findFirst({
      where: and(
        eq(sprints.orgId, orgId),
        eq(sprints.status, "ACTIVE"),
        inArray(sprints.projectId, projectIds),
        isNull(sprints.deletedAt),
      ),
      with: {
        project: { columns: { id: true, name: true } },
      },
    });

    if (!activeSprint) return null;

    const statsRows = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        done: sql<number>`(count(*) filter (where ${tickets.status} = 'DONE'))::int`,
        inProgress: sql<number>`(count(*) filter (where ${tickets.status} in ('IN_PROGRESS', 'IN_REVIEW')))::int`,
        totalPoints: sql<number>`coalesce(sum(${tickets.points}), 0)::int`,
        completedPoints: sql<number>`(coalesce(sum(${tickets.points}) filter (where ${tickets.status} = 'DONE'), 0))::int`,
      })
      .from(tickets)
      .where(
        and(
          eq(tickets.orgId, orgId),
          eq(tickets.sprintId, activeSprint.id),
          isNull(tickets.deletedAt),
        ),
      );

    const stats = statsRows[0];
    if (!stats) return null;

    const totalTickets = Number(stats.total);
    const doneTickets = Number(stats.done);
    const inProgressTickets = Number(stats.inProgress);
    const todoTickets = totalTickets - doneTickets - inProgressTickets;
    const totalPoints = Number(stats.totalPoints);
    const completedPoints = Number(stats.completedPoints);
    const progress =
      totalPoints > 0
        ? Math.round((completedPoints / totalPoints) * 100)
        : totalTickets > 0
          ? Math.round((doneTickets / totalTickets) * 100)
          : 0;

    const now = new Date();
    const endDate = activeSprint.endDate ? new Date(activeSprint.endDate) : now;
    const daysRemaining = Math.ceil(
      (endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );

    return {
      id: activeSprint.id,
      name: activeSprint.name,
      projectName: activeSprint.project?.name || "Project",
      projectId: activeSprint.project?.id,
      progress,
      daysRemaining,
      totalTickets,
      doneTickets,
      inProgressTickets,
      todoTickets,
      totalPoints,
      completedPoints,
    };
  }

  async getRecentActivity(orgId: string, u: CurrentUserContext) {
    const scope = await resolveBuildDashboardScope(this.access, u);
    if (scope === "none") return [];
    const projectIds = await this.resolveProjectIds(orgId, u.userId, scope === "all");
    if (projectIds.length === 0) return [];
    const managerMember = await this.db.query.organizationMembers.findFirst({ where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, u.userId)), columns: { id: true } });

    const ticketFilters: SQL[] = [
      eq(tickets.orgId, orgId),
      inArray(tickets.projectId, projectIds),
      isNull(tickets.deletedAt),
    ];

    if (scope !== "all") {
      const ownerFilter = or(
        eq(tickets.assigneeMembershipId, managerMember?.id ?? -1),
        eq(tickets.reporterId, u.userId),
      );
      if (ownerFilter) ticketFilters.push(ownerFilter);
    }

    const recentTickets = await this.db.query.tickets.findMany({
      where: and(...ticketFilters),
      orderBy: [desc(tickets.updatedAt)],
      limit: 10,
      with: {
        project: { columns: { id: true, name: true, key: true } },
        assignee: { with: { user: { columns: { id: true, firstName: true, lastName: true, image: true } } } },
      },
    });

    return recentTickets.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      type: t.type,
      priority: t.priority,
      ticketNumber: t.ticketNumber,
      updatedAt: t.updatedAt,
      projectName: t.project?.name || "",
      projectId: t.project?.id,
      projectKey: t.project?.key || "",
      assignee: t.assignee?.user
        ? {
            id: t.assignee.id,
            firstName: t.assignee.user.firstName,
            lastName: t.assignee.user.lastName,
            image: t.assignee.user.image,
          }
        : null,
    }));
  }
}
