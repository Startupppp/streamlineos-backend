import { getTableName, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db, TenantTx } from "../../db/drizzle.types";

export const BULK_UPDATE_CHUNK = 500;

const POSTGRES_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_ ]*(\([0-9, ]+\))?(\[\])?$/;

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

function assertPostgresType(type: string): void {
  if (!POSTGRES_TYPE_PATTERN.test(type))
    throw new Error(`bulkUpdateFromValues: "${type}" is not a usable Postgres type name`);
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
 */
export async function bulkUpdateFromValues(
  executor: Db | TenantTx,
  request: BulkUpdateRequest,
): Promise<Array<string | number>> {
  if (request.columns.length === 0 && (request.touch?.length ?? 0) === 0)
    throw new Error("bulkUpdateFromValues: nothing to set");
  if (request.rows.length === 0) return [];

  assertPostgresType(request.key.type);
  for (const column of request.columns) assertPostgresType(column.type);
  assertDistinctKeys(request);

  const orgColumn = request.orgColumn ?? "org_id";
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
