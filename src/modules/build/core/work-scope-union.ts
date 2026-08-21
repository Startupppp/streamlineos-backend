import { asc, desc, sql, type SQL } from "drizzle-orm";
import { projects, ticketAssignees, tickets } from "../../../db/schema";

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
  return {
    dir,
    rows:
      dir === "asc"
        ? [asc(col), desc(tickets.createdAt), asc(tickets.id)]
        : [desc(col), desc(tickets.createdAt), asc(tickets.id)],
    carry: sql`${col} AS sort_col, ${tickets.createdAt} AS created_at`,
    unionOrderBy: sql`u.sort_col ${dir === "asc" ? sql`ASC` : sql`DESC`}, u.created_at DESC, u.id ASC`,
  };
}

type AssignedOrParticipatingParams = {
  orgId: string;
  userId: string;
  baseWhere: SQL<unknown> | undefined;
  carry: SQL<unknown>;
  orderBy: SQL<unknown>;
  limit: number;
  offset: number;
};

export function assignedOrParticipatingIds(
  params: AssignedOrParticipatingParams,
): SQL<unknown> {
  const where = params.baseWhere ?? sql`true`;
  return sql`
    SELECT u.id, count(*) OVER () AS total FROM (
      (SELECT ${tickets.id} AS id, ${params.carry}
       FROM ${tickets}
       INNER JOIN ${projects} ON ${projects.id} = ${tickets.projectId}
       WHERE ${where} AND ${tickets.assigneeId} = ${params.userId})
      UNION
      (SELECT ${tickets.id} AS id, ${params.carry}
       FROM ${tickets}
       INNER JOIN ${projects} ON ${projects.id} = ${tickets.projectId}
       INNER JOIN ${ticketAssignees} ta
         ON ta.ticket_id = ${tickets.id}
        AND ta.org_id = ${params.orgId}
        AND ta.user_id = ${params.userId}
       WHERE ${where})
    ) u
    ORDER BY ${params.orderBy}
    LIMIT ${params.limit} OFFSET ${params.offset}`;
}

export function readIdsAndTotal(rows: Record<string, unknown>[]): {
  ids: number[];
  total: number;
} {
  const first = rows[0];
  return {
    ids: rows.map((row) => Number(row["id"])),
    total: first ? Number(first["total"]) : 0,
  };
}
