import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { buildAssigneeFilter } from "../assignee-filter";
import {
  tickets,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../../../common/pagination/cursor";
import { keysetAfterValue } from "../../../../common/pagination/keyset";
import { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { resolveTicketsScope, ticketScope } from "./tickets-scope";
import type { TicketsListQuery } from "../dto/projects.schemas";
import { queryTickets } from "./projects-tickets-read.query";
import { resolveProjectAccess } from "../project-access";
import { ProjectAccessCache } from "../../reachability/project-access-cache";

const TRIGRAM_MIN_TERM_LENGTH = 3;

const TICKET_SEARCH_ID_CAP = 1000;

const TICKET_ORDERBY_COLUMNS = {
  created: tickets.createdAt,
  updated: tickets.updatedAt,
  priority: tickets.priority,
  dueDate: tickets.dueDate,
  rank: tickets.rank,
} as const;

type TicketOrderBy = keyof typeof TICKET_ORDERBY_COLUMNS;

interface TicketCursorSort {
  primary: string | null;
  createdAt: string;
}

function ticketCursorBoundary(
  orderBy: Exclude<TicketOrderBy, "rank">,
  direction: "asc" | "desc",
  position: NonNullable<ReturnType<typeof decodeCursor>>,
): SQL<unknown> | undefined {
  const id = Number(position.id);
  if (!Number.isSafeInteger(id) || id <= 0) return undefined;

  let decoded: unknown;
  try {
    decoded = JSON.parse(String(position.sortValue));
  } catch {
    return undefined;
  }
  if (
    typeof decoded !== "object" || decoded === null ||
    !("primary" in decoded) || !("createdAt" in decoded) ||
    !(decoded.primary === null || typeof decoded.primary === "string") ||
    typeof decoded.createdAt !== "string"
  ) {
    return undefined;
  }

  if (Number.isNaN(Date.parse(decoded.createdAt))) return undefined;
  const primaryColumn = TICKET_ORDERBY_COLUMNS[orderBy];
  const primaryValue = decoded.primary;
  const timestampPrimary = orderBy === "created" || orderBy === "updated";
  if (timestampPrimary && primaryValue !== null && Number.isNaN(Date.parse(primaryValue))) return undefined;

  const createdParam = sql`${decoded.createdAt}::timestamptz`;
  const idParam = sql.param(id, tickets.id);
  const tail = sql`(
    ${tickets.createdAt} < ${createdParam}
    OR (${tickets.createdAt} = ${createdParam} AND ${tickets.id} > ${idParam})
  )`;

  if (primaryValue === null) {
    return direction === "asc"
      ? and(isNull(primaryColumn), tail)
      : or(and(isNull(primaryColumn), tail), isNotNull(primaryColumn));
  }

  const primaryParam = timestampPrimary ? sql`${primaryValue}::timestamptz` : sql.param(primaryValue, primaryColumn);
  return direction === "asc"
    ? sql`(
        ${primaryColumn} > ${primaryParam}
        OR ${primaryColumn} IS NULL
        OR (${primaryColumn} = ${primaryParam} AND ${tail})
      )`
    : sql`(
        ${primaryColumn} < ${primaryParam}
        OR (${primaryColumn} = ${primaryParam} AND ${tail})
      )`;
}

@Injectable()
export class ProjectsTicketsReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  private async resolveTitleMatch(term: string): Promise<SQL<unknown>> {
    const like = sql`${tickets.title} ILIKE ${"%" + term + "%"}`;
    if (term.length < TRIGRAM_MIN_TERM_LENGTH) return like;
    const idRows = await this.db.execute(
      sql`SELECT app.search_ticket_ids(${term}, ${TICKET_SEARCH_ID_CAP + 1}) AS id`,
    );
    if (idRows.length > TICKET_SEARCH_ID_CAP) return like;
    const ids = idRows.map((r) => Number(r["id"]));
    if (ids.length === 0) return sql`false`;
    return inArray(tickets.id, ids);
  }

  async listTickets(
    u: CurrentUserContext,
    projectId: number,
    query: TicketsListQuery,
    cache: ProjectAccessCache = new ProjectAccessCache(),
  ) {
    const { hasAccess } = await cache.get(u.orgId, u.userId, projectId, () =>
      resolveProjectAccess(this.db, this.access, u, projectId),
    );
    if (!hasAccess) throw new NotFoundException("Not found");

    const read = await resolveTicketsScope(this.access, u);

    const {
      limit,
      search,
      status,
      priority,
      type,
      assigneeId,
      labelIds,
      cycleId,
      moduleIds,
      epicId,
      dueDateFrom,
      dueDateTo,
      orderBy,
      orderDir,
    } = query;

    if (read.denied)
      return {
        data: [],
        pagination: { limit, nextCursor: null, hasMore: false },
      };

    const allCycleIds: number[] = [...(cycleId ?? [])];

    const filterConditions: SQL<unknown>[] = [];

    if (search && search.trim()) {
      const term = search.trim();
      const isTicketRef = /^[A-Za-z]+-\d+$/.test(term) || /^#?\d+$/.test(term);
      const titleMatch = await this.resolveTitleMatch(term);
      if (isTicketRef) {
        const numStr = term.replace(/^#/, "").replace(/^[A-Za-z]+-/, "");
        const num = parseInt(numStr, 10);
        const searchCondition = or(
          titleMatch,
          isNaN(num) ? sql`false` : eq(tickets.ticketNumber, num),
        );
        if (searchCondition) filterConditions.push(searchCondition);
      } else {
        filterConditions.push(titleMatch);
      }
    }

    if (status && status.length > 0)
      filterConditions.push(inArray(tickets.status, status));

    if (priority && priority.length > 0)
      filterConditions.push(inArray(tickets.priority, priority));

    if (type && type.length > 0) {
      filterConditions.push(
        sql`${tickets.type}::text = ANY(ARRAY[${sql.join(
          type.map((t) => sql`${t}`),
          sql`, `,
        )}])`,
      );
    }

    let assigneeUnion: { nullBranch: SQL<unknown>; inBranch: SQL<unknown> } | undefined;
    if (assigneeId && assigneeId.length > 0) {
      const resolved = assigneeId.map((id) => (id === "@me" ? u.userId : id));
      const includeUnassigned = resolved.includes("__unassigned__");
      const userIds = resolved.filter((id) => id !== "__unassigned__");
      const assigneeFilter = buildAssigneeFilter(u.orgId, userIds, includeUnassigned);
      if (assigneeFilter?.kind === "single") filterConditions.push(assigneeFilter.clause);
      if (assigneeFilter?.kind === "union") assigneeUnion = assigneeFilter;
    }

    if (labelIds && labelIds.length > 0) {
      filterConditions.push(
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

    if (allCycleIds.length > 0)
      filterConditions.push(inArray(tickets.cycleId, allCycleIds));
    if (moduleIds && moduleIds.length > 0)
      filterConditions.push(inArray(tickets.moduleId, moduleIds));
    if (epicId !== undefined) filterConditions.push(eq(tickets.epicId, epicId));
    if (dueDateFrom) filterConditions.push(gte(tickets.dueDate, dueDateFrom));
    if (dueDateTo) filterConditions.push(lte(tickets.dueDate, dueDateTo));

    const where = read.compose(
      {
        tenant: tickets.orgId,
        scope: ticketScope(read.orgId, read.actorId),
        and: [eq(tickets.projectId, projectId), isNull(tickets.deletedAt), ...filterConditions],
      },
      ({ sql: where }) => where,
      () => sql`false`,
    );

    const col = TICKET_ORDERBY_COLUMNS[orderBy];
    const defaultDir =
      orderBy === "created" || orderBy === "updated" ? "desc" : "asc";
    const dir = orderDir ?? defaultDir;

    const sortExpr: SQL<unknown>[] =
      orderBy === "rank"
        ? [asc(tickets.rank), asc(tickets.id)]
        : dir === "asc"
          ? [asc(col), desc(tickets.createdAt), asc(tickets.id)]
          : [desc(col), desc(tickets.createdAt), asc(tickets.id)];

    return this.listTicketsByCursor(
      where,
      limit,
      query.cursor,
      orderBy,
      dir,
      sortExpr,
      assigneeUnion,
    );
  }

  /**
   * The board scrolls a list the whole team is writing to, so it pages by keyset on
   * `(rank, id)` — the order it already renders in, and a total order because `id` is unique.
   */
  private async listTicketsByCursor(
    where: SQL<unknown> | undefined,
    limit: number,
    cursor: string | undefined,
    orderBy: TicketOrderBy,
    direction: "asc" | "desc",
    sortExpr: SQL<unknown>[],
    assigneeUnion?: { nullBranch: SQL<unknown>; inBranch: SQL<unknown> },
  ) {
    const position = decodeCursor(cursor);
    const boundary = position
      ? orderBy === "rank"
        ? keysetAfterValue(tickets.rank, tickets.id, position)
        : ticketCursorBoundary(orderBy, direction, position)
      : undefined;
    const primaryColumn = TICKET_ORDERBY_COLUMNS[orderBy];

    type CursorRow = {
      id: number;
      cursorPrimaryText: string | null;
      rank: string | null;
      cursorCreatedAt: string;
    };

    let rows: CursorRow[];

    if (assigneeUnion) {
      const branch1Bounded = and(where, assigneeUnion.nullBranch, boundary);
      const branch2Bounded = and(where, assigneeUnion.inBranch, boundary);

      const selCols = sql`${tickets.id} AS id, ${primaryColumn}::text AS cursor_primary_text, ${tickets.rank}::text AS rank, ${tickets.createdAt}::text AS cursor_created_at, ${primaryColumn} AS primary_col_order, ${tickets.createdAt} AS created_at_order`;

      const unionOrderSql =
        orderBy === "rank"
          ? sql`5 ASC, 1 ASC`
          : direction === "asc"
            ? sql`5 ASC, 6 DESC, 1 ASC`
            : sql`5 DESC, 6 DESC, 1 ASC`;

      const rawRows = await this.db.execute<{
        id: number;
        cursor_primary_text: string | null;
        rank: string | null;
        cursor_created_at: string;
      }>(sql`(SELECT ${selCols} FROM ${tickets} WHERE ${branch1Bounded}) UNION ALL (SELECT ${selCols} FROM ${tickets} WHERE ${branch2Bounded}) ORDER BY ${unionOrderSql} LIMIT ${limit + 1}`);

      rows = rawRows.map((r) => ({
        id: r.id,
        cursorPrimaryText: r.cursor_primary_text,
        rank: r.rank,
        cursorCreatedAt: r.cursor_created_at,
      }));
    } else {
      const bounded = and(where, boundary);
      rows = await this.db
        .select({
          id: tickets.id,
          cursorPrimaryText: sql<string | null>`${primaryColumn}::text`,
          rank: tickets.rank,
          cursorCreatedAt: sql<string>`${tickets.createdAt}::text`,
        })
        .from(tickets)
        .where(bounded)
        .orderBy(...sortExpr)
        .limit(limit + 1);
    }

    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue:
        orderBy === "rank"
          ? row.rank ?? ""
          : JSON.stringify({
              primary: row.cursorPrimaryText,
              createdAt: row.cursorCreatedAt,
            } satisfies TicketCursorSort),
      id: String(row.id),
    }));

    const ids = page.data.map((row) => row.id);
    const data =
      ids.length > 0
        ? await queryTickets(
            this.db,
            inArray(tickets.id, ids),
            sortExpr,
            limit,
          )
        : [];

    return { data, pagination: page.pagination };
  }

  async getColumnCounts(
    u: CurrentUserContext,
    projectId: number,
    query: TicketsListQuery = { limit: 50, orderBy: "rank" },
    cache: ProjectAccessCache = new ProjectAccessCache(),
  ): Promise<Record<string, number>> {
    const { hasAccess } = await cache.get(u.orgId, u.userId, projectId, () =>
      resolveProjectAccess(this.db, this.access, u, projectId),
    );
    if (!hasAccess) throw new NotFoundException("Not found");

    const read = await resolveTicketsScope(this.access, u);
    if (read.denied) return {};

    const filterConditions: SQL<unknown>[] = [];
    if (query.search && query.search.trim()) {
      const term = query.search.trim();
      const isTicketRef = /^[A-Za-z]+-\d+$/.test(term) || /^#?\d+$/.test(term);
      const titleMatch = await this.resolveTitleMatch(term);
      if (isTicketRef) {
        const numStr = term.replace(/^#/, "").replace(/^[A-Za-z]+-/, "");
        const num = parseInt(numStr, 10);
        const searchCondition = or(titleMatch, Number.isNaN(num) ? sql`false` : eq(tickets.ticketNumber, num));
        if (searchCondition) filterConditions.push(searchCondition);
      } else {
        filterConditions.push(titleMatch);
      }
    }
    if (query.status?.length) filterConditions.push(inArray(tickets.status, query.status));
    if (query.priority?.length) filterConditions.push(inArray(tickets.priority, query.priority));
    if (query.type?.length) {
      filterConditions.push(
        sql`${tickets.type}::text = ANY(ARRAY[${sql.join(query.type.map((value) => sql`${value}`), sql`, `)}])`,
      );
    }
    let assigneeUnion2: { nullBranch: SQL<unknown>; inBranch: SQL<unknown> } | undefined;
    if (query.assigneeId?.length) {
      const resolved = query.assigneeId.map((id) => (id === "@me" ? u.userId : id));
      const includeUnassigned = resolved.includes("__unassigned__");
      const userIds = resolved.filter((id) => id !== "__unassigned__");
      const assigneeFilter = buildAssigneeFilter(u.orgId, userIds, includeUnassigned);
      if (assigneeFilter?.kind === "single") filterConditions.push(assigneeFilter.clause);
      if (assigneeFilter?.kind === "union") assigneeUnion2 = assigneeFilter;
    }
    if (query.labelIds?.length) {
      filterConditions.push(sql`EXISTS (
        SELECT 1 FROM build.ticket_label_mappings tlm
        WHERE tlm.ticket_id = ${tickets.id}
          AND tlm.label_id = ANY(ARRAY[${sql.join(query.labelIds.map((id) => sql`${id}`), sql`, `)}]::int[])
      )`);
    }
    if (query.cycleId?.length) filterConditions.push(inArray(tickets.cycleId, query.cycleId));
    if (query.moduleIds?.length) filterConditions.push(inArray(tickets.moduleId, query.moduleIds));
    if (query.epicId !== undefined) filterConditions.push(eq(tickets.epicId, query.epicId));
    if (query.dueDateFrom) filterConditions.push(gte(tickets.dueDate, query.dueDateFrom));
    if (query.dueDateTo) filterConditions.push(lte(tickets.dueDate, query.dueDateTo));

    const scopeSpec = {
      tenant: tickets.orgId,
      scope: ticketScope(read.orgId, read.actorId),
    };
    const baseAnd = [eq(tickets.projectId, projectId), isNull(tickets.deletedAt), ...filterConditions];

    if (assigneeUnion2) {
      const where1 = read.compose(
        { ...scopeSpec, and: [...baseAnd, assigneeUnion2.nullBranch] },
        ({ sql: w }) => w,
        () => sql`false`,
      );
      const where2 = read.compose(
        { ...scopeSpec, and: [...baseAnd, assigneeUnion2.inBranch] },
        ({ sql: w }) => w,
        () => sql`false`,
      );
      const countRows = await this.db.execute<{ status: string | null; cnt: string }>(sql`
        SELECT status, sum(cnt::bigint)::text AS cnt FROM (
          SELECT ${tickets.status} AS status, count(*)::text AS cnt FROM ${tickets} WHERE ${where1} GROUP BY ${tickets.status}
          UNION ALL
          SELECT ${tickets.status} AS status, count(*)::text AS cnt FROM ${tickets} WHERE ${where2} GROUP BY ${tickets.status}
        ) t GROUP BY status
      `);
      const result: Record<string, number> = {};
      for (const row of countRows) {
        if (row.status) result[row.status] = Number(row.cnt);
      }
      return result;
    }

    const rows = await read.read(
      { ...scopeSpec, and: baseAnd },
      ({ sql: where }) => this.db
        .select({ status: tickets.status, cnt: sql<string>`count(*)` })
        .from(tickets)
        .where(where)
        .groupBy(tickets.status),
      () => [],
    );
    const result: Record<string, number> = {};
    for (const row of rows) {
      if (row.status) result[row.status] = Number(row.cnt);
    }
    return result;
  }

}
