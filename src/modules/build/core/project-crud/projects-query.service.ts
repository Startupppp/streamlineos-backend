import { Inject, Injectable } from "@nestjs/common";
import {
  ProjectsForbiddenProjectException,
  ProjectsNotFoundException,
} from "../../../../common/http/api-exceptions";
import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
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
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { AccessService } from "../../../access/access.service";
import type { ScopedRead } from "../../../access/scoped-read";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../../common/auth/principal";
import { resolveProjectsScope } from "./projects-scope";
import { resolveTicketsScope, ticketScope } from "../lib/tickets-scope";
import type { ListProjectsInput } from "../dto/projects.schemas";
import { PAGE_SIZE_CAP } from "../../../../common/pagination/list-query.schema";
import { encodeCursor, decodeIntegerCursor } from "../../../../common/pagination/cursor";
import type { ProjectHealth } from "../dto/project-core.schemas";

export function computeHealth(
  status: string,
  endDate: Date | string | null | undefined,
  donePct: number,
  now: Date,
): ProjectHealth {
  const terminal = status === "COMPLETED" || status === "ARCHIVED";
  if (terminal) return "on_track";
  const endDateValue = endDate instanceof Date ? endDate : (endDate ? new Date(endDate) : null);
  const isOverdue = endDateValue !== null && endDateValue < now;
  if (isOverdue) return "off_track";
  if (donePct >= 70) return "on_track";
  if (donePct >= 30) return "at_risk";
  return "off_track";
}

@Injectable()
export class ProjectsQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async listProjects(u: CurrentUserContext, input: ListProjectsInput) {
    const read = await resolveProjectsScope(this.access, u);
    if (read.denied) return { data: [], hasMore: false, nextCursor: null, nextSortCursor: null };
    const membershipId = actingMembershipId(u.principal);
    const ticketRead = await resolveTicketsScope(this.access, u);
    const orgId = u.orgId;
    const userId = u.userId;
    return this.queryProjects(orgId, userId, membershipId, read, ticketRead, input);
  }

  private async queryProjects(
    orgId: string,
    userId: string,
    membershipId: number | null,
    read: ScopedRead,
    ticketRead: ScopedRead,
    input: ListProjectsInput,
  ) {
    const { search, status, afterId, afterSortValue, limit, managedProductId, managerId, health, sort } =
      input;

    const domain: (SQL | undefined)[] = [isNull(projects.deletedAt)];

    if (managedProductId !== undefined) {
      domain.push(eq(projects.managedProductId, managedProductId));
    }

    if (managerId !== undefined) {
      domain.push(eq(organizationMembers.userId, managerId));
    }

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
    const ownProjects = sql`${or(
      membershipId !== null ? eq(projects.managerMembershipId, membershipId) : sql`false`,
      inArray(projects.id, memberOf),
      inArray(projects.id, teamProjectsOf),
    )}`;

    if (search?.trim()) {
      const match = or(
        sql`${projects.name} ILIKE ${"%" + search + "%"}`,
        sql`${projects.key} ILIKE ${"%" + search + "%"}`,
      );
      if (match) domain.push(match);
    }

    if (status !== "ALL") {
      domain.push(eq(projects.status, status));
    }

    if (sort) {
      const cursorPos = afterSortValue ? decodeIntegerCursor(afterSortValue) : null;
      if (sort === "name_asc") {
        if (cursorPos) {
          domain.push(sql`(${projects.name}, ${projects.id}) > (${cursorPos.sortValue}, ${cursorPos.id})`);
        }
      } else if (sort === "priority_desc") {
        if (cursorPos) {
          domain.push(sql`(${projects.priority}, ${projects.id}) < (${cursorPos.sortValue}, ${cursorPos.id})`);
        }
      } else if (sort === "due_asc") {
        if (cursorPos) {
          domain.push(sql`(${projects.endDate}, ${projects.id}) > (${cursorPos.sortValue}::date, ${cursorPos.id})`);
        }
      } else if (sort === "due_desc") {
        if (cursorPos) {
          domain.push(sql`(${projects.endDate}, ${projects.id}) < (${cursorPos.sortValue}::date, ${cursorPos.id})`);
        }
      }
    } else {
      if (afterId !== undefined) {
        domain.push(lt(projects.id, afterId));
      }
    }

    const whereClause = read.compose(
      { tenant: projects.orgId, scope: { own: ownProjects }, and: domain },
      ({ sql: where }) => where,
      () => sql`false`,
    );

    const projectCols = {
      id: projects.id,
      name: projects.name,
      description: projects.description,
      key: projects.key,
      status: projects.status,
      priority: projects.priority,
      startDate: projects.startDate,
      endDate: projects.endDate,
      managedProductId: projects.managedProductId,
      managerId: organizationMembers.userId,
      managerFirstName: users.firstName,
      managerLastName: users.lastName,
      managerImage: users.image,
    };

    let orderBy;
    if (sort === "name_asc") {
      orderBy = [asc(projects.name), asc(projects.id)];
    } else if (sort === "priority_desc") {
      orderBy = [desc(projects.priority), desc(projects.id)];
    } else if (sort === "due_asc") {
      orderBy = [asc(projects.endDate), asc(projects.id)];
    } else if (sort === "due_desc") {
      orderBy = [desc(projects.endDate), desc(projects.id)];
    } else {
      orderBy = [desc(projects.id)];
    }

    const fetchLimit = health !== undefined ? PAGE_SIZE_CAP : limit + 1;
    const projectRows = await this.db
      .select(projectCols)
      .from(projects)
      .leftJoin(organizationMembers, and(eq(organizationMembers.orgId, projects.orgId), eq(organizationMembers.id, projects.managerMembershipId)))
      .leftJoin(users, eq(organizationMembers.userId, users.id))
      .where(whereClause)
      .orderBy(...orderBy)
      .limit(fetchLimit);

    if (projectRows.length === 0) {
      return { data: [], hasMore: false, nextCursor: null, nextSortCursor: null };
    }

    const projectIds = projectRows.map((p) => p.id);
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

    const ticketProgressWhere = ticketRead.compose(
      {
        tenant: tickets.orgId,
        scope: ticketScope(ticketRead.orgId, ticketRead.actorId),
        and: [inArray(tickets.projectId, projectIds), isNull(tickets.deletedAt)],
      },
      ({ sql: where }) => where,
      () => sql`false`,
    );
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
        .where(ticketProgressWhere)
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
        .innerJoin(projectTeams, and(eq(projectTeams.orgId, projectTeamMembers.orgId), eq(projectTeams.id, projectTeamMembers.teamId), isNull(projectTeams.deletedAt)))
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

    const allMapped = projectRows.map((p) => {
      const progress = progressMap.get(p.id) ?? { total: 0, done: 0 };
      const pct =
        Number(progress.total) > 0
          ? Math.round((Number(progress.done) / Number(progress.total)) * 100)
          : 0;
      const rowHealth = computeHealth(p.status, p.endDate, pct, now);
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        key: p.key,
        status: p.status,
        priority: p.priority,
        startDate: p.startDate,
        endDate: p.endDate,
        managedProductId: p.managedProductId,
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
        health: rowHealth,
        members: membersMap.get(p.id) ?? [],
        teams: teamsMap.get(p.id) ?? [],
      };
    });

    let data: typeof allMapped;
    let hasMore: boolean;

    if (health !== undefined) {
      const filtered = allMapped.filter((row) => row.health === health);
      hasMore = filtered.length > limit;
      data = hasMore ? filtered.slice(0, limit) : filtered;
    } else {
      hasMore = allMapped.length > limit;
      data = hasMore ? allMapped.slice(0, limit) : allMapped;
    }

    if (data.length === 0) {
      return { data: [], hasMore: false, nextCursor: null, nextSortCursor: null };
    }

    const last = data[data.length - 1];

    let nextSortCursor: string | null = null;
    if (sort && hasMore && last) {
      let sortValue: string;
      if (sort === "name_asc") {
        sortValue = last.name;
      } else if (sort === "priority_desc") {
        sortValue = last.priority ?? "";
      } else if (sort === "due_asc" || sort === "due_desc") {
        const endDateVal = last.endDate;
        sortValue = endDateVal instanceof Date
          ? endDateVal.toISOString().slice(0, 10)
          : (endDateVal ? String(endDateVal).slice(0, 10) : "");
      } else {
        sortValue = String(last.id);
      }
      nextSortCursor = encodeCursor({ sortValue, id: String(last.id) });
    }

    return { data, hasMore, nextCursor: hasMore && last ? last.id : null, nextSortCursor };
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
              and(eq(projectTeamMembers.orgId, projectTeamAssignments.orgId), eq(projectTeamMembers.teamId, projectTeamAssignments.teamId)),
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
