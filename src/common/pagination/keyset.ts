import { BadRequestException } from "@nestjs/common";
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

function invalidCursor(): never {
  throw new BadRequestException("Invalid pagination cursor");
}

function at(position: KeysetPosition): Date {
  const date = position.sortValue instanceof Date
    ? position.sortValue
    : new Date(position.sortValue);
  return Number.isNaN(date.getTime()) ? invalidCursor() : date;
}

function numericId(position: KeysetPosition): number {
  const id = Number(position.id);
  return Number.isSafeInteger(id) && id > 0 ? id : invalidCursor();
}

function uuidId(position: KeysetPosition): string {
  const id = String(position.id);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id : invalidCursor();
}

function integerSortValue(position: KeysetPosition): number {
  const value = Number(position.sortValue);
  return Number.isSafeInteger(value) ? value : invalidCursor();
}

/**
 * Ascending keyset over an integer sort column with an integer id tie-breaker.
 *
 * A display-order column is an integer, not a timestamp, so `at()` would coerce
 * it to `Invalid Date` and reject every cursor. Zero and negative orders are
 * legitimate positions, which is why this validates differently from
 * `numericId` — an id must be positive, a sort position need not be.
 */
export function keysetAfterIntValue(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortColumn}, ${idColumn}) > (${sql.param(integerSortValue(position), sortColumn)}, ${sql.param(numericId(position), idColumn)})`;
}

// For a sort column that is already text and totally ordered with its id — a lexorank, a code — where `at()` must not coerce.
export function keysetAfterValue(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortColumn}, ${idColumn}) > (${sql.param(String(position.sortValue), sortColumn)}, ${sql.param(numericId(position), idColumn)})`;
}

export function keysetBeforeValue(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortColumn}, ${idColumn}) < (${sql.param(String(position.sortValue), sortColumn)}, ${sql.param(numericId(position), idColumn)})`;
}

export function keysetAfterId(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortColumn}, ${idColumn}) > (${sql.param(at(position), sortColumn)}, ${sql.param(numericId(position), idColumn)})`;
}

export function keysetBeforeId(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortColumn}, ${idColumn}) < (${sql.param(at(position), sortColumn)}, ${sql.param(numericId(position), idColumn)})`;
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

/** Text sort value with a UUID tie-breaker, read ascending. */
export function keysetAfterValueUuid(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortColumn}, ${idColumn}) > (${sql.param(String(position.sortValue), sortColumn)}, ${sql.param(uuidId(position), idColumn)})`;
}

/** A computed text sort expression with a numeric tie-breaker, read ascending. */
export function keysetAfterValueExpression(
  sortExpression: SQL,
  sortEncoderColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortExpression}, ${idColumn}) > (${sql.param(String(position.sortValue), sortEncoderColumn)}, ${sql.param(numericId(position), idColumn)})`;
}

/** A computed text sort expression with a text tie-breaker, read ascending. */
export function keysetAfterTextExpression(
  sortExpression: SQL,
  sortEncoderColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortExpression}, ${idColumn}) > (${sql.param(String(position.sortValue), sortEncoderColumn)}, ${sql.param(position.id, idColumn)})`;
}

/** Newest-first timestamp keyset whose tie-breaker is a PostgreSQL UUID. */
export function keysetBeforeUuid(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortColumn}, ${idColumn}) < (${sql.param(at(position), sortColumn)}, ${sql.param(uuidId(position), idColumn)})`;
}

export function keysetBeforeUuidValue(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortColumn}, ${idColumn}) < (${sql.param(String(position.sortValue), sortColumn)}, ${sql.param(uuidId(position), idColumn)})`;
}

/**
 * One column of a multi-column keyset, paired with the value to compare it to.
 *
 * A three-column sort cannot use the two-column helpers above, and it cannot
 * be flattened into one text value either: `ORDER BY date DESC, created_at
 * DESC` compares a date and a timestamp with their own collations, and a
 * concatenated string compares neither. Each term still binds through its own
 * column's encoder for the reason at the top of this file — a bare `Date`
 * reaching postgres-js as text throws only on page two.
 *
 * The value is validated by the caller through `keysetTimestamp` /
 * `keysetInteger` / `keysetTextValue`, so a hand-edited cursor is a 400 rather
 * than a driver-level 500.
 */
export interface KeysetTupleTerm {
  readonly column: PgColumn;
  readonly value: string | number | Date;
}

function tupleComparison(terms: readonly KeysetTupleTerm[], operator: SQL): SQL {
  if (terms.length < 2) invalidCursor();
  const columns = sql.join(terms.map((term) => sql`${term.column}`), sql`, `);
  const values = sql.join(
    terms.map((term) => sql.param(term.value, term.column)),
    sql`, `,
  );
  return sql`(${columns}) ${operator} (${values})`;
}

/** Everything strictly before the position, for a list read newest-first. */
export function keysetBeforeTuple(terms: readonly KeysetTupleTerm[]): SQL {
  return tupleComparison(terms, sql`<`);
}

/** Everything strictly after the position, for a list read oldest-first. */
export function keysetAfterTuple(terms: readonly KeysetTupleTerm[]): SQL {
  return tupleComparison(terms, sql`>`);
}

export function keysetTimestamp(raw: string): Date {
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? invalidCursor() : date;
}

/** Zero and negatives are legitimate sort positions; the empty string is not — `Number("")` is 0. */
export function keysetInteger(raw: string): number {
  if (raw.trim().length === 0) invalidCursor();
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : invalidCursor();
}

/** A date-as-text or an already-ordered text column; length-capped so a cursor cannot carry a payload. */
export function keysetTextValue(raw: string): string {
  return raw.length > 0 && raw.length <= 512 ? raw : invalidCursor();
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
