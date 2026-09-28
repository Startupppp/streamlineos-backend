import { sql, type SQL } from "drizzle-orm";
import { tickets } from "../../../../db/schema";
import type { CursorPosition } from "../../../../common/pagination/cursor";
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
    cursorCreatedAt: string;
    cursorUpdatedAt: string;
    priority: string | null;
    dueDate: string | null;
  },
  sortKey: WorkSortKey,
): string {
  switch (sortKey) {
    case "rank":
      return row.rank ?? "";
    case "created":
      return row.cursorCreatedAt;
    case "updated":
      return row.cursorUpdatedAt;
    case "priority":
      return row.priority ?? "";
    case "dueDate":
      return row.dueDate ?? "__null__";
  }
}

export function buildCursorPredicate(
  sortKey: WorkSortKey,
  dir: SortDirection,
  position: CursorPosition,
): SQL<unknown> {
  return cursorBoundary(sql`${SORT_COLUMNS[sortKey]}`, sql`${tickets.id}`, sortKey, dir, position);
}

export function buildMineCursorPredicate(
  sortKey: WorkSortKey,
  dir: SortDirection,
  position: CursorPosition,
): SQL<unknown> {
  return cursorBoundary(sql`u.sort_col`, sql`u.id`, sortKey, dir, position);
}

function cursorBoundary(
  column: SQL<unknown>,
  idColumn: SQL<unknown>,
  sortKey: WorkSortKey,
  dir: SortDirection,
  position: CursorPosition,
): SQL<unknown> {
  const id = sql.param(Number(position.id));
  if (sortKey === "dueDate" && position.sortValue === "__null__")
    return dir === "asc"
      ? sql`(${column} IS NULL AND ${idColumn} > ${id})`
      : sql`(${column} IS NOT NULL OR (${column} IS NULL AND ${idColumn} < ${id}))`;
  if (dir === "desc")
    return sql`(${column}, ${idColumn}) < (${sql.param(position.sortValue)}, ${sql.param(Number(position.id))})`;
  const tuple = sql`(${column}, ${idColumn}) > (${sql.param(position.sortValue)}, ${sql.param(Number(position.id))})`;
  return sortKey === "dueDate" ? sql`(${tuple} OR ${column} IS NULL)` : tuple;
}
