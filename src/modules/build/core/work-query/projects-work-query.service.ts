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
  organizationMembers,
  projectTeamAssignments,
  projects,
  ticketAssignees,
  ticketLabelMappings,
  ticketLabels,
  ticketWatchers,
  ticketCommentMentions,
  ticketComments,
  ticketActivityLog,
  tickets,
  workItemRelations,
  users,
} from "../../../../db/schema";
import { actingMembershipId } from "../../../../common/auth/principal";
import { reachableProjectsSql } from "../../reachability/project-reachability";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { AllWorkQuery } from "../dto/projects.schemas";
import {
  WORK_SORT_COLUMNS,
  assignedOrParticipatingIds,
  mineCountByStatusSql,
  mineCountSql,
  readIds,
  resolveWorkSort,
  type WorkSort,
} from "./work-scope-union";
import {
  buildCursorPage,
  decodeCursor,
  encodeCursor,
} from "../../../../common/pagination/cursor";
import { PAGE_SIZE_CAP } from "../../../../common/pagination/list-query.schema";
import {
  buildCursorPredicate,
  buildMineCursorPredicate,
  serializeSortValue,
} from "./projects-work-query.cursor";
import { WORK_ROW_SELECTION } from "./projects-work-query-helpers";

type ProjectStatusCount = {
  projectId: number | null;
  projectName: string;
  status: string;
  count: number;
};

export function allCountByStatusQuery(db: Db, where: SQL<unknown> | undefined) {
  return db
    .select({ status: tickets.status, cnt: sql<string>`count(*)` })
    .from(tickets)
    .innerJoin(projects, eq(tickets.projectId, projects.id))
    .where(where)
    .groupBy(tickets.status);
}

function personCountByProjectAndStatusSql(
  where: SQL<unknown> | undefined,
  orgId: string,
  subjectUserId: string,
): SQL<unknown> {
  const scoped = where ?? sql`true`;
  const subjectMemberships = sql`SELECT id FROM organization_members WHERE org_id = ${orgId} AND user_id = ${subjectUserId}`;
  const branchColumns = sql`${tickets.id} AS id, ${tickets.projectId} AS project_id, ${projects.name} AS project_name, ${tickets.status} AS status`;
  return sql`
    SELECT u.project_id AS project_id, u.project_name AS project_name, u.status AS status, count(*) AS cnt
    FROM (
      (SELECT ${branchColumns}
       FROM ${tickets}
       INNER JOIN ${projects} ON ${projects.id} = ${tickets.projectId}
       WHERE ${scoped} AND ${tickets.assigneeMembershipId} IN (${subjectMemberships}))
      UNION
      (SELECT ${branchColumns}
       FROM ${tickets}
       INNER JOIN ${projects} ON ${projects.id} = ${tickets.projectId}
       INNER JOIN ${ticketAssignees} ta
         ON ta.ticket_id = ${tickets.id}
        AND ta.org_id = ${orgId}
        AND ta.membership_id IN (${subjectMemberships})
       WHERE ${scoped})
    ) u
    GROUP BY u.project_id, u.project_name, u.status`;
}

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
      cycleId,
      epicId,
      dueDateFrom,
      dueDateTo,
      orderBy,
      orderDir,
      projectIds: filterProjectIds,
      managedProductId,
      teamId,
      excludeStatus,
      scope,
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
      const membershipId = actingMembershipId(u.principal);
      if (membershipId === null) {
        return { data: [], limit, nextCursor: null, hasMore: false, total: 0 };
      }
      conditions.push(reachableProjectsSql(u.orgId, membershipId));
      if (filterProjectIds && filterProjectIds.length > 0) {
        conditions.push(inArray(tickets.projectId, filterProjectIds));
      }
    }

    if (scope === "created") {
      conditions.push(eq(tickets.reporterId, u.userId));
    }

    if (scope === "subscribed") {
      conditions.push(this.watches(u.orgId, u.userId));
    }

    if (scope === "mentioned") {
      conditions.push(sql`EXISTS (
        SELECT 1
        FROM ${ticketCommentMentions} tcm
        INNER JOIN ${ticketComments} tc
          ON tc.org_id = tcm.org_id
         AND tc.id = tcm.comment_id
         AND tc.ticket_id = ${tickets.id}
         AND tc.deleted_at IS NULL
        INNER JOIN organization_members mention_member
          ON mention_member.org_id = tcm.org_id
         AND mention_member.id = tcm.mentioned_user_membership_id
         AND mention_member.user_id = ${u.userId}
         AND mention_member.status = 'ACTIVE'
        WHERE tcm.org_id = ${u.orgId}
      )`);
    }

    if (scope === "blocked") {
      conditions.push(sql`EXISTS (
        SELECT 1
        FROM ${workItemRelations} wir
        INNER JOIN ${tickets} blocker
          ON blocker.org_id = wir.org_id
         AND blocker.id = wir.work_item_id
         AND blocker.deleted_at IS NULL
        WHERE wir.org_id = ${u.orgId}
          AND wir.related_work_item_id = ${tickets.id}
          AND wir.relation_type = 'blocks'
          AND blocker.status NOT IN ('DONE', 'CANCELLED')
      )`);
    }

    if (scope === "recently-completed") {
      conditions.push(eq(tickets.status, "DONE"));
      conditions.push(sql`EXISTS (
        SELECT 1
        FROM ${ticketActivityLog} completion_event
        WHERE completion_event.org_id = ${u.orgId}
          AND completion_event.ticket_id = ${tickets.id}
          AND completion_event.action = 'status_changed'
          AND completion_event.to_value = 'DONE'
          AND completion_event.created_at >= NOW() - INTERVAL '7 days'
      )`);
    }

    if (search && search.trim()) {
      const term = search.trim();
      const prefixedRef = /^([A-Za-z]+)-(\d+)$/.exec(term);
      const isTicketRef = prefixedRef !== null || /^#?\d+$/.test(term);
      if (isTicketRef) {
        const numStr = term.replace(/^#/, "").replace(/^[A-Za-z]+-/, "");
        const num = parseInt(numStr, 10);
        const numCondition: SQL<unknown> = isNaN(num)
          ? sql`false`
          : eq(tickets.ticketNumber, num);
        const keyBranch: SQL<unknown> = prefixedRef
          ? (and(
              sql`UPPER(${projects.key}) = UPPER(${prefixedRef[1]})`,
              numCondition,
            ) ?? sql`false`)
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

    if (status && status.length > 0)
      conditions.push(inArray(tickets.status, status));
    if (managedProductId !== undefined) {
      conditions.push(eq(projects.managedProductId, managedProductId));
    }
    if (teamId !== undefined) {
      conditions.push(sql`EXISTS (
        SELECT 1
        FROM ${projectTeamAssignments} pta
        WHERE pta.org_id = ${u.orgId}
          AND pta.project_id = ${tickets.projectId}
          AND pta.team_id = ${teamId}
      )`);
    }
    if (excludeStatus && excludeStatus.length > 0)
      conditions.push(notInArray(tickets.status, excludeStatus));
    if (priority && priority.length > 0)
      conditions.push(inArray(tickets.priority, priority));

    if (type && type.length > 0) {
      conditions.push(
        sql`${tickets.type}::text = ANY(ARRAY[${sql.join(
          type.map((t) => sql`${t}`),
          sql`, `,
        )}])`,
      );
    }

    let assigneeUnion:
      | { nullBranch: SQL<unknown>; inBranch: SQL<unknown> }
      | undefined;
    if (assigneeId && assigneeId.length > 0) {
      const resolved = assigneeId.map((id) => (id === "@me" ? u.userId : id));
      const unassigned = resolved.includes("__unassigned__");
      const realIds = resolved.filter((id) => id !== "__unassigned__");
      if (unassigned && realIds.length > 0) {
        const inBranch = sql`${tickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${u.orgId} AND user_id IN (${sql.join(
          realIds.map((id) => sql`${id}`),
          sql`, `,
        )}))`;
        assigneeUnion = {
          nullBranch: isNull(tickets.assigneeMembershipId),
          inBranch,
        };
      } else if (unassigned) {
        conditions.push(isNull(tickets.assigneeMembershipId));
      } else {
        conditions.push(
          sql`${tickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${u.orgId} AND user_id IN (${sql.join(
            realIds.map((id) => sql`${id}`),
            sql`, `,
          )}))`,
        );
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

    if (cycleId && cycleId.length > 0)
      conditions.push(inArray(tickets.cycleId, cycleId));
    if (epicId !== undefined) conditions.push(eq(tickets.epicId, epicId));
    if (dueDateFrom) conditions.push(gte(tickets.dueDate, dueDateFrom));
    if (dueDateTo) conditions.push(lte(tickets.dueDate, dueDateTo));

    const where = and(...conditions);
    const sort = resolveWorkSort(orderBy, orderDir);
    const isFirstPage = !cursor;

    const { rows, nextCursor, hasMore, total } =
      scope === "mine"
        ? await this.pageMineWork(
            u,
            where,
            sort,
            limit,
            cursor,
            isFirstPage,
            assigneeUnion,
          )
        : await this.pageFilteredWork(
            where,
            sort,
            limit,
            cursor,
            isFirstPage,
            assigneeUnion,
            u.orgId,
          );

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
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      assigneeId: r.assigneeId,
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

    return {
      data,
      limit,
      nextCursor,
      hasMore,
      ...(total !== undefined ? { total } : {}),
    };
  }

  async countTicketsByProjectAndStatus(
    u: CurrentUserContext,
    opts: {
      assigneeId?: string;
      projectIds?: number[];
    },
  ): Promise<{
    byProject: {
      projectId: number;
      projectName: string;
      total: number;
      done: number;
      inProgress: number;
    }[];
    totals: { total: number; done: number; inProgress: number };
  }> {
    const baseConditions: SQL<unknown>[] = [
      eq(tickets.orgId, u.orgId),
      ne(projects.status, "ARCHIVED"),
      isNull(tickets.deletedAt),
    ];

    const membershipId = actingMembershipId(u.principal);
    if (membershipId === null)
      return { byProject: [], totals: { total: 0, done: 0, inProgress: 0 } };
    baseConditions.push(reachableProjectsSql(u.orgId, membershipId));
    if (opts.projectIds && opts.projectIds.length > 0) {
      baseConditions.push(inArray(tickets.projectId, opts.projectIds));
    }

    const where = and(...baseConditions);
    const statusRows =
      opts.assigneeId === undefined
        ? await this.groupedCountByProjectAndStatus(where)
        : await this.personGroupedCountByProjectAndStatus(
            where,
            u.orgId,
            opts.assigneeId,
          );

    const byProjectMap = new Map<
      number,
      {
        projectId: number;
        projectName: string;
        total: number;
        done: number;
        inProgress: number;
      }
    >();
    for (const row of statusRows) {
      if (row.projectId === null) continue;
      const entry = byProjectMap.get(row.projectId) ?? {
        projectId: row.projectId,
        projectName: row.projectName,
        total: 0,
        done: 0,
        inProgress: 0,
      };
      entry.total += row.count;
      if (row.status === "DONE") entry.done += row.count;
      if (row.status === "IN_PROGRESS" || row.status === "IN_REVIEW")
        entry.inProgress += row.count;
      byProjectMap.set(row.projectId, entry);
    }

    const byProject = Array.from(byProjectMap.values()).sort(
      (a, b) => b.total - a.total,
    );
    const totals = byProject.reduce(
      (acc, r) => ({
        total: acc.total + r.total,
        done: acc.done + r.done,
        inProgress: acc.inProgress + r.inProgress,
      }),
      { total: 0, done: 0, inProgress: 0 },
    );
    return { byProject, totals };
  }

  private async groupedCountByProjectAndStatus(
    where: SQL<unknown> | undefined,
  ): Promise<ProjectStatusCount[]> {
    const rows = await this.db
      .select({
        projectId: tickets.projectId,
        projectName: projects.name,
        status: tickets.status,
        cnt: sql<string>`count(*)`,
      })
      .from(tickets)
      .innerJoin(projects, eq(tickets.projectId, projects.id))
      .where(where)
      .groupBy(tickets.projectId, projects.name, tickets.status);

    return rows.map((row) => ({
      projectId: row.projectId,
      projectName: row.projectName,
      status: row.status,
      count: Number(row.cnt),
    }));
  }

  private async personGroupedCountByProjectAndStatus(
    where: SQL<unknown> | undefined,
    orgId: string,
    subjectUserId: string,
  ): Promise<ProjectStatusCount[]> {
    const rows = await this.db.execute(
      personCountByProjectAndStatusSql(where, orgId, subjectUserId),
    );

    const counts: ProjectStatusCount[] = [];
    for (const row of rows) {
      const projectId = row["project_id"];
      if (projectId === null || projectId === undefined) continue;
      counts.push({
        projectId: Number(projectId),
        projectName: String(row["project_name"]),
        status: String(row["status"]),
        count: Number(row["cnt"]),
      });
    }
    return counts;
  }

  async countTicketsByStatus(
    u: CurrentUserContext,
    opts: {
      scope: "all" | "mine";
      assigneeId?: string;
      projectIds?: number[];
    },
  ): Promise<{ byStatus: Record<string, number>; total: number }> {
    const baseConditions: SQL<unknown>[] = [
      eq(tickets.orgId, u.orgId),
      ne(projects.status, "ARCHIVED"),
      isNull(tickets.deletedAt),
    ];

    const membershipId = actingMembershipId(u.principal);
    if (membershipId === null) return { byStatus: {}, total: 0 };
    baseConditions.push(reachableProjectsSql(u.orgId, membershipId));
    if (opts.projectIds && opts.projectIds.length > 0) {
      baseConditions.push(inArray(tickets.projectId, opts.projectIds));
    }

    if (opts.scope === "all") {
      if (opts.assigneeId !== undefined) {
        baseConditions.push(
          sql`${tickets.assigneeMembershipId} IN (SELECT id FROM organization_members WHERE org_id = ${u.orgId} AND user_id = ${opts.assigneeId})`,
        );
      }

      const where = and(...baseConditions);
      const statusRows = await allCountByStatusQuery(this.db, where);

      const byStatus: Record<string, number> = {};
      let total = 0;
      for (const row of statusRows) {
        const cnt = Number(row.cnt);
        byStatus[row.status] = cnt;
        total += cnt;
      }
      return { byStatus, total };
    }

    const where = and(...baseConditions);
    const rawRows = await this.db.execute(
      mineCountByStatusSql(where, u.orgId, u.userId),
    );
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of rawRows) {
      const status = String(row["status"]);
      const cnt = Number(row["cnt"]);
      byStatus[status] = cnt;
      total += cnt;
    }
    return { byStatus, total };
  }

  private async pageFilteredWork(
    where: SQL<unknown> | undefined,
    sort: WorkSort,
    limit: number,
    cursor: string | undefined,
    includeTotal: boolean,
    assigneeUnion?: { nullBranch: SQL<unknown>; inBranch: SQL<unknown> },
    orgId?: string,
  ) {
    const position = decodeCursor(cursor);
    const cursorCond = position
      ? buildCursorPredicate(sort.sortKey, sort.dir, position)
      : undefined;

    if (assigneeUnion !== undefined && orgId !== undefined) {
      const { nullBranch, inBranch } = assigneeUnion;
      const sortCol = WORK_SORT_COLUMNS[sort.sortKey];
      const sortDir = sort.dir === "asc" ? sql`ASC` : sql`DESC`;
      const b1 = cursorCond
        ? and(where, nullBranch, cursorCond)
        : and(where, nullBranch);
      const b2 = cursorCond
        ? and(where, inBranch, cursorCond)
        : and(where, inBranch);

      const unionIdSql = sql`
        (SELECT ${tickets.id} AS id, ${sortCol} AS sort_col
         FROM ${tickets}
         INNER JOIN ${projects} ON ${projects.id} = ${tickets.projectId}
         WHERE ${b1})
        UNION ALL
        (SELECT ${tickets.id} AS id, ${sortCol} AS sort_col
         FROM ${tickets}
         INNER JOIN ${projects} ON ${projects.id} = ${tickets.projectId}
         WHERE ${b2})
        ORDER BY 2 ${sortDir}, 1 ${sortDir}
        LIMIT ${limit + 1}`;

      const unionCountSql = sql`
        SELECT count(*)::text AS total FROM (
          (SELECT ${tickets.id} AS id
           FROM ${tickets}
           INNER JOIN ${projects} ON ${projects.id} = ${tickets.projectId}
           WHERE ${and(where, nullBranch)})
          UNION ALL
          (SELECT ${tickets.id} AS id
           FROM ${tickets}
           INNER JOIN ${projects} ON ${projects.id} = ${tickets.projectId}
           WHERE ${and(where, inBranch)})
        ) t`;

      const [rawIds, unionCountRows] = await Promise.all([
        this.db.execute<{ id: number }>(unionIdSql),
        includeTotal
          ? this.db.execute<{ total: string }>(unionCountSql)
          : Promise.resolve(null),
      ]);

      const ids = readIds(rawIds);
      const hasMore = ids.length > limit;
      const pageIds = hasMore ? ids.slice(0, limit) : ids;
      const total = unionCountRows
        ? Number(unionCountRows[0]?.["total"] ?? 0)
        : undefined;

      if (pageIds.length === 0) {
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
        .leftJoin(
          organizationMembers,
          and(
            eq(organizationMembers.orgId, tickets.orgId),
            eq(organizationMembers.id, tickets.assigneeMembershipId),
          ),
        )
        .leftJoin(users, eq(organizationMembers.userId, users.id))
        .where(and(eq(tickets.orgId, orgId), inArray(tickets.id, pageIds)))
        .orderBy(...sort.rows);

      const lastRow = rows[rows.length - 1];
      const nextCursor =
        hasMore && lastRow
          ? encodeCursor({
              sortValue: serializeSortValue(lastRow, sort.sortKey),
              id: String(lastRow.id),
            })
          : null;

      return { rows, nextCursor, hasMore, total };
    }

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
        .leftJoin(
          organizationMembers,
          and(
            eq(organizationMembers.orgId, tickets.orgId),
            eq(organizationMembers.id, tickets.assigneeMembershipId),
          ),
        )
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
    assigneeUnion?: { nullBranch: SQL<unknown>; inBranch: SQL<unknown> },
  ) {
    const position = decodeCursor(cursor);
    const cursorPredicate = position
      ? buildMineCursorPredicate(sort.sortKey, sort.dir, position)
      : undefined;

    const splitBranches = assigneeUnion
      ? [assigneeUnion.nullBranch, assigneeUnion.inBranch]
      : undefined;

    const idSql = assignedOrParticipatingIds({
      orgId: u.orgId,
      userId: u.userId,
      baseWhere: where,
      carry: sort.carry,
      orderBy: sort.unionOrderBy,
      limit: limit + 1,
      cursorPredicate,
      splitBranches,
    });

    const [rawIds, countRows] = await Promise.all([
      this.db.execute(idSql),
      includeTotal
        ? this.db.execute(
            mineCountSql(where, u.orgId, u.userId, splitBranches),
          )
        : Promise.resolve(null),
    ]);

    const ids = readIds(rawIds);
    const hasMore = ids.length > limit;
    const pageIds = hasMore ? ids.slice(0, limit) : ids;

    if (pageIds.length === 0) {
      const total = countRows
        ? Number(countRows[0]?.["total"] ?? 0)
        : undefined;
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
      .leftJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, tickets.orgId),
          eq(organizationMembers.id, tickets.assigneeMembershipId),
        ),
      )
      .leftJoin(users, eq(organizationMembers.userId, users.id))
      .where(and(eq(tickets.orgId, u.orgId), inArray(tickets.id, pageIds)))
      .orderBy(...sort.rows);

    const lastRow = rows[rows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeCursor({
            sortValue: serializeSortValue(lastRow, sort.sortKey),
            id: String(lastRow.id),
          })
        : null;

    const total = countRows ? Number(countRows[0]?.["total"] ?? 0) : undefined;
    return { rows, nextCursor, hasMore, total };
  }
}
