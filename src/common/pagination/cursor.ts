/**
 * Keyset pagination.
 *
 * Offset pagination re-reads and discards every row before the page, so it gets
 * slower the deeper you go, and a row inserted mid-scroll shifts everything down
 * so the reader sees a duplicate or misses a record. Both matter for a list that
 * a background agent is writing to while a human scrolls it.
 *
 * The cursor is opaque on purpose: it encodes a position in a specific sort
 * order, and a caller that unpacks and edits it would be constructing a
 * predicate the server never validated.
 */

export interface CursorPosition {
  /** The sort column's value at the last row of the previous page. */
  readonly sortValue: string;
  /** The tie-breaker, so a shared sort value still yields a total order. */
  readonly id: string;
}

const SEPARATOR = "\u0000";

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(`${position.sortValue}${SEPARATOR}${position.id}`, "utf8").toString(
    "base64url",
  );
}

/**
 * Returns null for anything malformed rather than throwing. A stale or hand-edited
 * cursor is a client problem, and the useful response is the first page, not a 500.
 */
export function decodeCursor(cursor: string | undefined | null): CursorPosition | null {
  if (typeof cursor !== "string" || cursor.length === 0) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const separator = decoded.indexOf(SEPARATOR);
  if (separator <= 0) return null;

  const sortValue = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!sortValue || !id) return null;

  return { sortValue, id };
}

/**
 * The same opaque encoding for a sort of more than two columns.
 *
 * A `(sortValue, id)` cursor is only a total order when the sort really is two
 * columns. `ORDER BY date DESC, created_at DESC` with a serial tie-breaker is
 * three, and squeezing it into two — by dropping a column or by concatenating
 * two into one string — either skips rows at a page boundary or compares text
 * where the database compares a timestamp. `arity` is checked on decode so a
 * cursor minted for one sort cannot be replayed against a different one.
 */
export function encodeTupleCursor(parts: readonly string[]): string {
  return Buffer.from(parts.join(SEPARATOR), "utf8").toString("base64url");
}

export function decodeTupleCursor(
  cursor: string | undefined | null,
  arity: number,
): string[] | null {
  if (typeof cursor !== "string" || cursor.length === 0) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const parts = decoded.split(SEPARATOR);
  if (parts.length !== arity) return null;
  if (parts.some((part) => part.length === 0)) return null;

  return parts;
}

export interface CursorPage<T> {
  readonly data: T[];
  readonly pagination: {
    readonly limit: number;
    /** Absent when this is the last page. */
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  };
}

/**
 * Trims the over-fetched sentinel row and reports the last row still in the page.
 *
 * Callers ask for `limit + 1` rows: the presence of that extra row is how you
 * know there is a next page without a second count query, which on a large
 * tenant is the expensive part. The next cursor must come from the last row the
 * caller *keeps*, never from the sentinel — pointing at the discarded row makes
 * an exclusive bound skip it permanently, which is the defect c13-05 was raised
 * for and which chat carried at three call sites.
 */
function trimSentinel<T>(rows: T[], limit: number): { data: T[]; hasMore: boolean; last: T | undefined } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return { data, hasMore, last: data[data.length - 1] };
}

export function buildCursorPage<T>(
  rows: T[],
  limit: number,
  toPosition: (row: T) => CursorPosition,
): CursorPage<T> {
  const { data, hasMore, last } = trimSentinel(rows, limit);

  return {
    data,
    pagination: {
      limit,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor(toPosition(last)) : null,
    },
  };
}

export function buildTupleCursorPage<T>(
  rows: T[],
  limit: number,
  toParts: (row: T) => readonly string[],
): CursorPage<T> {
  const { data, hasMore, last } = trimSentinel(rows, limit);

  return {
    data,
    pagination: {
      limit,
      hasMore,
      nextCursor: hasMore && last ? encodeTupleCursor(toParts(last)) : null,
    },
  };
}

export interface IdCursorPage<T> {
  readonly data: T[];
  readonly hasMore: boolean;
  readonly nextCursor: number | null;
}

/**
 * The same sentinel algorithm for a list keyed on a monotonic integer id.
 *
 * An identity primary key is already a total order, so it needs no `(sortValue,
 * id)` tuple and no opaque encoding — the id *is* the position. Chat, thread
 * replies and saved messages page this way and each had its own copy of the trim
 * step; sharing the step is what stops the sentinel bug coming back one call site
 * at a time.
 */
export function buildIdCursorPage<T>(
  rows: T[],
  limit: number,
  toId: (row: T) => number,
): IdCursorPage<T> {
  const { data, hasMore, last } = trimSentinel(rows, limit);
  return { data, hasMore, nextCursor: hasMore && last ? toId(last) : null };
}
