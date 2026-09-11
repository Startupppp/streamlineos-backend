import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { timesheets } from "../../../db/schema";

export function timeEntryCursorPredicate(cursor: string | undefined) {
  if (!cursor) return undefined;
  const position = decodeCursor(cursor);
  if (!position || !z.iso.date().safeParse(position.sortValue).success ||
      !/^[1-9]\d*$/.test(position.id) || !Number.isSafeInteger(Number(position.id)) || Number(position.id) > 2147483647)
    throw new BadRequestException("Invalid time-entry cursor");
  return sql`(${timesheets.date}, ${timesheets.id}) < (${sql.param(position.sortValue, timesheets.date)}, ${sql.param(Number(position.id), timesheets.id)})`;
}

export function timeEntryPage<T extends { id: number; date: string }>(rows: T[], total: number, limit: number, cursor?: string) {
  const page = buildCursorPage(rows, limit, (row) => ({ sortValue: row.date, id: String(row.id) }));
  return {
    items: page.data, total, pageSize: limit, totalPages: Math.ceil(total / limit),
    ...(!cursor ? { page: 1 } : {}),
    hasMore: page.pagination.hasMore, nextCursor: page.pagination.nextCursor,
  };
}
