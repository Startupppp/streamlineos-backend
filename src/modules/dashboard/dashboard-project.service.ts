import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { projectMembers, projects, sprints, tickets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { type DashboardActor } from "./dashboard.errors";

@Injectable()
export class DashboardProjectService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async resolveProjectIds(
    orgId: string,
    userId: string,
    isOwnerOrAdmin: boolean,
  ): Promise<number[]> {
    if (isOwnerOrAdmin) {
      const allProjects = await this.db.query.projects.findMany({
        where: eq(projects.orgId, orgId),
        columns: { id: true },
      });
      return allProjects.map((p) => p.id);
    }
    const memberOf = await this.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, userId));
    return memberOf.map((m) => m.projectId);
  }

  async getRecentProjects(orgId: string, actor: DashboardActor) {
    const isOwnerOrAdmin = actor.isPlatformAdmin || actor.isOrgOwner || actor.permissions.includes("hr:employees:manage");

    if (isOwnerOrAdmin) {
      return this.db.query.projects.findMany({
        where: eq(projects.orgId, orgId),
        orderBy: [desc(projects.id)],
        limit: 5,
        with: {
          manager: {
            columns: { id: true, name: true, firstName: true, lastName: true, image: true },
          },
        },
      });
    }

    const memberOf = await this.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, actor.userId));

    const projectIds = memberOf.map((m) => m.projectId);

    return this.db.query.projects.findMany({
      where: and(
        eq(projects.orgId, orgId),
        or(
          eq(projects.managerId, actor.userId),
          projectIds.length > 0 ? inArray(projects.id, projectIds) : undefined,
        ),
      ),
      orderBy: [desc(projects.id)],
      limit: 5,
      with: {
        manager: {
          columns: { id: true, name: true, firstName: true, lastName: true, image: true },
        },
      },
    });
  }

  async getMyIssues(orgId: string, userId: string) {
    const issues = await this.db.query.tickets.findMany({
      where: and(eq(tickets.orgId, orgId), eq(tickets.assigneeId, userId)),
      orderBy: [desc(tickets.updatedAt)],
      limit: 10,
      with: {
        project: { columns: { id: true, name: true, key: true } },
        assignee: { columns: { id: true, firstName: true, lastName: true, image: true } },
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
      assignee: t.assignee
        ? {
            id: t.assignee.id,
            firstName: t.assignee.firstName,
            lastName: t.assignee.lastName,
            image: t.assignee.image,
          }
        : null,
    }));
  }

  async getActiveSprintSummary(orgId: string, actor: DashboardActor) {
    const isOwnerOrAdmin = actor.isPlatformAdmin || actor.isOrgOwner || actor.permissions.includes("hr:employees:manage");

    const projectIds = await this.resolveProjectIds(orgId, actor.userId, isOwnerOrAdmin);
    if (projectIds.length === 0) return null;

    const activeSprint = await this.db.query.sprints.findFirst({
      where: and(
        eq(sprints.orgId, orgId),
        eq(sprints.status, "ACTIVE"),
        inArray(sprints.projectId, projectIds),
      ),
      with: {
        project: { columns: { id: true, name: true } },
        tickets: { columns: { id: true, status: true, points: true } },
      },
    });

    if (!activeSprint) return null;

    const sprintTickets = activeSprint.tickets || [];
    const totalTickets = sprintTickets.length;
    const doneTickets = sprintTickets.filter((t) => t.status === "DONE").length;
    const inProgressTickets = sprintTickets.filter(
      (t) => t.status === "IN_PROGRESS" || t.status === "IN_REVIEW",
    ).length;
    const todoTickets = totalTickets - doneTickets - inProgressTickets;
    const totalPoints = sprintTickets.reduce((acc, t) => acc + (t.points || 0), 0);
    const completedPoints = sprintTickets
      .filter((t) => t.status === "DONE")
      .reduce((acc, t) => acc + (t.points || 0), 0);
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

  async getRecentActivity(orgId: string, actor: DashboardActor) {
    const isOwnerOrAdmin = actor.isPlatformAdmin || actor.isOrgOwner || actor.permissions.includes("hr:employees:manage");

    const projectIds = await this.resolveProjectIds(orgId, actor.userId, isOwnerOrAdmin);
    if (projectIds.length === 0) return [];

    const ticketFilters: SQL[] = [
      eq(tickets.orgId, orgId),
      inArray(tickets.projectId, projectIds),
    ];

    if (!isOwnerOrAdmin) {
      const ownerFilter = or(
        eq(tickets.assigneeId, actor.userId),
        eq(tickets.reporterId, actor.userId),
      );
      if (ownerFilter) ticketFilters.push(ownerFilter);
    }

    const recentTickets = await this.db.query.tickets.findMany({
      where: and(...ticketFilters),
      orderBy: [desc(tickets.updatedAt)],
      limit: 10,
      with: {
        project: { columns: { id: true, name: true, key: true } },
        assignee: { columns: { id: true, firstName: true, lastName: true, image: true } },
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
      assignee: t.assignee
        ? {
            id: t.assignee.id,
            firstName: t.assignee.firstName,
            lastName: t.assignee.lastName,
            image: t.assignee.image,
          }
        : null,
    }));
  }
}
