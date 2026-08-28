import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Sql } from "postgres";
import { tableDigestSql } from "../../common/relocation/relocation-checksum";
import type { TablePlanEntry } from "../../common/relocation/relocation-plan";

export type SqlExecutor = Pick<Sql, "unsafe">;

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualify(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

export function sqlLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("a SQL literal cannot contain a null byte");
  return `'${value.replace(/'/g, "''")}'`;
}

function keylessDigestSql(entry: TablePlanEntry, orgId: string): string {
  return (
    `SELECT coalesce(md5(string_agg(d, '' ORDER BY d)), 'empty') AS digest ` +
    `FROM (SELECT md5(x::text) AS d FROM ${qualify(entry.schema, entry.table)} x ` +
    `WHERE ${quoteIdent(entry.tenantColumn)} = ${sqlLiteral(orgId)}) s`
  );
}

export function digestSqlFor(
  entry: TablePlanEntry,
  orgId: string,
  primaryKeyColumns: readonly string[],
): string {
  if (primaryKeyColumns.length === 0) return keylessDigestSql(entry, orgId);
  return tableDigestSql(entry.schema, entry.table, entry.tenantColumn, orgId, primaryKeyColumns);
}

export function countSqlFor(entry: TablePlanEntry, orgId: string): string {
  return (
    `SELECT count(*)::int AS rows FROM ${qualify(entry.schema, entry.table)} ` +
    `WHERE ${quoteIdent(entry.tenantColumn)} = ${sqlLiteral(orgId)}`
  );
}

export interface TableSlice {
  readonly rows: number;
  readonly digest: string;
  readonly payload: Buffer;
}

export async function readSlice(
  sql: SqlExecutor,
  entry: TablePlanEntry,
  orgId: string,
  primaryKeyColumns: readonly string[],
): Promise<TableSlice> {
  const countRows = await sql.unsafe(countSqlFor(entry, orgId));
  const rows = Number(countRows[0]?.rows ?? 0);

  const digestRows = await sql.unsafe(digestSqlFor(entry, orgId, primaryKeyColumns));
  const rawDigest = digestRows[0]?.digest;
  const digest = rawDigest === null || rawDigest === undefined ? "empty" : String(rawDigest);

  if (rows === 0) return { rows: 0, digest, payload: Buffer.alloc(0) };

  const copyQuery =
    `COPY (SELECT * FROM ${qualify(entry.schema, entry.table)} ` +
    `WHERE ${quoteIdent(entry.tenantColumn)} = ${sqlLiteral(orgId)}) TO STDOUT`;
  const chunks: Buffer[] = [];
  const query = sql.unsafe(copyQuery);
  const readable = await query.readable();
  for await (const chunk of readable) chunks.push(Buffer.from(chunk));
  await query;

  return { rows, digest, payload: Buffer.concat(chunks) };
}

export async function writeSlice(
  sql: SqlExecutor,
  entry: TablePlanEntry,
  payload: Buffer,
): Promise<void> {
  if (payload.length === 0) return;
  const query = sql.unsafe(`COPY ${qualify(entry.schema, entry.table)} FROM STDIN`);
  const writable = await query.writable();
  await Promise.all([pipeline(Readable.from([payload]), writable), query]);
}

export async function deleteSlice(
  sql: SqlExecutor,
  entry: TablePlanEntry,
  orgId: string,
): Promise<number> {
  const rows = await sql.unsafe(
    `DELETE FROM ${qualify(entry.schema, entry.table)} ` +
      `WHERE ${quoteIdent(entry.tenantColumn)} = ${sqlLiteral(orgId)}`,
  );
  return rows.count ?? 0;
}

export async function readDigest(
  sql: SqlExecutor,
  entry: TablePlanEntry,
  orgId: string,
  primaryKeyColumns: readonly string[],
): Promise<{ rows: number; digest: string }> {
  const countRows = await sql.unsafe(countSqlFor(entry, orgId));
  const digestRows = await sql.unsafe(digestSqlFor(entry, orgId, primaryKeyColumns));
  const rawDigest = digestRows[0]?.digest;
  return {
    rows: Number(countRows[0]?.rows ?? 0),
    digest: rawDigest === null || rawDigest === undefined ? "empty" : String(rawDigest),
  };
}
