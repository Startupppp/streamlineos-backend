import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * One page boundary, compared the way the database can actually compare it.
 *
 * Every cursor-paginated list in this codebase walks a `(timestamp, id)` keyset,
 * because a timestamp alone is not a total order — an import writes hundreds of
 * rows in the same second, and a cursor on a non-unique column skips or repeats
 * at every page boundary.
 *
 * The reason this is a helper rather than a line repeated at each call site is
 * the parameter. Written as `sql\`(${col}, ${idCol}) < (${new Date(iso)}, ${id})\``
 * the Date reaches the driver with no type attached, and postgres-js tries to
 * serialise it as text: *"The string argument must be of type string ... Received
 * an instance of Date"*. The query is valid SQL and passes every test with a
 * mocked database; against a real one it throws, and it throws only on page two,
 * because page one has no cursor. Nine lists shipped with that defect.
 *
 * `sql.param(value, column)` binds through the column's own encoder, which is
 * also the decoder the row came back through — so the value that goes out is
 * exactly the value that came in, with no timezone reinterpretation in between.
 */
export interface KeysetPosition {
  readonly sortValue: string | Date;
  /**
   * `number` for the tables whose primary key is `serial`/`identity` — the
   * inventory ledger and its audit trail among them. A numeric id handed over as
   * a string reaches the driver as text and the row-value comparison then
   * depends on Postgres inferring the type back, which is a silent correctness
   * risk on the one predicate that decides whether a page skips a row.
   */
  readonly id: string | number;
}

function at(position: KeysetPosition): Date {
  return position.sortValue instanceof Date ? position.sortValue : new Date(position.sortValue);
}

/** Everything strictly after the position, for a list read oldest-first. */
export function keysetAfter(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortColumn}, ${idColumn}) > (${sql.param(at(position), sortColumn)}, ${sql.param(position.id, idColumn)})`;
}

/** Everything strictly before the position, for a list read newest-first. */
export function keysetBefore(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortColumn}, ${idColumn}) < (${sql.param(at(position), sortColumn)}, ${sql.param(position.id, idColumn)})`;
}

/**
 * Everything strictly before the position, for a boundary carried at the
 * column's own precision rather than through a JavaScript `Date`.
 *
 * The bound above loses microseconds, and on a busy append-only table that
 * silently drops rows. `timestamp` in Postgres stores microseconds; a JS `Date`
 * holds milliseconds, and postgres-js has already truncated by the time drizzle
 * maps the row. So a cursor built from `row.createdAt.toISOString()` names an
 * instant up to 999µs EARLIER than the row it is supposed to point at, and every
 * row that falls in that gap fails `<` and never appears on any page. Nothing
 * detects it: the page is full, the ids are unique, the walk terminates — rows
 * are simply missing from the middle. On the inventory ledger, where a bulk
 * import posts thousands of movements inside one second, that gap has rows in it.
 *
 * A caller using this projects the boundary column as text at full precision —
 * `to_char(col, 'YYYY-MM-DD"T"HH24:MI:SS.US')` — and hands the result straight
 * back. It is bound through `sql.param` as text and cast in SQL; it is never
 * rebuilt as a `Date`, because rebuilding is the truncation. Decode the cursor with
 * `decodeTimestampCursor`, which is what checks the text is a timestamp at all:
 * an unvalidated one would reach Postgres and come back as a 500 rather than as
 * page one.
 */
export function keysetBeforeMicros(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: { readonly sortValue: string; readonly id: number },
): SQL {
  return sql`(${sortColumn}, ${idColumn}) < (${sql.param(position.sortValue)}::timestamp, ${sql.param(position.id, idColumn)})`;
}

/**
 * The boundary column projected as text at full precision, which is the half of
 * `keysetBeforeMicros` that has to happen in the SELECT. Reading the same column
 * twice costs nothing — it is already on the heap tuple — and it is the only way
 * to get the microseconds past a driver that hands back a `Date`.
 */
export function microsecondCursorValue(column: PgColumn): SQL<string> {
  return sql<string>`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
}

/**
 * Everything up to and including the position, newest-first.
 *
 * `<=` rather than `<` because the anchor is part of the window rather than the
 * page before it: the thread a message belongs to includes that message. It is
 * the same tuple bound the same way, and it lives here rather than at its call
 * site for the reason in this file's header — an inclusive bound written inline
 * reaches the driver as a bare `Date` just as readily as an exclusive one, and
 * that is how it was written in `AutonomyService.loadThread` until the ingress
 * path was first driven against a real database.
 */
export function keysetAtOrBefore(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortColumn}, ${idColumn}) <= (${sql.param(at(position), sortColumn)}, ${sql.param(position.id, idColumn)})`;
}
