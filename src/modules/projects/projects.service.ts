import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ProjectsForbiddenProjectException,
  ProjectsNotFoundException,
} from "../../common/http/api-exceptions";
import { and, asc, count, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  projectMembers,
  projects,
  projectStatuses,
  sprints,
  ticketAssignees,
  ticketAttachments,
  ticketComments,
  ticketLabelMappings,
  tickets,
  timesheets,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { AuditService } from "../../common/audit/audit.service";
import { ProjectsProvisionService } from "./projects-provision.service";
import { AccessService } from "../access/access.service";
import type { DataScope } from "../access/access.types";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { resolveProjectsScope } from "./projects-scope";
import type {
  CreateProjectInput,
  FromDealInput,
  ListProjectsInput,
  UpdateProjectInput,
} from "./dto/projects.schemas";

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly provision: ProjectsProvisionService,
    private readonly access: AccessService,
  ) {}

  async listProjects(u: CurrentUserContext, input: ListProjectsInput) {
    const scope = await resolveProjectsScope(this.access, u);
    const orgId = u.orgId;
    const userId = u.userId;
    const key = `projects:list:${orgId}:${userId}:${scope}:${input.status}:${input.search ?? ""}:${input.page}:${input.limit}`;
    return this.cache.cached(
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
    const { search, status, page, limit } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(projects.orgId, orgId)];

    if (scope !== "all") {
      const memberOf = await this.db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(eq(projectMembers.userId, userId));
      const memberProjectIds = memberOf.map((m) => m.projectId);
      const memberScopeCondition = or(
        eq(projects.managerId, userId),
        memberProjectIds.length > 0 ? inArray(projects.id, memberProjectIds) : sql`false`,
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

    const [{ total }] = await this.db.select({ total: count() }).from(projects).where(whereClause);

    const projectRows = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        key: projects.key,
        status: projects.status,
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

    const [progressRows, memberRows] = await Promise.all([
      this.db
        .select({
          projectId: tickets.projectId,
          total: count(),
          done: sql<number>`count(*) filter (where ${tickets.status} = 'DONE')`.as("done"),
        })
        .from(tickets)
        .where(inArray(tickets.projectId, projectIds))
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
    ]);

    const progressMap = new Map(progressRows.map((r) => [r.projectId, { total: r.total, done: r.done }]));
    const membersMap = new Map<
      number,
      { id: string; firstName: string | null; lastName: string | null; image: string | null }[]
    >();
    for (const m of memberRows) {
      if (!membersMap.has(m.projectId)) membersMap.set(m.projectId, []);
      const arr = membersMap.get(m.projectId);
      if (arr && arr.length < 5) {
        arr.push({ id: m.userId, firstName: m.firstName, lastName: m.lastName, image: m.image });
      }
    }

    const data = projectRows.map((p) => {
      const progress = progressMap.get(p.id) ?? { total: 0, done: 0 };
      const pct =
        Number(progress.total) > 0 ? Math.round((Number(progress.done) / Number(progress.total)) * 100) : 0;
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        key: p.key,
        status: p.status,
        startDate: p.startDate,
        endDate: p.endDate,
        manager: p.managerId
          ? { id: p.managerId, firstName: p.managerFirstName, lastName: p.managerLastName, image: p.managerImage }
          : null,
        progress: { total: Number(progress.total), done: Number(progress.done), percentage: pct },
        members: membersMap.get(p.id) ?? [],
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

  async createProject(orgId: string, creatorUserId: string, input: CreateProjectInput) {
    return this.provision.createProject(orgId, creatorUserId, input);
  }

  async createFromDeal(orgId: string, userId: string, input: FromDealInput) {
    return this.provision.createFromDeal(orgId, userId, input);
  }

  async getProject(u: CurrentUserContext, projectId: number) {
    const orgId = u.orgId;

    const [perms, project] = await Promise.all([
      this.access.resolveUserPermissions(u.orgId, u.userId),
      this.db.query.projects.findFirst({
        where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
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

    const isOwnerOrAdmin = perms.has("projects:manage");

    if (!isOwnerOrAdmin) {
      const isManager = project.managerId === u.userId;
      if (!isManager) {
        const memberOf = await this.db
          .select({ projectId: projectMembers.projectId })
          .from(projectMembers)
          .where(and(eq(projectMembers.userId, u.userId), eq(projectMembers.projectId, projectId)));
        if (memberOf.length === 0) {
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

    return project;
  }

  async updateProject(u: CurrentUserContext, projectId: number, body: UpdateProjectInput) {
    const orgId = u.orgId;

    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      const hasManage = perms.has("projects:manage");

      if (!hasManage) {
        const project = await this.db.query.projects.findFirst({
          where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
          columns: { managerId: true },
        });
        if (!project || project.managerId !== u.userId) {
          throw new ForbiddenException("Only project managers or admins can update project settings.");
        }
      }
    }

    await this.db
      .update(projects)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.status !== undefined && { status: body.status }),
        ...(body.managerId !== undefined && { managerId: body.managerId }),
        ...(body.clientId !== undefined && { clientId: body.clientId }),
        ...(body.startDate !== undefined && { startDate: body.startDate ? new Date(body.startDate) : null }),
        ...(body.endDate !== undefined && { endDate: body.endDate ? new Date(body.endDate) : null }),
      })
      .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)));

    if (body.memberIds !== undefined) {
      const memberIds = body.memberIds;
      const reassignments = body.reassignments;
      await this.db.transaction(async (tx) => {
        const existingMembers = await tx
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(eq(projectMembers.projectId, projectId));
        const existing = new Set(existingMembers.map((m) => m.userId));

        await tx.delete(projectMembers).where(eq(projectMembers.projectId, projectId));

        if (memberIds.length > 0) {
          await tx.insert(projectMembers).values(
            memberIds.map((userId) => ({ projectId, userId, role: "CONTRIBUTOR" })),
          );
        }

        const newMemberSet = new Set(memberIds);
        const removedMembers = [...existing].filter((id) => !newMemberSet.has(id));

        if (removedMembers.length > 0 && reassignments) {
          const openTickets = await tx
            .select({ id: tickets.id, assigneeId: tickets.assigneeId })
            .from(tickets)
            .where(
              and(
                eq(tickets.orgId, orgId),
                eq(tickets.projectId, projectId),
                inArray(tickets.assigneeId, removedMembers),
                ne(tickets.status, "DONE"),
                ne(tickets.status, "CANCELLED"),
              ),
            );
          const byNewAssignee = new Map<string | null, number[]>();
          for (const ticket of openTickets) {
            const newAssignee = ticket.assigneeId ? (reassignments[ticket.assigneeId] ?? null) : null;
            const ids = byNewAssignee.get(newAssignee) ?? [];
            ids.push(ticket.id);
            byNewAssignee.set(newAssignee, ids);
          }
          for (const [newAssignee, ids] of byNewAssignee) {
            await tx.update(tickets).set({ assigneeId: newAssignee }).where(and(eq(tickets.orgId, orgId), inArray(tickets.id, ids)));
          }
        } else if (removedMembers.length > 0) {
          await tx
            .update(tickets)
            .set({ assigneeId: null })
            .where(
              and(
                eq(tickets.orgId, orgId),
                eq(tickets.projectId, projectId),
                inArray(tickets.assigneeId, removedMembers),
                ne(tickets.status, "DONE"),
                ne(tickets.status, "CANCELLED"),
              ),
            );
        }
      });
    }

    this.audit.log({
      action: "project.updated",
      userId: u.userId,
      orgId,
      targetId: String(projectId),
      targetType: "project",
      metadata: { changedFields: Object.keys(body) },
    });

    return { success: true };
  }

  async deleteProject(u: CurrentUserContext, projectId: number) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
      if (!perms.has("projects:delete")) {
        throw new ForbiddenException("Only organization owners can delete projects");
      }
    }
    const orgId = u.orgId;

    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
    });
    if (!project) throw new NotFoundException("Project not found");

    await this.db.transaction(async (tx) => {
      const subTickets = tx.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)));
      await tx.delete(ticketAssignees).where(sql`${ticketAssignees.ticketId} IN (${subTickets})`);
      await tx.delete(ticketComments).where(sql`${ticketComments.ticketId} IN (${subTickets})`);
      await tx.delete(ticketAttachments).where(sql`${ticketAttachments.ticketId} IN (${subTickets})`);
      await tx.delete(ticketLabelMappings).where(sql`${ticketLabelMappings.ticketId} IN (${subTickets})`);
      await tx.delete(timesheets).where(sql`${timesheets.ticketId} IN (${subTickets})`);
      await tx.delete(tickets).where(and(eq(tickets.projectId, projectId), eq(tickets.orgId, orgId)));
      await tx.delete(sprints).where(and(eq(sprints.projectId, projectId), eq(sprints.orgId, orgId)));
      await tx.delete(projectMembers).where(eq(projectMembers.projectId, projectId));
      await tx.delete(projectStatuses).where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.orgId, orgId)));
      await tx.delete(projects).where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)));
    });

    this.audit.log({
      action: "project.deleted",
      userId: u.userId,
      orgId,
      targetId: String(projectId),
      targetType: "project",
      metadata: { name: project.name },
    });

    return { success: true };
  }
}
