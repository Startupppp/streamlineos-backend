import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import {
  projectMembers,
  projectStatuses,
  projects,
  ticketAssignees,
  ticketLabelMappings,
  ticketLabels,
  ticketWatchers,
  tickets,
  users,
  workflowTransitions,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { resolveValidTicketStatuses } from "./ticket-status.util";
import { ProjectsInvalidTicketStatusException } from "../../common/http/api-exceptions";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AllWorkQuery, BulkUpdateInput, ReorderInput } from "./dto/projects.schemas";

const ALL_WORK_ORDERBY_COLUMNS = {
  created: tickets.createdAt,
  updated: tickets.updatedAt,
  priority: tickets.priority,
  dueDate: tickets.dueDate,
  order: tickets.order,
} as const;

@Injectable()
export class ProjectsTicketsQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async validateTicketStatus(projectId: number, orgId: string, status: string): Promise<void> {
    const valid = await resolveValidTicketStatuses(this.db, projectId, orgId, [status]);
    if (!valid.has(status)) throw new ProjectsInvalidTicketStatusException(status);
  }

  private async fetchTransitionsAndStatuses(orgId: string, projectId: number) {
    const [transitions, statuses] = await Promise.all([
      this.db
        .select({
          fromStatusId: workflowTransitions.fromStatusId,
          toStatusId: workflowTransitions.toStatusId,
          requiresApproval: workflowTransitions.requiresApproval,
          requiredFields: workflowTransitions.requiredFields,
          allowedRoles: workflowTransitions.allowedRoles,
        })
        .from(workflowTransitions)
        .where(and(eq(workflowTransitions.orgId, orgId), eq(workflowTransitions.projectId, projectId), isNull(workflowTransitions.deletedAt))),
      this.db
        .select({ id: projectStatuses.id, name: projectStatuses.name, wipLimit: projectStatuses.wipLimit })
        .from(projectStatuses)
        .where(and(eq(projectStatuses.orgId, orgId), eq(projectStatuses.projectId, projectId))),
    ]);
    return { transitions, statuses };
  }

  async assertTransitionAllowed(
    orgId: string,
    projectId: number,
    fromText: string,
    toText: string,
    context: {
      userId: string;
      userProjectRole: string | null;
      isOrgOwner: boolean;
      isPlatformAdmin: boolean;
      ticketId: number;
    },
    prefetched?: {
      transitions: {
        fromStatusId: number | null;
        toStatusId: number;
        requiresApproval: boolean | null;
        requiredFields: string[] | null;
        allowedRoles: string[] | null;
      }[];
      statuses: { id: number; name: string; wipLimit: number | null }[];
    },
  ): Promise<void> {
    const { transitions, statuses } = prefetched ?? await this.fetchTransitionsAndStatuses(orgId, projectId);

    if (transitions.length === 0) return;

    const nameToId = new Map(statuses.map((s) => [s.name, s.id]));
    const idToStatus = new Map(statuses.map((s) => [s.id, s]));

    const resolvedFrom = nameToId.get(fromText);
    const resolvedTo = nameToId.get(toText);

    if (resolvedFrom === undefined || resolvedTo === undefined) return;

    const matchingTransitions = transitions.filter(
      (t) => t.toStatusId === resolvedTo && (t.fromStatusId === resolvedFrom || t.fromStatusId === null),
    );

    if (matchingTransitions.length === 0) {
      throw new BadRequestException(`Transition from '${fromText}' to '${toText}' is not allowed by this project's workflow.`);
    }

    const bypassPrivilege = context.isOrgOwner || context.isPlatformAdmin;

    for (const transition of matchingTransitions) {
      if (transition.requiresApproval && !bypassPrivilege) {
        throw new BadRequestException(
          `This transition requires approval before moving to '${toText}'. Submit an approval request first.`,
        );
      }

      if (Array.isArray(transition.allowedRoles) && transition.allowedRoles.length > 0 && !bypassPrivilege) {
        if (!context.userProjectRole || !transition.allowedRoles.includes(context.userProjectRole)) {
          throw new BadRequestException(
            `Your project role ('${context.userProjectRole ?? "unknown"}') is not allowed to make this transition.`,
          );
        }
      }

      if (Array.isArray(transition.requiredFields) && transition.requiredFields.length > 0) {
        const ticketRows = await this.db
          .select({
            assigneeId: tickets.assigneeId,
            dueDate: tickets.dueDate,
            priority: tickets.priority,
            points: tickets.points,
            epicId: tickets.epicId,
            sprintId: tickets.sprintId,
          })
          .from(tickets)
          .where(and(eq(tickets.id, context.ticketId), eq(tickets.orgId, orgId)))
          .limit(1);

        if (ticketRows.length > 0) {
          const row = ticketRows[0];
          const missing: string[] = [];
          for (const field of transition.requiredFields) {
            if (field === "assigneeId" && !row.assigneeId) missing.push(field);
            else if (field === "dueDate" && !row.dueDate) missing.push(field);
            else if (field === "priority" && !row.priority) missing.push(field);
            else if (field === "points" && (row.points === null || row.points === undefined)) missing.push(field);
            else if (field === "epicId" && !row.epicId) missing.push(field);
            else if (field === "sprintId" && !row.sprintId) missing.push(field);
          }
          if (missing.length > 0) {
            throw new BadRequestException(
              `Cannot move to '${toText}': the following fields are required: ${missing.join(", ")}.`,
            );
          }
        }
      }
    }

    const toStatus = idToStatus.get(resolvedTo);
    if (toStatus?.wipLimit != null) {
      await this.assertWipLimit(orgId, projectId, toText, toStatus.wipLimit, context.ticketId);
    }
  }

  async assertWipLimit(orgId: string, projectId: number, statusName: string, wipLimit: number, excludeTicketId?: number): Promise<void> {
    const conditions = [
      eq(tickets.orgId, orgId),
      eq(tickets.projectId, projectId),
      eq(tickets.status, statusName),
    ];
    if (excludeTicketId !== undefined) {
      conditions.push(ne(tickets.id, excludeTicketId));
    }
    const [countResult] = await this.db
      .select({ cnt: count() })
      .from(tickets)
      .where(and(...conditions));
    const currentCount = Number(countResult?.cnt ?? 0);
    if (currentCount >= wipLimit) {
      throw new ConflictException(
        `Column '${statusName}' is at its WIP limit of ${wipLimit}. Move or complete an existing ticket first.`,
      );
    }
  }

  async enforceWipLimitForStatus(orgId: string, projectId: number, statusName: string, excludeTicketId: number): Promise<void> {
    const rows = await this.db
      .select({ wipLimit: projectStatuses.wipLimit, name: projectStatuses.name })
      .from(projectStatuses)
      .where(
        and(
          eq(projectStatuses.orgId, orgId),
          eq(projectStatuses.projectId, projectId),
          eq(projectStatuses.name, statusName),
        ),
      )
      .limit(1);
    const wipLimit = rows[0]?.wipLimit;
    if (wipLimit == null) return;
    await this.assertWipLimit(orgId, projectId, statusName, wipLimit, excludeTicketId);
  }

  async bulkUpdate(u: CurrentUserContext, projectId: number, body: BulkUpdateInput) {
    const member = await this.db.query.projectMembers.findFirst({
      where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, u.userId)),
    });
    if (!member) throw new ForbiddenException("Not a project member.");

    if (body.status !== undefined) {
      await this.validateTicketStatus(projectId, u.orgId, body.status);
    }

    const updateData: Partial<typeof tickets.$inferInsert> = { updatedAt: new Date() };
    if (body.assigneeId !== undefined) updateData.assigneeId = body.assigneeId;
    if (body.status !== undefined) updateData.status = body.status;
    if (body.sprintId !== undefined) updateData.sprintId = body.sprintId;
    if (body.priority !== undefined) updateData.priority = body.priority;

    const updated = await this.db
      .update(tickets)
      .set(updateData)
      .where(and(eq(tickets.orgId, u.orgId), eq(tickets.projectId, projectId), inArray(tickets.id, body.ticketIds)))
      .returning({ id: tickets.id });

    void this.cache.del(`projects:analytics:${u.orgId}:${projectId}`).catch(() => undefined);

    return { updated: updated.length, ticketIds: updated.map((t) => t.id) };
  }

  async reorder(
    orgId: string,
    projectId: number,
    body: ReorderInput,
    context: { userId: string; isOrgOwner: boolean; isPlatformAdmin: boolean },
  ) {
    if (body.items.length === 0) return { success: true };

    const distinctStatuses = [...new Set(body.items.map((i) => i.status))];
    const valid = await resolveValidTicketStatuses(this.db, projectId, orgId, distinctStatuses);
    for (const status of distinctStatuses) {
      if (!valid.has(status)) throw new ProjectsInvalidTicketStatusException(status);
    }

    const memberRow = await this.db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, context.userId)))
      .limit(1);
    const userProjectRole = memberRow[0]?.role ?? null;

    const itemIds = body.items.map((i) => i.id);

    const [prevRows, prefetched] = await Promise.all([
      this.db
        .select({ id: tickets.id, status: tickets.status })
        .from(tickets)
        .where(and(eq(tickets.orgId, orgId), eq(tickets.projectId, projectId), inArray(tickets.id, itemIds))),
      this.fetchTransitionsAndStatuses(orgId, projectId),
    ]);

    const prevMap = new Map(prevRows.map((r) => [r.id, r.status]));
    const statusChangingItems = body.items.filter((item) => {
      const prev = prevMap.get(item.id);
      return prev !== undefined && prev !== item.status;
    });

    for (const item of statusChangingItems) {
      const prev = prevMap.get(item.id);
      if (prev !== undefined) {
        await this.assertTransitionAllowed(orgId, projectId, prev, item.status, {
          userId: context.userId,
          userProjectRole,
          isOrgOwner: context.isOrgOwner,
          isPlatformAdmin: context.isPlatformAdmin,
          ticketId: item.id,
        }, prefetched);
      }
    }

    const movedItemIds = new Set(statusChangingItems.map((i) => i.id));
    const incomingByStatus = new Map<string, number>();
    for (const item of statusChangingItems) {
      incomingByStatus.set(item.status, (incomingByStatus.get(item.status) ?? 0) + 1);
    }

    const { statuses } = prefetched;
    const wipByName = new Map(statuses.filter((s) => s.wipLimit != null).map((s) => [s.name, s.wipLimit as number]));

    for (const [statusName, incomingCount] of incomingByStatus) {
      const wipLimit = wipByName.get(statusName);
      if (wipLimit == null) continue;

      const movingAwayIds = [...movedItemIds];
      const conditions = [
        eq(tickets.orgId, orgId),
        eq(tickets.projectId, projectId),
        eq(tickets.status, statusName),
      ];
      if (movingAwayIds.length > 0) {
        conditions.push(sql`${tickets.id} NOT IN (${sql.join(movingAwayIds.map((id) => sql`${id}`), sql`, `)})`);
      }
      const [countResult] = await this.db
        .select({ cnt: count() })
        .from(tickets)
        .where(and(...conditions));
      const currentInTarget = Number(countResult?.cnt ?? 0);
      if (currentInTarget + incomingCount > wipLimit) {
        throw new ConflictException(
          `Column '${statusName}' is at its WIP limit of ${wipLimit}. Move or complete an existing ticket first.`,
        );
      }
    }

    const now = new Date();

    const orderWhen = sql.join(
      body.items.map((item) => sql`WHEN ${item.id} THEN ${item.order}`),
      sql` `,
    );
    const statusWhen = sql.join(
      body.items.map((item) => sql`WHEN ${item.id} THEN ${item.status}`),
      sql` `,
    );

    await this.db
      .update(tickets)
      .set({
        order: sql<number>`CASE ${tickets.id} ${orderWhen} END`,
        status: sql<string>`CASE ${tickets.id} ${statusWhen} END`,
        updatedAt: now,
      })
      .where(
        and(
          inArray(tickets.id, itemIds),
          eq(tickets.projectId, projectId),
          eq(tickets.orgId, orgId),
        ),
      );

    if (statusChangingItems.length > 0) {
      void this.cache.del(`projects:analytics:${orgId}:${projectId}`).catch(() => undefined);
    }

    return { success: true };
  }

  async searchOrgTickets(orgId: string, userId: string, q: string, limit: number) {
    const memberProjectIds = await this.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, userId));

    const ids = memberProjectIds.map((r) => r.projectId);
    if (ids.length === 0) return [];

    const rows = await this.db
      .select({
        id: tickets.id,
        title: tickets.title,
        status: tickets.status,
        priority: tickets.priority,
        ticketNumber: tickets.ticketNumber,
        projectId: tickets.projectId,
        projectKey: projects.key,
        projectName: projects.name,
      })
      .from(tickets)
      .innerJoin(projects, eq(tickets.projectId, projects.id))
      .where(
        and(
          eq(tickets.orgId, orgId),
          inArray(tickets.projectId, ids),
          q.length > 0
            ? or(
                sql`${tickets.title} ILIKE ${"%" + q + "%"}`,
                sql`CAST(${tickets.ticketNumber} AS TEXT) ILIKE ${"%" + q + "%"}`,
                sql`CONCAT(${projects.key}, '-', CAST(${tickets.ticketNumber} AS TEXT)) ILIKE ${"%" + q + "%"}`,
              )
            : undefined,
        ),
      )
      .orderBy(desc(tickets.updatedAt))
      .limit(limit);

    return rows;
  }

  async getMyWork(orgId: string, userId: string) {
    const assigneeRows = await this.db
      .select({ ticketId: ticketAssignees.ticketId })
      .from(ticketAssignees)
      .where(eq(ticketAssignees.userId, userId))
      .limit(500);

    const assigneeTicketIds = assigneeRows.map((r) => r.ticketId);

    const assigneeCondition =
      assigneeTicketIds.length > 0
        ? or(eq(tickets.assigneeId, userId), inArray(tickets.id, assigneeTicketIds))
        : eq(tickets.assigneeId, userId);

    return this.db
      .select({
        id: tickets.id,
        title: tickets.title,
        status: tickets.status,
        priority: tickets.priority,
        type: tickets.type,
        dueDate: tickets.dueDate,
        ticketNumber: tickets.ticketNumber,
        projectId: projects.id,
        projectName: projects.name,
        projectKey: projects.key,
      })
      .from(tickets)
      .innerJoin(projects, eq(tickets.projectId, projects.id))
      .where(
        and(
          eq(tickets.orgId, orgId),
          ne(projects.status, "ARCHIVED"),
          assigneeCondition,
        ),
      )
      .orderBy(
        sql`${tickets.dueDate} ASC NULLS LAST`,
        sql`CASE ${tickets.priority} WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END ASC`,
      )
      .limit(200);
  }

  async getAllWork(u: CurrentUserContext, query: AllWorkQuery) {
    const {
      page,
      limit,
      search,
      status,
      priority,
      type,
      assigneeId,
      labelIds,
      sprintId,
      cycleId,
      epicId,
      dueDateFrom,
      dueDateTo,
      orderBy,
      orderDir,
      projectIds: filterProjectIds,
      scope,
    } = query;
    const offset = (page - 1) * limit;

    const memberRows = await this.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, u.userId));

    const memberProjectIds = memberRows.map((r) => r.projectId);
    if (memberProjectIds.length === 0) {
      return { data: [], total: 0, page, limit, totalPages: 0 };
    }

    const allowedProjectIds =
      filterProjectIds && filterProjectIds.length > 0
        ? filterProjectIds.filter((id) => memberProjectIds.includes(id))
        : memberProjectIds;

    if (allowedProjectIds.length === 0) {
      return { data: [], total: 0, page, limit, totalPages: 0 };
    }

    const conditions: SQL<unknown>[] = [
      eq(tickets.orgId, u.orgId),
      inArray(tickets.projectId, allowedProjectIds),
      ne(projects.status, "ARCHIVED"),
    ];

    if (scope === "mine") {
      const assigneeRows = await this.db
        .select({ ticketId: ticketAssignees.ticketId })
        .from(ticketAssignees)
        .where(eq(ticketAssignees.userId, u.userId))
        .limit(1000);
      const assigneeTicketIds = assigneeRows.map((r) => r.ticketId);
      const mineCondition =
        assigneeTicketIds.length > 0
          ? or(eq(tickets.assigneeId, u.userId), inArray(tickets.id, assigneeTicketIds))
          : eq(tickets.assigneeId, u.userId);
      if (mineCondition) {
        conditions.push(mineCondition);
      }
    }

    if (scope === "created") {
      conditions.push(eq(tickets.reporterId, u.userId));
    }

    if (scope === "subscribed") {
      const watcherRows = await this.db
        .select({ ticketId: ticketWatchers.ticketId })
        .from(ticketWatchers)
        .where(eq(ticketWatchers.userId, u.userId))
        .limit(1000);
      const watchedTicketIds = watcherRows.map((r) => r.ticketId);
      if (watchedTicketIds.length > 0) {
        conditions.push(inArray(tickets.id, watchedTicketIds));
      } else {
        return { data: [], total: 0, page, limit, totalPages: 0 };
      }
    }

    if (search && search.trim()) {
      const term = search.trim();
      const isTicketRef = /^[A-Za-z]+-\d+$/.test(term) || /^#?\d+$/.test(term);
      if (isTicketRef) {
        const numStr = term.replace(/^#/, "").replace(/^[A-Za-z]+-/, "");
        const num = parseInt(numStr, 10);
        const searchCondition = or(
          sql`${tickets.title} ILIKE ${"%" + term + "%"}`,
          isNaN(num) ? sql`false` : eq(tickets.ticketNumber, num),
        );
        if (searchCondition) {
          conditions.push(searchCondition);
        }
      } else {
        conditions.push(sql`${tickets.title} ILIKE ${"%" + term + "%"}`);
      }
    }

    if (status && status.length > 0) {
      conditions.push(inArray(tickets.status, status));
    }

    if (priority && priority.length > 0) {
      conditions.push(inArray(tickets.priority, priority));
    }

    if (type && type.length > 0) {
      conditions.push(
        sql`${tickets.type}::text = ANY(ARRAY[${sql.join(type.map((t) => sql`${t}`), sql`, `)}])`,
      );
    }

    if (assigneeId && assigneeId.length > 0) {
      const unassigned = assigneeId.includes("__unassigned__");
      const realIds = assigneeId.filter((id) => id !== "__unassigned__");
      if (unassigned && realIds.length > 0) {
        const assigneeCondition = or(isNull(tickets.assigneeId), inArray(tickets.assigneeId, realIds));
        if (assigneeCondition) {
          conditions.push(assigneeCondition);
        }
      } else if (unassigned) {
        conditions.push(isNull(tickets.assigneeId));
      } else {
        conditions.push(inArray(tickets.assigneeId, realIds));
      }
    }

    if (labelIds && labelIds.length > 0) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ticket_label_mappings tlm
          WHERE tlm.ticket_id = ${tickets.id}
          AND tlm.label_id = ANY(ARRAY[${sql.join(labelIds.map((id) => sql`${id}`), sql`, `)}]::int[])
        )`,
      );
    }

    if (sprintId !== undefined) {
      conditions.push(eq(tickets.sprintId, sprintId));
    }

    if (cycleId && cycleId.length > 0) {
      conditions.push(inArray(tickets.cycleId, cycleId));
    }

    if (epicId !== undefined) {
      conditions.push(eq(tickets.epicId, epicId));
    }

    if (dueDateFrom) {
      conditions.push(gte(tickets.dueDate, dueDateFrom));
    }

    if (dueDateTo) {
      conditions.push(lte(tickets.dueDate, dueDateTo));
    }

    const where = and(...conditions);

    const col = ALL_WORK_ORDERBY_COLUMNS[orderBy];
    const defaultDir = orderBy === "created" || orderBy === "updated" ? "desc" : "asc";
    const dir = orderDir ?? defaultDir;
    const sortExpr =
      orderBy === "order"
        ? [asc(tickets.order), desc(tickets.createdAt)]
        : dir === "asc"
        ? [asc(col), desc(tickets.createdAt)]
        : [desc(col), desc(tickets.createdAt)];

    const [rows, countRows] = await Promise.all([
      this.db
        .select({
          id: tickets.id,
          title: tickets.title,
          status: tickets.status,
          priority: tickets.priority,
          type: tickets.type,
          dueDate: tickets.dueDate,
          startDate: tickets.startDate,
          ticketNumber: tickets.ticketNumber,
          points: tickets.points,
          estimate: tickets.estimate,
          order: tickets.order,
          createdAt: tickets.createdAt,
          updatedAt: tickets.updatedAt,
          assigneeId: tickets.assigneeId,
          sprintId: tickets.sprintId,
          cycleId: tickets.cycleId,
          epicId: tickets.epicId,
          projectId: projects.id,
          projectKey: projects.key,
          projectName: projects.name,
          assigneeName: users.name,
          assigneeFirstName: users.firstName,
          assigneeLastName: users.lastName,
          assigneeEmail: users.email,
          assigneeImage: users.image,
        })
        .from(tickets)
        .innerJoin(projects, eq(tickets.projectId, projects.id))
        .leftJoin(users, eq(tickets.assigneeId, users.id))
        .where(where)
        .orderBy(...sortExpr)
        .limit(limit)
        .offset(offset),
      this.db
        .select({ total: count() })
        .from(tickets)
        .innerJoin(projects, eq(tickets.projectId, projects.id))
        .where(where),
    ]);

    const ticketIds = rows.map((r) => r.id);

    const labelRows =
      ticketIds.length > 0
        ? await this.db
            .select({
              ticketId: ticketLabelMappings.ticketId,
              labelId: ticketLabels.id,
              labelName: ticketLabels.name,
              labelColor: ticketLabels.color,
            })
            .from(ticketLabelMappings)
            .innerJoin(ticketLabels, eq(ticketLabelMappings.labelId, ticketLabels.id))
            .where(inArray(ticketLabelMappings.ticketId, ticketIds))
        : [];

    const labelsByTicket = new Map<number, { id: number; name: string; color: string }[]>();
    for (const row of labelRows) {
      const existing = labelsByTicket.get(row.ticketId) ?? [];
      existing.push({ id: row.labelId, name: row.labelName, color: row.labelColor });
      labelsByTicket.set(row.ticketId, existing);
    }

    const data = rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      type: r.type,
      dueDate: r.dueDate,
      startDate: r.startDate,
      ticketNumber: r.ticketNumber,
      points: r.points,
      estimate: r.estimate,
      order: r.order,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      assigneeId: r.assigneeId,
      sprintId: r.sprintId,
      cycleId: r.cycleId,
      epicId: r.epicId,
      projectId: r.projectId,
      projectKey: r.projectKey,
      projectName: r.projectName,
      assignee: r.assigneeId
        ? {
            id: r.assigneeId,
            name: r.assigneeName,
            firstName: r.assigneeFirstName,
            lastName: r.assigneeLastName,
            email: r.assigneeEmail,
            image: r.assigneeImage,
          }
        : null,
      labels: labelsByTicket.get(r.id) ?? [],
    }));

    const total = Number(countRows[0]?.total ?? 0);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }
}
