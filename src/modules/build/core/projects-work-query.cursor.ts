import { sql, type SQL } from "drizzle-orm";
import { tickets } from "../../../db/schema";
import type { CursorPosition } from "../../../common/pagination/cursor";
import type { SortDirection, WorkSortKey } from "./work-scope-union";

const SORT_COLUMNS = {
  created: tickets.createdAt,
  updated: tickets.updatedAt,
  priority: tickets.priority,
  dueDate: tickets.dueDate,
  rank: tickets.rank,
} as const;

export function serializeSortValue(
  row: {
    rank: string | null;
    createdAt: Date | null;
    updatedAt: Date | null;
    priority: string | null;
    dueDate: string | null;
  },
  sortKey: WorkSortKey,
): string {
  switch (sortKey) {
    case "rank":
      return row.rank ?? "";
    case "created":
      return row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : String(row.createdAt ?? "");
    case "updated":
      return row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : String(row.updatedAt ?? "");
    case "priority":
      return row.priority ?? "";
    case "dueDate":
      return row.dueDate ?? "";
  }
}

export function buildCursorPredicate(
  sortKey: WorkSortKey,
  dir: SortDirection,
  position: CursorPosition,
): SQL<unknown> {
  const col = SORT_COLUMNS[sortKey];
  const id = Number(position.id);
  const value =
    sortKey === "created" || sortKey === "updated"
      ? new Date(position.sortValue)
      : position.sortValue;
  return dir === "asc"
    ? sql`(${col}, ${tickets.id}) > (${sql.param(value, col)}, ${sql.param(id, tickets.id)})`
    : sql`(${col}, ${tickets.id}) < (${sql.param(value, col)}, ${sql.param(id, tickets.id)})`;
}

export function buildMineCursorPredicate(
  sortKey: WorkSortKey,
  dir: SortDirection,
  position: CursorPosition,
): SQL<unknown> {
  const id = Number(position.id);
  const value =
    sortKey === "created" || sortKey === "updated"
      ? new Date(position.sortValue).toISOString()
      : String(position.sortValue);
  return dir === "asc"
    ? sql`(u.sort_col, u.id) > (${sql.param(value)}, ${sql.param(id)})`
    : sql`(u.sort_col, u.id) < (${sql.param(value)}, ${sql.param(id)})`;
}
