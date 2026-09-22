import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { actingMembershipId } from "../../../common/auth/principal";
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
import {
  cycles,
  organizationMembers,
  projectMembers,
  projects,
  projectTeamAssignments,
  projectTeamMembers,
  tickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetAfterValue } from "../../../common/pagination/keyset";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { resolveTicketsScope, ticketScope } from "./tickets-scope";
import type { TicketsListQuery } from "./dto/projects.schemas";
import { queryTickets } from "./projects-tickets-read.query";

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

  async checkProjectAccess(
    orgId: string,
    userId: string,
    projectId: number,
    membershipId: number | null = null,
  ): Promise<{ hasAccess: boolean; role: string | null }> {
    const [perms, project] = await Promise.all([
      this.access.resolveUserPermissions(orgId, userId),
      this.db.query.projects.findFirst({
        where: and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)),
        columns: { managerMembershipId: true },
      }),
    ]);
    if (!project) return { hasAccess: false, role: null };
    if (perms.has("build:manage")) return { hasAccess: true, role: "OWNER" };
    if (membershipId !== null && project.managerMembershipId === membershipId)
      return { hasAccess: true, role: "MANAGER" };
    const membership = await this.db
      .select({ id: projectMembers.id, role: projectMembers.role })
      .from(projectMembers)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.id, projectMembers.membershipId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.orgId, orgId),
        ),
      )
      .limit(1);
    if (membership.length > 0) {
      return { hasAccess: true, role: membership[0]?.role ?? null };
    }
    const teamAccess = await this.db
      .select({ id: projectTeamMembers.id })
      .from(projectTeamAssignments)
      .innerJoin(
        projectTeamMembers,
        and(
          eq(projectTeamMembers.teamId, projectTeamAssignments.teamId),
          eq(projectTeamMembers.orgId, projectTeamAssignments.orgId),
        ),
      )
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.id, projectTeamMembers.membershipId),
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .where(
        and(
          eq(projectTeamAssignments.projectId, projectId),
          eq(projectTeamAssignments.orgId, orgId),
        ),
      )
      .limit(1);
    if (teamAccess.length > 0) return { hasAccess: true, role: "MEMBER" };
    return { hasAccess: false, role: null };
  }

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
  ) {
    const { hasAccess } = await this.checkProjectAccess(
      u.orgId,
      u.userId,
      projectId,
      actingMembershipId(u.principal),
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
      sprintId,
      sprintIds,
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
    const sprintParamProvided = sprintId !== undefined || (sprintIds && sprintIds.length > 0);
    if (sprintParamProvided) {
      const legacyIds: number[] = [
        ...(sprintId !== undefined ? [sprintId] : []),
        ...(sprintIds ?? []),
      ];
      const bridgeRows = await this.db
        .select({ id: cycles.id })
        .from(cycles)
        .where(and(eq(cycles.orgId, u.orgId), inArray(cycles.legacySprintId, legacyIds)));
      if (bridgeRows.length === 0) {
        return { data: [], pagination: { limit, nextCursor: null, hasMore: false } };
      }
      for (const r of bridgeRows) allCycleIds.push(r.id);
    }

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

    if (assigneeId && assigneeId.length > 0) {
      const resolved = assigneeId.map((id) => (id === "@me" ? u.userId : id));
      const unassigned = resolved.includes("__unassigned__");
      const realIds = resolved.filter((id) => id !== "__unassigned__");
      if (unassigned && realIds.length > 0) {
        const assigneeCondition = or(
          isNull(tickets.assigneeMembershipId),
          sql`${tickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${u.orgId} AND user_id IN (${sql.join(realIds.map((id) => sql`${id}`), sql`, `)}))`,
        );
        if (assigneeCondition) filterConditions.push(assigneeCondition);
      } else if (unassigned) {
        filterConditions.push(isNull(tickets.assigneeMembershipId));
      } else {
        filterConditions.push(sql`${tickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${u.orgId} AND user_id IN (${sql.join(realIds.map((id) => sql`${id}`), sql`, `)}))`);
      }
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
  ) {
    const position = decodeCursor(cursor);
    const boundary = position
      ? orderBy === "rank"
        ? keysetAfterValue(tickets.rank, tickets.id, position)
        : ticketCursorBoundary(orderBy, direction, position)
      : undefined;
    const bounded = and(where, boundary);
    const primaryColumn = TICKET_ORDERBY_COLUMNS[orderBy];

    const rows = await this.db
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
  ): Promise<Record<string, number>> {
    const { hasAccess } = await this.checkProjectAccess(
      u.orgId,
      u.userId,
      projectId,
      actingMembershipId(u.principal),
    );
    if (!hasAccess) throw new NotFoundException("Not found");

    const read = await resolveTicketsScope(this.access, u);
    if (read.denied) return {};

    const rows = await read.read(
      {
        tenant: tickets.orgId,
        scope: ticketScope(read.orgId, read.actorId),
        and: [eq(tickets.projectId, projectId), isNull(tickets.deletedAt)],
      },
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
