import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { cycles, organizationMembers, projectMembers, projects, tickets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import { resolveBuildDashboardScope } from "./dashboard-scope";
import { DASHBOARD_PROJECT_ID_CAP } from "./dashboard-read-limits";

const PROJECT_MEMBERSHIP_QUERY_SHAPE_REASON =
  "all vs own/team picks an entirely different project-membership query shape, not a row predicate";

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
    const read = await resolveBuildDashboardScope(this.access, u);
    if (read.denied) return [];
    const isAll = read.rawScope(PROJECT_MEMBERSHIP_QUERY_SHAPE_REASON) === "all";

    if (isAll) {
      return this.db.query.projects.findMany({
        where: and(eq(projects.orgId, orgId), isNull(projects.deletedAt)),
        orderBy: [desc(projects.id)],
        limit: 5,
        with: {
          manager: { with: { user: { columns: { id: true, name: true, firstName: true, lastName: true, image: true } } } },
        },
      });
    }

    const [managerMember, memberOf] = await Promise.all([
      this.db.query.organizationMembers.findFirst({ where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, u.userId)), columns: { id: true } }),
      this.db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, projectMembers.orgId), eq(organizationMembers.id, projectMembers.membershipId)))
        .where(and(eq(projectMembers.orgId, orgId), eq(organizationMembers.userId, u.userId))),
    ]);

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

  async getMyIssues(orgId: string, userId: string, statuses?: string[], resolvedMembershipId?: number | null) {
    const membershipId =
      resolvedMembershipId === undefined
        ? (await this.db.query.organizationMembers.findFirst({ where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)), columns: { id: true } }))?.id ?? null
        : resolvedMembershipId;
    if (membershipId === null) return [];
    const statusFilter = statuses && statuses.length > 0 ? inArray(tickets.status, statuses) : undefined;
    const issues = await this.db.query.tickets.findMany({
      where: and(eq(tickets.orgId, orgId), eq(tickets.assigneeMembershipId, membershipId), isNull(tickets.deletedAt), statusFilter),
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
    const read = await resolveBuildDashboardScope(this.access, u);
    if (read.denied) return null;
    const isAll = read.rawScope(PROJECT_MEMBERSHIP_QUERY_SHAPE_REASON) === "all";
    const projectIds = await this.resolveProjectIds(orgId, u.userId, isAll);
    if (projectIds.length === 0) return null;

    const [activeCycle] = await this.db
      .select({
        id: cycles.id,
        name: cycles.name,
        endDate: cycles.endDate,
        projectId: cycles.projectId,
        projectName: projects.name,
      })
      .from(cycles)
      .innerJoin(projects, and(eq(projects.id, cycles.projectId), eq(projects.orgId, orgId)))
      .where(and(
        eq(cycles.orgId, orgId),
        eq(cycles.status, "active"),
        inArray(cycles.projectId, projectIds),
      ))
      .limit(1);

    if (!activeCycle) return null;

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
          eq(tickets.cycleId, activeCycle.id),
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
    const endDate = activeCycle.endDate ? new Date(activeCycle.endDate) : now;
    const daysRemaining = Math.ceil(
      (endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );

    return {
      id: activeCycle.id,
      name: activeCycle.name,
      projectName: activeCycle.projectName || "Project",
      projectId: activeCycle.projectId,
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
    const read = await resolveBuildDashboardScope(this.access, u);
    if (read.denied) return [];
    const isAll = read.rawScope(PROJECT_MEMBERSHIP_QUERY_SHAPE_REASON) === "all";
    const [projectIds, managerMember] = await Promise.all([
      this.resolveProjectIds(orgId, u.userId, isAll),
      this.db.query.organizationMembers.findFirst({ where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, u.userId)), columns: { id: true } }),
    ]);
    if (projectIds.length === 0) return [];

    const ticketFilters: SQL[] = [
      eq(tickets.orgId, orgId),
      inArray(tickets.projectId, projectIds),
      isNull(tickets.deletedAt),
    ];

    if (!isAll) {
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
