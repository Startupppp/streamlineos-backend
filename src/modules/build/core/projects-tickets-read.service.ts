import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { actingMembershipId } from "../../../common/auth/principal";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  organizationMembers,
  projectMembers,
  projects,
  projectTeamAssignments,
  projectTeamMembers,
  ticketAssignees,
  tickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetAfterValue } from "../../../common/pagination/keyset";
import { totalOverWindow } from "../../../common/pagination/window-count";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { resolveTicketsScope } from "./tickets-scope";
import type { TicketsListQuery } from "./dto/projects.schemas";

const TRIGRAM_MIN_TERM_LENGTH = 3;

const TICKET_SEARCH_ID_CAP = 1000;

const TICKET_ORDERBY_COLUMNS = {
  created: tickets.createdAt,
  updated: tickets.updatedAt,
  priority: tickets.priority,
  dueDate: tickets.dueDate,
  rank: tickets.rank,
} as const;

const USER_COLS = {
  id: true,
  name: true,
  firstName: true,
  lastName: true,
  email: true,
  image: true,
} as const;

const TICKET_LIST_COLUMNS = {
  id: true,
  orgId: true,
  title: true,
  type: true,
  status: true,
  priority: true,
  projectId: true,
  ticketNumber: true,
  sprintId: true,
  epicId: true,
  assigneeId: true,
  reporterId: true,
  points: true,
  storyPoints: true,
  link: true,
  rank: true,
  parentTicketId: true,
  originalEstimate: true,
  timeSpent: true,
  startDate: true,
  dueDate: true,
  moduleId: true,
  cycleId: true,
  sequenceId: true,
  estimate: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ProjectsTicketsReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  private queryTickets(
    where: SQL<unknown> | undefined,
    orderBy: SQL<unknown>[],
    limit: number,
    offset?: number,
  ) {
    return this.db.query.tickets.findMany({
      where,
      columns: TICKET_LIST_COLUMNS,
      with: {
        assignee: { columns: USER_COLS },
        assignees: {
          with: { user: { columns: USER_COLS } },
        },
        labels: {
          with: {
            label: {
              columns: { id: true, name: true, color: true },
            },
          },
        },
        cycle: {
          columns: {
            id: true,
            name: true,
            status: true,
            startDate: true,
            endDate: true,
          },
        },
      },
      orderBy,
      limit,
      offset,
    });
  }

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
        columns: { managerId: true, managerMembershipId: true },
      }),
    ]);
    if (!project) return { hasAccess: false, role: null };
    if (perms.has("build:manage")) return { hasAccess: true, role: "OWNER" };
    if (
      (membershipId !== null && project.managerMembershipId === membershipId) ||
      project.managerId === userId
    )
      return { hasAccess: true, role: "MANAGER" };
    const membership = await this.db
      .select({ id: projectMembers.id, role: projectMembers.role })
      .from(projectMembers)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId),
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
        eq(projectTeamMembers.teamId, projectTeamAssignments.teamId),
      )
      .where(
        and(
          eq(projectTeamAssignments.projectId, projectId),
          eq(projectTeamAssignments.orgId, orgId),
          eq(projectTeamMembers.userId, userId),
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

    const scope = await resolveTicketsScope(this.access, u);

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
      sprintIds,
      cycleId,
      moduleIds,
      epicId,
      dueDateFrom,
      dueDateTo,
      orderBy,
      orderDir,
    } = query;
    const offset = (page - 1) * limit;

    if (scope === "none")
      return { data: [], total: 0, page, limit, totalPages: 0 };

    const scopeClause =
      scope !== "all"
        ? or(
            eq(tickets.assigneeId, u.userId),
            eq(tickets.reporterId, u.userId),
            sql`EXISTS (SELECT 1 FROM ${ticketAssignees} ta WHERE ta.org_id = ${u.orgId} AND ta.user_id = ${u.userId} AND ta.ticket_id = ${tickets.id})`,
          )
        : undefined;

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
          isNull(tickets.assigneeId),
          inArray(tickets.assigneeId, realIds),
        );
        if (assigneeCondition) filterConditions.push(assigneeCondition);
      } else if (unassigned) {
        filterConditions.push(isNull(tickets.assigneeId));
      } else {
        filterConditions.push(inArray(tickets.assigneeId, realIds));
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

    if (sprintId !== undefined)
      filterConditions.push(eq(tickets.sprintId, sprintId));
    if (sprintIds && sprintIds.length > 0)
      filterConditions.push(inArray(tickets.sprintId, sprintIds));
    if (cycleId && cycleId.length > 0)
      filterConditions.push(inArray(tickets.cycleId, cycleId));
    if (moduleIds && moduleIds.length > 0)
      filterConditions.push(inArray(tickets.moduleId, moduleIds));
    if (epicId !== undefined) filterConditions.push(eq(tickets.epicId, epicId));
    if (dueDateFrom) filterConditions.push(gte(tickets.dueDate, dueDateFrom));
    if (dueDateTo) filterConditions.push(lte(tickets.dueDate, dueDateTo));

    const where = and(
      eq(tickets.orgId, u.orgId),
      eq(tickets.projectId, projectId),
      isNull(tickets.deletedAt),
      ...(scopeClause ? [scopeClause] : []),
      ...filterConditions,
    );

    const col = TICKET_ORDERBY_COLUMNS[orderBy];
    const defaultDir =
      orderBy === "created" || orderBy === "updated" ? "desc" : "asc";
    const dir = orderDir ?? defaultDir;

    const sortExpr: SQL<unknown>[] =
      orderBy === "rank"
        ? [asc(tickets.rank), desc(tickets.createdAt), asc(tickets.id)]
        : dir === "asc"
          ? [asc(col), desc(tickets.createdAt), asc(tickets.id)]
          : [desc(col), desc(tickets.createdAt), asc(tickets.id)];

    if (query.paging === "cursor") {
      return this.listTicketsByCursor(where, limit, query.cursor);
    }

    if (scope !== "all") {
      const { ids, total } = await this.pageScopedTicketIds(
        where,
        sortExpr,
        limit,
        offset,
      );
      const data =
        ids.length > 0
          ? await this.queryTickets(inArray(tickets.id, ids), sortExpr, limit)
          : [];
      return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
    }

    const [dataResult, countResult] = await Promise.all([
      this.queryTickets(where, sortExpr, limit, offset),
      this.db.select({ total: count() }).from(tickets).where(where),
    ]);

    const total = Number(countResult[0]?.total ?? 0);
    return {
      data: dataResult,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * The board scrolls a list the whole team is writing to, so it pages by keyset on
   * `(rank, id)` — the order it already renders in, and a total order because `id` is unique.
   */
  private async listTicketsByCursor(
    where: SQL<unknown> | undefined,
    limit: number,
    cursor: string | undefined,
  ) {
    const position = decodeCursor(cursor);
    const bounded = position
      ? and(where, keysetAfterValue(tickets.rank, tickets.id, position))
      : where;

    const rows = await this.db
      .select({ id: tickets.id, rank: tickets.rank, total: totalOverWindow })
      .from(tickets)
      .where(bounded)
      .orderBy(asc(tickets.rank), asc(tickets.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.rank ?? "",
      id: String(row.id),
    }));

    const ids = page.data.map((row) => row.id);
    const data =
      ids.length > 0
        ? await this.queryTickets(
            inArray(tickets.id, ids),
            [asc(tickets.rank), asc(tickets.id)],
            limit,
          )
        : [];

    return {
      data,
      total: position ? undefined : Number(page.data[0]?.total ?? 0),
      limit,
      nextCursor: page.pagination.nextCursor,
      hasMore: page.pagination.hasMore,
    };
  }

  private async pageScopedTicketIds(
    where: SQL<unknown> | undefined,
    sortExpr: SQL<unknown>[],
    limit: number,
    offset: number,
  ): Promise<{ ids: number[]; total: number }> {
    const rows = await this.db
      .select({ id: tickets.id, total: sql<string>`count(*) OVER ()` })
      .from(tickets)
      .where(where)
      .orderBy(...sortExpr)
      .limit(limit)
      .offset(offset);

    const first = rows[0];
    if (first) return { ids: rows.map((row) => row.id), total: Number(first.total) };

    if (offset === 0) return { ids: [], total: 0 };
    const countResult = await this.db
      .select({ total: count() })
      .from(tickets)
      .where(where);
    return { ids: [], total: Number(countResult[0]?.total ?? 0) };
  }

  async getColumnCounts(orgId: string, projectId: number): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ status: tickets.status, cnt: sql<string>`count(*)` })
      .from(tickets)
      .where(
        and(
          eq(tickets.orgId, orgId),
          eq(tickets.projectId, projectId),
          isNull(tickets.deletedAt),
        ),
      )
      .groupBy(tickets.status);
    const result: Record<string, number> = {};
    for (const row of rows) {
      if (row.status) result[row.status] = Number(row.cnt);
    }
    return result;
  }

}
