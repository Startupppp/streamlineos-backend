import { Inject, Injectable } from "@nestjs/common";
import {
  ProjectsForbiddenProjectException,
  ProjectsNotFoundException,
} from "../../../common/http/api-exceptions";
import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  projectMembers,
  projectStatuses,
  projectTeamAssignments,
  projectTeamMembers,
  projectTeams,
  projects,
  tickets,
  users,
  organizationMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { resolveProjectsScope } from "./projects-scope";
import { resolveTicketsScope, ticketScopePredicate } from "./tickets-scope";
import type { ListProjectsInput } from "./dto/projects.schemas";

@Injectable()
export class ProjectsQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async listProjects(u: CurrentUserContext, input: ListProjectsInput) {
    const scope = await resolveProjectsScope(this.access, u);
    if (scope === "none") return { data: [], hasMore: false, nextCursor: null };
    const ticketScope = await resolveTicketsScope(this.access, u);
    const orgId = u.orgId;
    const userId = u.userId;
    const membershipId = actingMembershipId(u.principal);
    return this.queryProjects(orgId, userId, membershipId, scope, ticketScope, input);
  }

  private async queryProjects(
    orgId: string,
    userId: string,
    membershipId: number | null,
    scope: DataScope,
    ticketScope: DataScope,
    input: ListProjectsInput,
  ) {
    const { search, status, afterId, limit, pmWorkspaceId } = input;

    const conditions = [eq(projects.orgId, orgId), isNull(projects.deletedAt)];

    if (pmWorkspaceId) {
      conditions.push(eq(projects.pmWorkspaceId, pmWorkspaceId));
    }

    if (scope !== "all") {
      const memberOf = this.db
          .select({ projectId: projectMembers.projectId })
          .from(projectMembers)
          .where(and(eq(projectMembers.orgId, orgId), eq(projectMembers.membershipId, membershipId ?? -1)));
      const teamProjectsOf = this.db
          .select({ projectId: projectTeamAssignments.projectId })
          .from(projectTeamAssignments)
          .innerJoin(
            projectTeamMembers,
            and(eq(projectTeamMembers.orgId, projectTeamAssignments.orgId), eq(projectTeamMembers.teamId, projectTeamAssignments.teamId)),
          )
          .where(
            and(
              eq(projectTeamAssignments.orgId, orgId),
              eq(projectTeamMembers.membershipId, membershipId ?? -1),
            ),
          );
      const memberScopeCondition = or(
        membershipId !== null ? eq(projects.managerMembershipId, membershipId) : undefined,
        inArray(projects.id, memberOf),
        inArray(projects.id, teamProjectsOf),
      );
      if (memberScopeCondition) conditions.push(memberScopeCondition);
    }

    if (search?.trim()) {
      const match = or(
        sql`${projects.name} ILIKE ${"%" + search + "%"}`,
        sql`${projects.key} ILIKE ${"%" + search + "%"}`,
      );
      if (match) conditions.push(match);
    }

    if (status !== "ALL") {
      conditions.push(eq(projects.status, status));
    }

    if (afterId !== undefined) {
      conditions.push(lt(projects.id, afterId));
    }

    const whereClause = and(...conditions);

    const projectCols = {
      id: projects.id,
      name: projects.name,
      description: projects.description,
      key: projects.key,
      status: projects.status,
      priority: projects.priority,
      startDate: projects.startDate,
      endDate: projects.endDate,
      managerId: organizationMembers.userId,
      managerFirstName: users.firstName,
      managerLastName: users.lastName,
      managerImage: users.image,
    };
    const projectRows = await this.db
      .select(projectCols)
      .from(projects)
      .leftJoin(organizationMembers, and(eq(organizationMembers.orgId, projects.orgId), eq(organizationMembers.id, projects.managerMembershipId)))
      .leftJoin(users, eq(organizationMembers.userId, users.id))
      .where(whereClause)
      .orderBy(desc(projects.id))
      .limit(limit + 1);

    const hasMore = projectRows.length > limit;
    const trimmedRows = hasMore ? projectRows.slice(0, limit) : projectRows;

    if (trimmedRows.length === 0) {
      return { data: [], hasMore: false, nextCursor: null };
    }

    const projectIds = trimmedRows.map((p) => p.id);
    const memberPreview = this.db.select({
      membershipId: projectMembers.membershipId,
      userId: organizationMembers.userId,
      firstName: users.firstName,
      lastName: users.lastName,
      image: users.image,
    }).from(projectMembers)
      .innerJoin(organizationMembers, and(eq(organizationMembers.orgId, projectMembers.orgId), eq(organizationMembers.id, projectMembers.membershipId)))
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(projectMembers.orgId, orgId), eq(projectMembers.projectId, projects.id)))
      .orderBy(asc(projectMembers.membershipId)).limit(5).as("member_preview");

    const [progressRows, memberRows, teamRows] = await Promise.all([
      this.db
        .select({
          projectId: tickets.projectId,
          total: count(),
          done: sql<number>`count(*) filter (where ${projectStatuses.type} = 'completed')`.as(
            "done",
          ),
        })
        .from(tickets)
        .leftJoin(projectStatuses, and(eq(projectStatuses.orgId, tickets.orgId), eq(projectStatuses.projectId, tickets.projectId), eq(projectStatuses.name, tickets.status)))
        .where(and(eq(tickets.orgId, orgId), inArray(tickets.projectId, projectIds), isNull(tickets.deletedAt), ticketScopePredicate(ticketScope, orgId, userId)))
        .groupBy(tickets.projectId),
      this.db
        .select({
          projectId: projects.id,
          userId: memberPreview.userId,
          firstName: memberPreview.firstName,
          lastName: memberPreview.lastName,
          image: memberPreview.image,
        })
        .from(projects)
        .innerJoinLateral(memberPreview, sql`true`)
        .where(and(eq(projects.orgId, orgId), inArray(projects.id, projectIds)))
        .orderBy(asc(projects.id), asc(memberPreview.membershipId)),
      this.db
        .select({
          projectId: projectMembers.projectId,
          teamName: projectTeams.name,
        })
        .from(projectMembers)
        .innerJoin(
          projectTeamMembers,
          and(eq(projectTeamMembers.orgId, projectMembers.orgId), eq(projectTeamMembers.membershipId, projectMembers.membershipId)),
        )
        .innerJoin(projectTeams, and(eq(projectTeams.orgId, projectTeamMembers.orgId), eq(projectTeams.id, projectTeamMembers.teamId)))
        .where(and(eq(projectMembers.orgId, orgId), inArray(projectMembers.projectId, projectIds)))
        .groupBy(projectMembers.projectId, projectTeams.name),
    ]);

    const progressMap = new Map(
      progressRows.map((r) => [r.projectId, { total: r.total, done: r.done }]),
    );
    const membersMap = new Map<
      number,
      {
          id: string;
        firstName: string | null;
        lastName: string | null;
        image: string | null;
      }[]
    >();
    for (const m of memberRows) {
      if (!membersMap.has(m.projectId)) membersMap.set(m.projectId, []);
      const arr = membersMap.get(m.projectId);
      if (arr && arr.length < 5) {
        arr.push({
          id: m.userId,
          firstName: m.firstName,
          lastName: m.lastName,
          image: m.image,
        });
      }
    }

    const teamsMap = new Map<number, string[]>();
    for (const t of teamRows) {
      if (!teamsMap.has(t.projectId)) teamsMap.set(t.projectId, []);
      const existing = teamsMap.get(t.projectId) ?? [];
      if (!existing.includes(t.teamName)) existing.push(t.teamName);
    }

    const now = new Date();

    const data = trimmedRows.map((p) => {
      const progress = progressMap.get(p.id) ?? { total: 0, done: 0 };
      const pct =
        Number(progress.total) > 0
          ? Math.round((Number(progress.done) / Number(progress.total)) * 100)
          : 0;
      const isOverdue = p.endDate ? p.endDate < now : false;
      const terminal = p.status === "COMPLETED" || p.status === "ARCHIVED";
      const health: "on_track" | "at_risk" | "off_track" = terminal
        ? "on_track"
        : isOverdue
          ? "off_track"
          : pct >= 70
            ? "on_track"
            : pct >= 30
              ? "at_risk"
              : "off_track";
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        key: p.key,
        status: p.status,
        priority: p.priority as "LOW" | "MEDIUM" | "HIGH" | "URGENT" | null,
        startDate: p.startDate,
        endDate: p.endDate,
        manager: p.managerId
          ? {
              id: p.managerId,
              firstName: p.managerFirstName,
              lastName: p.managerLastName,
              image: p.managerImage,
            }
          : null,
        progress: {
          total: Number(progress.total),
          done: Number(progress.done),
          percentage: pct,
        },
        health,
        members: membersMap.get(p.id) ?? [],
        teams: teamsMap.get(p.id) ?? [],
      };
    });

    const last = data[data.length - 1];
    return { data, hasMore, nextCursor: hasMore && last ? last.id : null };
  }

  async getProject(u: CurrentUserContext, projectId: number) {
    const orgId = u.orgId;

    const [perms, project] = await Promise.all([
      this.access.resolveUserPermissions(u.orgId, u.userId),
      this.db.query.projects.findFirst({
        where: and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)),
        with: {
          statuses: { orderBy: [asc(projectStatuses.order)] },
          members: {
            with: {
              user: {
                columns: {
                  id: true,
                },
                with: { user: { columns: { id: true, name: true, firstName: true, lastName: true, email: true, image: true } } },
              },
            },
          },
        },
      }),
    ]);

    if (!project) throw new ProjectsNotFoundException();

    const isOwnerOrAdmin = perms.has("build:manage");

    if (!isOwnerOrAdmin) {
      const callerMid = actingMembershipId(u.principal);
      const isManager =
        callerMid !== null && project.managerMembershipId === callerMid;
      if (!isManager) {
        const memberOf = await this.db
          .select({ projectId: projectMembers.projectId })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.orgId, u.orgId),
              eq(projectMembers.membershipId, callerMid ?? -1),
              eq(projectMembers.projectId, projectId),
            ),
          )
          .limit(1);
        if (memberOf.length === 0) {
          const teamAccess = await this.db
            .select({ id: projectTeamMembers.id })
            .from(projectTeamAssignments)
            .innerJoin(
              projectTeamMembers,
              eq(projectTeamMembers.teamId, projectTeamAssignments.teamId),
            )
            .where(
              and(
                eq(projectTeamAssignments.projectId, projectId),
                eq(projectTeamAssignments.orgId, orgId),
                eq(projectTeamMembers.membershipId, callerMid ?? -1),
              ),
            )
            .limit(1);
          if (teamAccess.length === 0) {
            this.audit.log({
              action: "project.access_denied",
              userId: u.userId,
              orgId,
              targetId: String(projectId),
              targetType: "project",
              metadata: { reason: "NOT_A_MEMBER", projectId },
              result: "FAILURE",
            });
            throw new ProjectsForbiddenProjectException(projectId);
          }
        }
      }
    }

    return project;
  }
}
