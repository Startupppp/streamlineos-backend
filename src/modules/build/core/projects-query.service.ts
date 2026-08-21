import { Inject, Injectable } from "@nestjs/common";
import {
  ProjectsForbiddenProjectException,
  ProjectsNotFoundException,
} from "../../../common/http/api-exceptions";
import { and, asc, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  projectMembers,
  projectStatuses,
  projectTeamAssignments,
  projectTeamMembers,
  projectTeams,
  projects,
  tickets,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { resolveProjectsScope } from "./projects-scope";
import type { ListProjectsInput } from "./dto/projects.schemas";

@Injectable()
export class ProjectsQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async listProjects(u: CurrentUserContext, input: ListProjectsInput) {
    const scope = await resolveProjectsScope(this.access, u);
    const orgId = u.orgId;
    const userId = u.userId;
    const key = `${userId}:${scope}:${input.status}:${input.search ?? ""}:${input.page}:${input.limit}:${input.pmWorkspaceId ?? ""}`;
    return this.cache.cachedVersioned(
      `projects:list:${orgId}`,
      key,
      () => this.queryProjects(orgId, userId, scope, input),
      CACHE_TTL.SHORT,
    );
  }

  private async queryProjects(
    orgId: string,
    userId: string,
    scope: DataScope,
    input: ListProjectsInput,
  ) {
    const { search, status, page, limit, pmWorkspaceId } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(projects.orgId, orgId), isNull(projects.deletedAt)];

    if (pmWorkspaceId) {
      conditions.push(eq(projects.pmWorkspaceId, pmWorkspaceId));
    }

    if (scope !== "all") {
      const [memberOf, teamProjectsOf] = await Promise.all([
        this.db
          .select({ projectId: projectMembers.projectId })
          .from(projectMembers)
          .where(eq(projectMembers.userId, userId)),
        this.db
          .select({ projectId: projectTeamAssignments.projectId })
          .from(projectTeamAssignments)
          .innerJoin(
            projectTeamMembers,
            eq(projectTeamMembers.teamId, projectTeamAssignments.teamId),
          )
          .where(
            and(
              eq(projectTeamAssignments.orgId, orgId),
              eq(projectTeamMembers.userId, userId),
            ),
          ),
      ]);
      const accessibleProjectIds = Array.from(
        new Set([
          ...memberOf.map((m) => m.projectId),
          ...teamProjectsOf.map((t) => t.projectId),
        ]),
      );
      const memberScopeCondition = or(
        eq(projects.managerId, userId),
        accessibleProjectIds.length > 0
          ? inArray(projects.id, accessibleProjectIds)
          : sql`false`,
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

    const whereClause = and(...conditions);

    const [{ total }] = await this.db
      .select({ total: count() })
      .from(projects)
      .where(whereClause);

    const projectRows = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        key: projects.key,
        status: projects.status,
        priority: projects.priority,
        startDate: projects.startDate,
        endDate: projects.endDate,
        managerId: projects.managerId,
        managerFirstName: users.firstName,
        managerLastName: users.lastName,
        managerImage: users.image,
      })
      .from(projects)
      .leftJoin(users, eq(projects.managerId, users.id))
      .where(whereClause)
      .orderBy(desc(projects.id))
      .limit(limit)
      .offset(offset);

    if (projectRows.length === 0) {
      return {
        data: [],
        total: Number(total),
        page,
        limit,
        totalPages: Math.ceil(Number(total) / limit),
      };
    }

    const projectIds = projectRows.map((p) => p.id);

    const [progressRows, memberRows, teamRows] = await Promise.all([
      this.db
        .select({
          projectId: tickets.projectId,
          total: count(),
          done: sql<number>`count(*) filter (where ${tickets.status} = 'DONE')`.as(
            "done",
          ),
        })
        .from(tickets)
        .where(and(inArray(tickets.projectId, projectIds), isNull(tickets.deletedAt)))
        .groupBy(tickets.projectId),
      this.db
        .select({
          projectId: projectMembers.projectId,
          userId: projectMembers.userId,
          firstName: users.firstName,
          lastName: users.lastName,
          image: users.image,
        })
        .from(projectMembers)
        .innerJoin(users, eq(projectMembers.userId, users.id))
        .where(inArray(projectMembers.projectId, projectIds)),
      this.db
        .select({
          projectId: projectMembers.projectId,
          teamName: projectTeams.name,
        })
        .from(projectMembers)
        .innerJoin(
          projectTeamMembers,
          eq(projectTeamMembers.userId, projectMembers.userId),
        )
        .innerJoin(projectTeams, eq(projectTeams.id, projectTeamMembers.teamId))
        .where(inArray(projectMembers.projectId, projectIds))
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

    const data = projectRows.map((p) => {
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

    return {
      data,
      total: Number(total),
      page,
      limit,
      totalPages: Math.ceil(Number(total) / limit),
    };
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
                  name: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                  image: true,
                },
              },
            },
          },
        },
      }),
    ]);

    if (!project) throw new ProjectsNotFoundException();

    const isOwnerOrAdmin = perms.has("build:manage");

    if (!isOwnerOrAdmin) {
      const isManager = project.managerId === u.userId;
      if (!isManager) {
        const memberOf = await this.db
          .select({ projectId: projectMembers.projectId })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.userId, u.userId),
              eq(projectMembers.projectId, projectId),
            ),
          );
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
                eq(projectTeamMembers.userId, u.userId),
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
