import { getTableColumns, getTableName, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db, TenantTx } from "../../db/drizzle.types";

export const BULK_UPDATE_CHUNK = 500;

const POSTGRES_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_ ]*(\([0-9, ]+\))?(\[\])?$/;

/**
 * The only cast targets admitted on top of the ones the target table declares
 * for itself. A `serial` key column is cast as `integer` and a `numeric(18, 4)`
 * amount as `numeric`, so the schema's own spelling is necessary but not
 * sufficient — this list is the rest, and it is closed.
 */
const BASE_CAST_TYPES: ReadonlySet<string> = new Set([
  "bigint",
  "boolean",
  "bytea",
  "char",
  "date",
  "decimal",
  "double precision",
  "inet",
  "integer",
  "interval",
  "json",
  "jsonb",
  "numeric",
  "real",
  "smallint",
  "text",
  "time",
  "timestamp",
  "timestamp with time zone",
  "timestamp without time zone",
  "timestamptz",
  "uuid",
  "varchar",
]);

export interface BulkUpdateColumn {
  readonly column: string;
  readonly type: string;
}

export interface BulkUpdateRow {
  readonly key: string | number;
  readonly values: readonly unknown[];
}

export interface BulkUpdateRequest {
  readonly table: PgTable;
  readonly orgId: string;
  readonly key: BulkUpdateColumn;
  readonly columns: readonly BulkUpdateColumn[];
  readonly rows: readonly BulkUpdateRow[];
  readonly touch?: readonly string[];
  readonly extraWhere?: SQL;
  readonly orgColumn?: string;
  readonly chunkSize?: number;
}

/**
 * Everything this builder puts into SQL text rather than a bind parameter is
 * confined here, against the target table's own Drizzle declaration.
 *
 * Two shapes reach the statement as text. Column names go through
 * `sql.identifier`, which quote-doubles, so they cannot break out — but an
 * unchecked name is still a mass-assignment surface, and `orgColumn` decides
 * which column the tenant predicate compares, so a wrong one silently produces
 * a statement that is no longer tenant-correlated. Cast type names go through
 * `sql.raw`, which is verbatim. Both are therefore reduced to a finite set
 * derived from the schema at import time, not from anything a request carries.
 */
interface IdentifierScope {
  readonly columnNames: ReadonlySet<string>;
  readonly castTypes: ReadonlySet<string>;
}

function scopeFor(table: PgTable): IdentifierScope {
  const columnNames = new Set<string>();
  const castTypes = new Set<string>(BASE_CAST_TYPES);
  for (const column of Object.values(getTableColumns(table))) {
    columnNames.add(column.name);
    const declared = column.getSQLType();
    castTypes.add(declared);
    castTypes.add(`${declared}[]`);
  }
  for (const base of BASE_CAST_TYPES) castTypes.add(`${base}[]`);
  return { columnNames, castTypes };
}

function assertPostgresType(type: string, scope: IdentifierScope, table: PgTable): void {
  if (!POSTGRES_TYPE_PATTERN.test(type))
    throw new Error(`bulkUpdateFromValues: "${type}" is not a usable Postgres type name`);
  if (!scope.castTypes.has(type))
    throw new Error(
      `bulkUpdateFromValues: "${type}" is not a cast type ${getTableName(table)} declares, ` +
        "and is not one of the base Postgres types. This cast is emitted as raw SQL text, " +
        "so it may only ever be a name the schema itself carries.",
    );
}

function assertKnownColumn(
  name: string,
  role: string,
  scope: IdentifierScope,
  table: PgTable,
): void {
  if (!scope.columnNames.has(name))
    throw new Error(
      `bulkUpdateFromValues: ${role} "${name}" is not a column of ${getTableName(table)}. ` +
        "Every identifier this builder emits has to be a column the Drizzle schema declares — " +
        "a name that came from anywhere else is a write to a column the caller never named.",
    );
}

function assertDistinctKeys(request: BulkUpdateRequest): void {
  const seen = new Set<string>();
  for (const row of request.rows) {
    const fingerprint = String(row.key);
    if (seen.has(fingerprint))
      throw new Error(
        `bulkUpdateFromValues: ${getTableName(request.table)} key ${fingerprint} appears twice. ` +
          "A repeated key joins the target row twice and Postgres applies one arbitrary row " +
          "while silently discarding the rest — collapse the rows before calling.",
      );
    seen.add(fingerprint);
    if (row.values.length !== request.columns.length)
      throw new Error(
        `bulkUpdateFromValues: ${getTableName(request.table)} key ${fingerprint} carries ` +
          `${row.values.length} value(s) for ${request.columns.length} column(s)`,
      );
  }
}

function buildTuple(row: BulkUpdateRow, request: BulkUpdateRequest): SQL {
  const cells: SQL[] = [sql`${row.key}::${sql.raw(request.key.type)}`];
  request.columns.forEach((column, index) => {
    cells.push(sql`${row.values[index] ?? null}::${sql.raw(column.type)}`);
  });
  return sql`(${sql.join(cells, sql`, `)})`;
}

/**
 * One `UPDATE … FROM (VALUES …)` for a set of rows that each carry a *different*
 * value, chunked under {@link BULK_UPDATE_CHUNK}.
 *
 * `inArray` only batches an identical `SET`. Where the new value differs per row
 * the repo's fallback was one statement per row, which is the shape §5.1 calls a
 * bulk-write defect. Every value is explicitly cast because a bare `VALUES` list
 * types its columns from the first row and would otherwise resolve to `text`.
 *
 * The tenant predicate is not optional: the join key alone is a surrogate id, so
 * `org_id` has to be in the `WHERE` for the statement to stay tenant-correlated
 * even where RLS would also catch it. `extraWhere` carries a caller's own
 * compare-and-set guard, which a per-row update would otherwise lose.
 *
 * Returns the keys the database actually updated, which is how a caller detects
 * that a row vanished or belongs to another tenant.
 *
 * Every identifier and cast name is checked against `request.table`'s own
 * Drizzle columns before a single character of SQL is built, so the text half of
 * this statement is provably a finite, compile-time set. Values are never in
 * that half — they are bind parameters throughout.
 */
export async function bulkUpdateFromValues(
  executor: Db | TenantTx,
  request: BulkUpdateRequest,
): Promise<Array<string | number>> {
  if (request.columns.length === 0 && (request.touch?.length ?? 0) === 0)
    throw new Error("bulkUpdateFromValues: nothing to set");
  if (request.rows.length === 0) return [];

  const scope = scopeFor(request.table);
  const orgColumn = request.orgColumn ?? "org_id";

  assertPostgresType(request.key.type, scope, request.table);
  assertKnownColumn(request.key.column, "key column", scope, request.table);
  assertKnownColumn(orgColumn, "tenant column", scope, request.table);
  for (const column of request.columns) {
    assertPostgresType(column.type, scope, request.table);
    assertKnownColumn(column.column, "set column", scope, request.table);
  }
  for (const column of request.touch ?? [])
    assertKnownColumn(column, "touch column", scope, request.table);
  assertDistinctKeys(request);

  const chunkSize = request.chunkSize ?? BULK_UPDATE_CHUNK;

  const assignments: SQL[] = request.columns.map(
    (column) => sql`${sql.identifier(column.column)} = v.${sql.identifier(column.column)}`,
  );
  for (const column of request.touch ?? [])
    assignments.push(sql`${sql.identifier(column)} = now()`);

  const tableName = sql.identifier(getTableName(request.table));
  const keyColumn = sql`${tableName}.${sql.identifier(request.key.column)}`;
  const orgIdColumn = sql`${tableName}.${sql.identifier(orgColumn)}`;

  const aliasColumns = sql.join(
    [request.key, ...request.columns].map((column) => sql.identifier(column.column)),
    sql`, `,
  );

  const updated: Array<string | number> = [];
  for (let offset = 0; offset < request.rows.length; offset += chunkSize) {
    const chunk = request.rows.slice(offset, offset + chunkSize);
    const tuples = sql.join(
      chunk.map((row) => buildTuple(row, request)),
      sql`, `,
    );
    const affected = await executor.execute<{ key: string | number }>(sql`
      UPDATE ${request.table}
      SET ${sql.join(assignments, sql`, `)}
      FROM (VALUES ${tuples}) AS v(${aliasColumns})
      WHERE ${keyColumn} = v.${sql.identifier(request.key.column)}
        AND ${orgIdColumn} = ${request.orgId}
        ${request.extraWhere ? sql`AND ${request.extraWhere}` : sql``}
      RETURNING ${keyColumn} AS "key"
    `);
    for (const row of affected) updated.push(row.key);
  }
  return updated;
}
