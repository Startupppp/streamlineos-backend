import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  deals,
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
import { ProjectsEmailService } from "./projects-email.service";
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

const DEFAULT_STATUSES = [
  { name: "TODO", order: 0, color: "#e2e8f0" },
  { name: "IN_PROGRESS", order: 1, color: "#3b82f6" },
  { name: "IN_REVIEW", order: 2, color: "#eab308" },
  { name: "DONE", order: 3, color: "#22c55e" },
];

function generateProjectKey(name: string): string {
  const namePart = name.replace(/[^a-zA-Z]/g, "").substring(0, 3).toUpperCase();
  const randomPart = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return (namePart.length >= 2 ? namePart : "PRJ") + "-" + randomPart;
}

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly projectsEmail: ProjectsEmailService,
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
    const projectKey = input.key ?? generateProjectKey(input.name);

    const [project] = await this.db
      .insert(projects)
      .values({
        orgId,
        key: projectKey,
        name: input.name,
        description: input.description,
        managerId: input.managerId,
        clientId: input.clientId,
        startDate: input.startDate ? new Date(input.startDate) : undefined,
        endDate: input.endDate ? new Date(input.endDate) : undefined,
        status: "ACTIVE",
        settings: {
          modules: input.modules ?? { sprints: true, epics: true, timeTracking: true, wiki: true },
        },
      })
      .returning();

    await this.db.insert(projectStatuses).values(
      DEFAULT_STATUSES.map((s) => ({
        orgId,
        projectId: project.id,
        name: s.name,
        order: s.order,
        color: s.color,
      })),
    );

    if (input.memberIds && input.memberIds.length > 0) {
      await this.db.insert(projectMembers).values(
        input.memberIds.map((userId) => ({ projectId: project.id, userId, role: "CONTRIBUTOR" })),
      );

      void this.projectsEmail
        .notifyProjectMembers(creatorUserId, input.memberIds, input.name, projectKey, project.id)
        .catch(() => undefined);
    }

    this.audit.log({
      action: "project.created",
      userId: creatorUserId,
      orgId,
      targetId: String(project.id),
      targetType: "project",
      metadata: { name: input.name, key: projectKey, managerId: input.managerId },
    });

    await this.cache.invalidatePattern(`projects:list:${orgId}:*`);

    return project;
  }

  async createFromDeal(orgId: string, userId: string, input: FromDealInput) {
    const deal = await this.db.query.deals.findFirst({
      where: and(eq(deals.id, input.dealId), eq(deals.orgId, orgId)),
    });
    if (!deal) throw new NotFoundException("Deal not found");

    const namePart = input.name.replace(/[^a-zA-Z]/g, "").substring(0, 3).toUpperCase();
    const randomPart = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
    const projectKey = (namePart.length >= 2 ? namePart : "PRJ") + "-" + randomPart;

    const [project] = await this.db
      .insert(projects)
      .values({
        orgId,
        key: projectKey,
        name: input.name,
        description: input.description ?? deal.notes ?? null,
        startDate: input.startDate ? new Date(input.startDate) : new Date(),
        endDate: input.endDate
          ? new Date(input.endDate)
          : deal.expectedCloseDate
            ? new Date(deal.expectedCloseDate)
            : undefined,
        status: "ACTIVE",
        dealId: input.dealId,
        managerId: deal.assignedToId ?? userId,
        budget: deal.value ?? undefined,
        settings: { modules: { sprints: true, epics: true, timeTracking: true, wiki: true } },
      })
      .returning();

    await this.db.insert(projectStatuses).values(
      DEFAULT_STATUSES.map((s) => ({
        orgId,
        projectId: project.id,
        name: s.name,
        order: s.order,
        color: s.color,
      })),
    );

    await this.db.insert(projectMembers).values({ projectId: project.id, userId, role: "OWNER" });

    this.audit.log({
      action: "project.created_from_deal",
      userId,
      orgId,
      targetId: String(project.id),
      targetType: "project",
      metadata: { dealId: input.dealId, dealName: deal.name, projectKey },
    });

    return project;
  }

  async getProject(u: CurrentUserContext, projectId: number) {
    const orgId = u.orgId;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const isOwnerOrAdmin = perms.has("projects:manage");

    const projectCheck = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
    });
    if (!projectCheck) throw new NotFoundException("Project not found");

    if (!isOwnerOrAdmin) {
      const isManager = projectCheck.managerId === u.userId;
      if (!isManager) {
        const memberOf = await this.db
          .select({ projectId: projectMembers.projectId })
          .from(projectMembers)
          .where(and(eq(projectMembers.userId, u.userId), eq(projectMembers.projectId, projectId)));
        if (memberOf.length === 0) throw new NotFoundException("Not found");
      }
    }

    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      with: {
        statuses: { orderBy: [asc(projectStatuses.order)] },
        members: { with: { user: true } },
        tickets: {
          with: {
            assignee: true,
            reporter: true,
            assignees: { with: { user: true } },
            comments: { with: { user: true } },
            attachments: true,
            labels: { with: { label: true } },
          },
        },
      },
    });
    if (!project) throw new NotFoundException("Project not found");

    return project;
  }

  async updateProject(u: CurrentUserContext, projectId: number, body: UpdateProjectInput) {
    const orgId = u.orgId;
    const perms = await this.access.resolveUserPermissions(u.orgId, u.userId);
    const isOwnerOrAdmin = perms.has("projects:manage");

    if (!isOwnerOrAdmin) {
      const project = await this.db.query.projects.findFirst({
        where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
        columns: { managerId: true },
      });
      if (!project || project.managerId !== u.userId) {
        throw new ForbiddenException("Only project managers or admins can update project settings.");
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
            await tx.update(tickets).set({ assigneeId: newAssignee }).where(inArray(tickets.id, ids));
          }
        } else if (removedMembers.length > 0) {
          await tx
            .update(tickets)
            .set({ assigneeId: null })
            .where(
              and(
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
      const projectTickets = await tx
        .select({ id: tickets.id })
        .from(tickets)
        .where(eq(tickets.projectId, projectId));
      const ticketIds = projectTickets.map((t) => t.id);
      if (ticketIds.length > 0) {
        await tx.delete(ticketAssignees).where(inArray(ticketAssignees.ticketId, ticketIds));
        await tx.delete(ticketComments).where(inArray(ticketComments.ticketId, ticketIds));
        await tx.delete(ticketAttachments).where(inArray(ticketAttachments.ticketId, ticketIds));
        await tx.delete(ticketLabelMappings).where(inArray(ticketLabelMappings.ticketId, ticketIds));
        await tx.delete(timesheets).where(inArray(timesheets.ticketId, ticketIds));
        await tx.delete(tickets).where(inArray(tickets.id, ticketIds));
      }
      await tx.delete(sprints).where(eq(sprints.projectId, projectId));
      await tx.delete(projectMembers).where(eq(projectMembers.projectId, projectId));
      await tx.delete(projectStatuses).where(eq(projectStatuses.projectId, projectId));
      await tx.delete(projects).where(eq(projects.id, projectId));
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
