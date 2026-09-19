import { Inject, Injectable } from "@nestjs/common";
import {
  and,
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
  organizationMembers,
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
  mineCountSql,
  readIds,
  resolveWorkSort,
  type WorkSort,
} from "./work-scope-union";
import {
  buildCursorPage,
  decodeCursor,
  encodeCursor,
} from "../../../common/pagination/cursor";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";
import {
  buildCursorPredicate,
  buildMineCursorPredicate,
  serializeSortValue,
} from "./projects-work-query.cursor";
import { WORK_ROW_SELECTION } from "./projects-work-query-helpers";

@Injectable()
export class ProjectsWorkQueryService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private watches(orgId: string, userId: string): SQL<unknown> {
    return sql`EXISTS (
      SELECT 1 FROM ${ticketWatchers} tw
      JOIN organization_members om ON om.org_id = tw.org_id AND om.id = tw.membership_id
      WHERE tw.org_id = ${orgId} AND om.user_id = ${userId} AND tw.ticket_id = ${tickets.id}
    )`;
  }

  async getAllWork(u: CurrentUserContext, query: AllWorkQuery) {
    const {
      cursor,
      limit: rawLimit,
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
    const limit = Math.min(rawLimit, PAGE_SIZE_CAP);

    const isSelfScoped = scope === "created" || scope === "subscribed";

    const conditions: SQL<unknown>[] = [
      eq(tickets.orgId, u.orgId),
      ne(projects.status, "ARCHIVED"),
      isNull(tickets.deletedAt),
    ];

    if (isSelfScoped) {
      if (filterProjectIds && filterProjectIds.length > 0) {
        conditions.push(inArray(tickets.projectId, filterProjectIds));
      }
    } else {
      const memberRows = await this.db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.id, projectMembers.membershipId),
            eq(organizationMembers.orgId, projectMembers.orgId),
            eq(organizationMembers.userId, u.userId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        )
        .where(eq(projectMembers.orgId, u.orgId));

      const memberProjectIds = memberRows.map((r) => r.projectId);
      if (memberProjectIds.length === 0) {
        return { data: [], limit, nextCursor: null, hasMore: false, total: 0 };
      }

      const allowedProjectIds =
        filterProjectIds && filterProjectIds.length > 0
          ? filterProjectIds.filter((id) => memberProjectIds.includes(id))
          : memberProjectIds;

      if (allowedProjectIds.length === 0) {
        return { data: [], limit, nextCursor: null, hasMore: false, total: 0 };
      }

      conditions.push(inArray(tickets.projectId, allowedProjectIds));
    }

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
      const prefixedRef = /^([A-Za-z]+)-(\d+)$/.exec(term);
      const isTicketRef = prefixedRef !== null || /^#?\d+$/.test(term);
      if (isTicketRef) {
        const numStr = term.replace(/^#/, "").replace(/^[A-Za-z]+-/, "");
        const num = parseInt(numStr, 10);
        const numCondition: SQL<unknown> = isNaN(num) ? sql`false` : eq(tickets.ticketNumber, num);
        const keyBranch: SQL<unknown> = prefixedRef
          ? (and(sql`UPPER(${projects.key}) = UPPER(${prefixedRef[1]})`, numCondition) ?? sql`false`)
          : numCondition;
        const searchCondition = or(
          sql`${tickets.title} ILIKE ${"%" + term + "%"}`,
          keyBranch,
        );
        if (searchCondition) conditions.push(searchCondition);
      } else {
        conditions.push(sql`${tickets.title} ILIKE ${"%" + term + "%"}`);
      }
    }

    if (status && status.length > 0) conditions.push(inArray(tickets.status, status));
    if (excludeStatus && excludeStatus.length > 0) conditions.push(notInArray(tickets.status, excludeStatus));
    if (priority && priority.length > 0) conditions.push(inArray(tickets.priority, priority));

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
          isNull(tickets.assigneeMembershipId),
          sql`${tickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${u.orgId} AND user_id IN (${sql.join(realIds.map((id) => sql`${id}`), sql`, `)}))`,
        );
        if (assigneeCondition) conditions.push(assigneeCondition);
      } else if (unassigned) {
        conditions.push(isNull(tickets.assigneeMembershipId));
      } else {
        conditions.push(sql`${tickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${u.orgId} AND user_id IN (${sql.join(realIds.map((id) => sql`${id}`), sql`, `)}))`);
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

    if (sprintId !== undefined) conditions.push(eq(tickets.sprintId, sprintId));
    if (cycleId && cycleId.length > 0) conditions.push(inArray(tickets.cycleId, cycleId));
    if (epicId !== undefined) conditions.push(eq(tickets.epicId, epicId));
    if (dueDateFrom) conditions.push(gte(tickets.dueDate, dueDateFrom));
    if (dueDateTo) conditions.push(lte(tickets.dueDate, dueDateTo));

    const where = and(...conditions);
    const sort = resolveWorkSort(orderBy, orderDir);
    const isFirstPage = !cursor;

    const { rows, nextCursor, hasMore, total } =
      scope === "mine"
        ? await this.pageMineWork(u, where, sort, limit, cursor, isFirstPage)
        : await this.pageFilteredWork(where, sort, limit, cursor, isFirstPage);

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

    return { data, limit, nextCursor, hasMore, ...(total !== undefined ? { total } : {}) };
  }

  private async pageFilteredWork(
    where: SQL<unknown> | undefined,
    sort: WorkSort,
    limit: number,
    cursor: string | undefined,
    includeTotal: boolean,
  ) {
    const position = decodeCursor(cursor);
    const cursorCond = position ? buildCursorPredicate(sort.sortKey, sort.dir, position) : undefined;
    const finalWhere = cursorCond ? and(where, cursorCond) : where;

    const [rawRows, countRows] = await Promise.all([
      this.db
        .select({
          ...WORK_ROW_SELECTION,
          cursorCreatedAt: sql<string>`${tickets.createdAt}::text`,
          cursorUpdatedAt: sql<string>`${tickets.updatedAt}::text`,
        })
        .from(tickets)
        .innerJoin(projects, eq(tickets.projectId, projects.id))
        .leftJoin(organizationMembers, and(eq(organizationMembers.orgId, tickets.orgId), eq(organizationMembers.id, tickets.assigneeMembershipId)))
        .leftJoin(users, eq(organizationMembers.userId, users.id))
        .where(finalWhere)
        .orderBy(...sort.rows)
        .limit(limit + 1),
      includeTotal
        ? this.db
            .select({ total: sql<string>`count(*)` })
            .from(tickets)
            .innerJoin(projects, eq(tickets.projectId, projects.id))
            .where(where)
        : Promise.resolve(null),
    ]);

    const page = buildCursorPage(rawRows, limit, (row) => ({
      sortValue: serializeSortValue(row, sort.sortKey),
      id: String(row.id),
    }));

    const total = countRows ? Number(countRows[0]?.total ?? 0) : undefined;
    return {
      rows: page.data,
      nextCursor: page.pagination.nextCursor,
      hasMore: page.pagination.hasMore,
      total,
    };
  }

  private async pageMineWork(
    u: CurrentUserContext,
    where: SQL<unknown> | undefined,
    sort: WorkSort,
    limit: number,
    cursor: string | undefined,
    includeTotal: boolean,
  ) {
    const position = decodeCursor(cursor);
    const cursorPredicate = position
      ? buildMineCursorPredicate(sort.sortKey, sort.dir, position)
      : undefined;

    const idSql = assignedOrParticipatingIds({
      orgId: u.orgId,
      userId: u.userId,
      baseWhere: where,
      carry: sort.carry,
      orderBy: sort.unionOrderBy,
      limit: limit + 1,
      cursorPredicate,
    });

    const [rawIds, countRows] = await Promise.all([
      this.db.execute(idSql),
      includeTotal
        ? this.db.execute(mineCountSql(where, u.orgId, u.userId))
        : Promise.resolve(null),
    ]);

    const ids = readIds(rawIds);
    const hasMore = ids.length > limit;
    const pageIds = hasMore ? ids.slice(0, limit) : ids;

    if (pageIds.length === 0) {
      const total = countRows ? Number(countRows[0]?.["total"] ?? 0) : undefined;
      return { rows: [], nextCursor: null, hasMore: false, total };
    }

    const rows = await this.db
      .select({
        ...WORK_ROW_SELECTION,
        cursorCreatedAt: sql<string>`${tickets.createdAt}::text`,
        cursorUpdatedAt: sql<string>`${tickets.updatedAt}::text`,
      })
      .from(tickets)
      .innerJoin(projects, eq(tickets.projectId, projects.id))
      .leftJoin(organizationMembers, and(eq(organizationMembers.orgId, tickets.orgId), eq(organizationMembers.id, tickets.assigneeMembershipId)))
      .leftJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(tickets.orgId, u.orgId), inArray(tickets.id, pageIds)))
      .orderBy(...sort.rows);

    const lastRow = rows[rows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeCursor({ sortValue: serializeSortValue(lastRow, sort.sortKey), id: String(lastRow.id) })
        : null;

    const total = countRows ? Number(countRows[0]?.["total"] ?? 0) : undefined;
    return { rows, nextCursor, hasMore, total };
  }
}
