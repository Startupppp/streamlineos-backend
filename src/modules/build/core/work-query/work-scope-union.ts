import { asc, desc, sql, type SQL } from "drizzle-orm";
import { projects, ticketAssignees, tickets } from "../../../../db/schema";

export const WORK_SORT_COLUMNS = {
  created: tickets.createdAt,
  updated: tickets.updatedAt,
  priority: tickets.priority,
  dueDate: tickets.dueDate,
  rank: tickets.rank,
} as const;

export type WorkSortKey = keyof typeof WORK_SORT_COLUMNS;
export type SortDirection = "asc" | "desc";

export type WorkSort = {
  dir: SortDirection;
  sortKey: WorkSortKey;
  rows: SQL<unknown>[];
  carry: SQL<unknown>;
  unionOrderBy: SQL<unknown>;
};

export function resolveWorkSort(
  orderBy: WorkSortKey,
  orderDir?: SortDirection,
): WorkSort {
  const col = WORK_SORT_COLUMNS[orderBy];
  const fallback: SortDirection =
    orderBy === "created" || orderBy === "updated" ? "desc" : "asc";
  const dir: SortDirection =
    orderBy === "rank" ? "asc" : (orderDir ?? fallback);
  const orderFn = dir === "asc" ? asc : desc;
  return {
    dir,
    sortKey: orderBy,
    rows: [orderFn(col), orderFn(tickets.id)],
    carry: sql`${col} AS sort_col`,
    unionOrderBy: sql`u.sort_col ${dir === "asc" ? sql`ASC` : sql`DESC`}, u.id ${dir === "asc" ? sql`ASC` : sql`DESC`}`,
  };
}

type AssignedOrParticipatingParams = {
  orgId: string;
  userId: string;
  baseWhere: SQL<unknown> | undefined;
  carry: SQL<unknown>;
  orderBy: SQL<unknown>;
  limit: number;
  cursorPredicate?: SQL<unknown>;
  splitBranches?: SQL<unknown>[];
};

function branchSplits(splitBranches?: SQL<unknown>[]): SQL<unknown>[] {
  return splitBranches && splitBranches.length > 0
    ? splitBranches
    : [sql`true`];
}

function mineBranches(
  orgId: string,
  userId: string,
  where: SQL<unknown>,
  carry: SQL<unknown> | undefined,
  splitBranches: SQL<unknown>[] | undefined,
): SQL<unknown> {
  const carried = carry ? sql`, ${carry}` : sql``;
  const branches = branchSplits(splitBranches).flatMap((extra) => [
    sql`(SELECT ${tickets.id} AS id${carried}
       FROM ${tickets}
       INNER JOIN ${projects} ON ${projects.id} = ${tickets.projectId}
       WHERE ${where} AND ${extra} AND ${tickets.assigneeMembershipId} IN (
         SELECT id FROM organization_members WHERE org_id = ${orgId} AND user_id = ${userId}
       ))`,
    sql`(SELECT ${tickets.id} AS id${carried}
       FROM ${tickets}
       INNER JOIN ${projects} ON ${projects.id} = ${tickets.projectId}
       INNER JOIN ${ticketAssignees} ta
         ON ta.ticket_id = ${tickets.id}
        AND ta.org_id = ${orgId}
        AND ta.membership_id IN (
          SELECT id FROM organization_members WHERE org_id = ${orgId} AND user_id = ${userId}
        )
       WHERE ${where} AND ${extra})`,
  ]);
  return sql.join(branches, sql` UNION `);
}

export function assignedOrParticipatingIds(
  params: AssignedOrParticipatingParams,
): SQL<unknown> {
  const where = params.baseWhere ?? sql`true`;
  const cursorFilter = params.cursorPredicate ?? sql`true`;
  return sql`
    SELECT u.id FROM (
      ${mineBranches(params.orgId, params.userId, where, params.carry, params.splitBranches)}
    ) u
    WHERE ${cursorFilter}
    ORDER BY ${params.orderBy}
    LIMIT ${params.limit}`;
}

export function mineCountSql(
  where: SQL<unknown> | undefined,
  orgId: string,
  userId: string,
  splitBranches?: SQL<unknown>[],
): SQL<unknown> {
  const w = where ?? sql`true`;
  return sql`
    SELECT count(*) AS total FROM (
      ${mineBranches(orgId, userId, w, undefined, splitBranches)}
    ) u`;
}

export function mineCountByStatusSql(
  where: SQL<unknown> | undefined,
  orgId: string,
  userId: string,
): SQL<unknown> {
  const w = where ?? sql`true`;
  return sql`
    SELECT u.status, count(*) AS cnt FROM (
      (SELECT ${tickets.id} AS id, ${tickets.status} AS status
       FROM ${tickets}
       INNER JOIN ${projects} ON ${projects.id} = ${tickets.projectId}
       WHERE ${w} AND ${tickets.assigneeMembershipId} IN (
         SELECT id FROM organization_members WHERE org_id = ${orgId} AND user_id = ${userId}
       ))
      UNION
      (SELECT ${tickets.id} AS id, ${tickets.status} AS status
       FROM ${tickets}
       INNER JOIN ${projects} ON ${projects.id} = ${tickets.projectId}
       INNER JOIN ${ticketAssignees} ta
         ON ta.ticket_id = ${tickets.id}
        AND ta.org_id = ${orgId}
        AND ta.membership_id IN (
          SELECT id FROM organization_members WHERE org_id = ${orgId} AND user_id = ${userId}
        )
       WHERE ${w})
    ) u
    GROUP BY u.status`;
}

export function readIds(rows: Record<string, unknown>[]): number[] {
  return rows.map((row) => Number(row["id"]));
}

