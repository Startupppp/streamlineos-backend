import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  projectMembers,
  projects,
  ticketLabelMappings,
  ticketLabels,
  ticketWatchers,
  tickets,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { AllWorkQuery } from "./dto/projects.schemas";
import {
  assignedOrParticipatingIds,
  readIdsAndTotal,
  resolveWorkSort,
  type WorkSort,
} from "./work-scope-union";

const WORK_ROW_SELECTION = {
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
  rank: tickets.rank,
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
} as const;

@Injectable()
export class ProjectsWorkQueryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private watches(orgId: string, userId: string): SQL<unknown> {
    return sql`EXISTS (SELECT 1 FROM ${ticketWatchers} tw WHERE tw.org_id = ${orgId} AND tw.user_id = ${userId} AND tw.ticket_id = ${tickets.id})`;
  }

  async searchOrgTickets(
    orgId: string,
    userId: string,
    q: string,
    limit: number,
  ) {
    const memberProjectIds = await this.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(
        and(eq(projectMembers.orgId, orgId), eq(projectMembers.userId, userId)),
      );

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
          isNull(tickets.deletedAt),
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
      excludeStatus,
      scope,
      pmWorkspaceId,
    } = query;
    const offset = (page - 1) * limit;

    const memberRows = await this.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.orgId, u.orgId),
          eq(projectMembers.userId, u.userId),
        ),
      );

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
      isNull(tickets.deletedAt),
    ];

    if (pmWorkspaceId) {
      conditions.push(eq(projects.pmWorkspaceId, pmWorkspaceId));
    }

    if (scope === "created") {
      conditions.push(eq(tickets.reporterId, u.userId));
    }

    if (scope === "subscribed") {
      conditions.push(this.watches(u.orgId, u.userId));
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

    if (excludeStatus && excludeStatus.length > 0) {
      conditions.push(notInArray(tickets.status, excludeStatus));
    }

    if (priority && priority.length > 0) {
      conditions.push(inArray(tickets.priority, priority));
    }

    if (type && type.length > 0) {
      conditions.push(
        sql`${tickets.type}::text = ANY(ARRAY[${sql.join(
          type.map((t) => sql`${t}`),
          sql`, `,
        )}])`,
      );
    }

    if (assigneeId && assigneeId.length > 0) {
      const resolved = assigneeId.map((id) => (id === "@me" ? u.userId : id));
      const unassigned = resolved.includes("__unassigned__");
      const realIds = resolved.filter((id) => id !== "__unassigned__");
      if (unassigned && realIds.length > 0) {
        const assigneeCondition = or(
          isNull(tickets.assigneeId),
          inArray(tickets.assigneeId, realIds),
        );
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
          SELECT 1 FROM build.ticket_label_mappings tlm
          WHERE tlm.ticket_id = ${tickets.id}
          AND tlm.label_id = ANY(ARRAY[${sql.join(
            labelIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::int[])
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

    const sort = resolveWorkSort(orderBy, orderDir);

    const { rows, total } =
      scope === "mine"
        ? await this.pageMineWork(u, where, sort, limit, offset)
        : await this.pageFilteredWork(where, sort.rows, limit, offset);

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
            .innerJoin(
              ticketLabels,
              eq(ticketLabelMappings.labelId, ticketLabels.id),
            )
            .where(inArray(ticketLabelMappings.ticketId, ticketIds))
        : [];

    const labelsByTicket = new Map<
      number,
      { id: number; name: string; color: string }[]
    >();
    for (const row of labelRows) {
      const existing = labelsByTicket.get(row.ticketId) ?? [];
      existing.push({
        id: row.labelId,
        name: row.labelName,
        color: row.labelColor,
      });
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
      rank: r.rank,
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

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  private async pageFilteredWork(
    where: SQL<unknown> | undefined,
    sortExpr: SQL<unknown>[],
    limit: number,
    offset: number,
  ) {
    const [rows, countRows] = await Promise.all([
      this.db
        .select(WORK_ROW_SELECTION)
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
    return { rows, total: Number(countRows[0]?.total ?? 0) };
  }

  private async pageMineWork(
    u: CurrentUserContext,
    where: SQL<unknown> | undefined,
    sort: WorkSort,
    limit: number,
    offset: number,
  ) {
    const idQuery = (pageLimit: number, pageOffset: number) =>
      assignedOrParticipatingIds({
        orgId: u.orgId,
        userId: u.userId,
        baseWhere: where,
        carry: sort.carry,
        orderBy: sort.unionOrderBy,
        limit: pageLimit,
        offset: pageOffset,
      });

    const { ids, total } = readIdsAndTotal(
      await this.db.execute(idQuery(limit, offset)),
    );
    if (ids.length > 0) {
      const rows = await this.db
        .select(WORK_ROW_SELECTION)
        .from(tickets)
        .innerJoin(projects, eq(tickets.projectId, projects.id))
        .leftJoin(users, eq(tickets.assigneeId, users.id))
        .where(and(eq(tickets.orgId, u.orgId), inArray(tickets.id, ids)))
        .orderBy(...sort.rows);
      return { rows, total };
    }

    if (offset === 0) return { rows: [], total };
    const overshoot = readIdsAndTotal(await this.db.execute(idQuery(1, 0)));
    return { rows: [], total: overshoot.total };
  }
}
