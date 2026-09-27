import { BadRequestException } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export interface KeysetPosition {
  readonly sortValue: string | Date;
  readonly id: string | number;
}

function invalidCursor(): never {
  throw new BadRequestException("Invalid pagination cursor");
}

function at(position: KeysetPosition): Date {
  const date =
    position.sortValue instanceof Date
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  )
    ? id
    : invalidCursor();
}

function integerSortValue(position: KeysetPosition): number {
  const value = Number(position.sortValue);
  return Number.isSafeInteger(value) ? value : invalidCursor();
}

export function keysetAfterIntValue(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortColumn}, ${idColumn}) > (${sql.param(integerSortValue(position), sortColumn)}, ${sql.param(numericId(position), idColumn)})`;
}

export function keysetBeforeIntValue(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortColumn}, ${idColumn}) < (${sql.param(integerSortValue(position), sortColumn)}, ${sql.param(numericId(position), idColumn)})`;
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

export interface KeysetTupleTerm {
  readonly column: PgColumn;
  readonly value: string | number | boolean | Date;
}

function tupleComparison(
  terms: readonly KeysetTupleTerm[],
  operator: SQL,
): SQL {
  if (terms.length < 2) invalidCursor();
  const columns = sql.join(
    terms.map((term) => sql`${term.column}`),
    sql`, `,
  );
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

export function keysetBoolean(raw: string): boolean {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return invalidCursor();
}

/** A date-as-text or an already-ordered text column; length-capped so a cursor cannot carry a payload. */
export function keysetTextValue(raw: string): string {
  return raw.length > 0 && raw.length <= 512 ? raw : invalidCursor();
}

export function keysetBeforeMicros(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: { readonly sortValue: string; readonly id: number },
): SQL {
  return sql`(${sortColumn}, ${idColumn}) < (${sql.param(position.sortValue)}::timestamp, ${sql.param(position.id, idColumn)})`;
}

export function keysetAfterMicros(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: { readonly sortValue: string; readonly id: number },
): SQL {
  return sql`(${sortColumn}, ${idColumn}) > (${sql.param(position.sortValue)}::timestamp, ${sql.param(position.id, idColumn)})`;
}

export function microsecondCursorValue(column: PgColumn): SQL<string> {
  return sql<string>`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
}

export function keysetAtOrBefore(
  sortColumn: PgColumn,
  idColumn: PgColumn,
  position: KeysetPosition,
): SQL {
  return sql`(${sortColumn}, ${idColumn}) <= (${sql.param(at(position), sortColumn)}, ${sql.param(position.id, idColumn)})`;
}
