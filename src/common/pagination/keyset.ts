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
  readonly id: string;
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
