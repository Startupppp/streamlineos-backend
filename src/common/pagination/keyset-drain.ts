import { logger } from "../logger/logger.service";

/** One page of a grant drain. Pages, never a cap: see the two functions below. */
export const GRANT_PAGE_SIZE = 500;

/** Sorts below every generated uuid, so the first page needs no special case. */
export const UUID_ZERO = "00000000-0000-0000-0000-000000000000";

/**
 * The one paging loop in this file. Every drain below reads `GRANT_PAGE_SIZE`
 * rows at a time and advances a keyset cursor until a page comes back short, so
 * a tenant whose rows fit inside one page still costs exactly one query, and a
 * tenant past the boundary loses nothing instead of losing the remainder.
 *
 * Termination is a property of the read, not of a counter: `readPage` filters on
 * `cursor > after` and orders by that same column, so every row of the next page
 * sorts strictly after the last row of this one. The non-advance check exists for
 * the case that invariant is broken — a projection that forgot to select the
 * cursor column, a fake that ignores the predicate — and it stops and says so
 * rather than spinning. Nothing here truncates in silence.
 */
export async function drainByKeyset<Row, Cursor>(
  firstCursor: Cursor,
  readPage: (after: Cursor) => PromiseLike<Row[]>,
  cursorOf: (row: Row) => Cursor,
): Promise<Row[]> {
  const drained: Row[] = [];
  let after = firstCursor;
  for (;;) {
    const page = await readPage(after);
    for (const row of page) drained.push(row);
    const last = page[page.length - 1];
    if (page.length < GRANT_PAGE_SIZE || last === undefined) return drained;
    const next = cursorOf(last);
    if (next === after) {
      logger.warn(
        "access: keyset drain cursor did not advance - stopping the drain",
        { rows: drained.length },
      );
      return drained;
    }
    after = next;
  }
}

export async function drainIds<T extends { id: number }>(
  pageSize: number,
  page: (cursor: number | null) => Promise<T[]>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: number | null = null;
  for (;;) {
    const rows = await page(cursor);
    all.push(...rows);
    if (rows.length < pageSize) return all;
    const last = rows[rows.length - 1];
    if (!last || last.id === cursor) return all;
    cursor = last.id;
  }
}

export async function forEachIdPage<T extends { id: number }>(
  pageSize: number,
  page: (cursor: number | null) => Promise<T[]>,
  settle: (ids: number[]) => Promise<number>,
): Promise<number> {
  let cursor: number | null = null;
  let settled = 0;
  for (;;) {
    const rows = await page(cursor);
    if (rows.length === 0) return settled;
    settled += await settle(rows.map((row) => row.id));
    if (rows.length < pageSize) return settled;
    const last = rows[rows.length - 1];
    if (!last || last.id === cursor) return settled;
    cursor = last.id;
  }
}
