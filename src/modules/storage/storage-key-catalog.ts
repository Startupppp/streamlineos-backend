import { sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";

const APP_SCHEMAS = ["public", "build", "build_events"];

export interface FileKeyColumn {
  table: string;
  column: string;
}

/**
 * Every column in the application schemas whose name ends with `_key` and
 * whose type is text/varchar — these are object-storage keys.  Derived from
 * pg_catalog so the list stays correct as new tables are added without a code
 * change.
 *
 * The caller must run this outside an RLS transaction (as the owner role or
 * with BYPASSRLS) because pg_catalog is not subject to tenant RLS and this
 * query never reads tenant data.
 */
export async function enumerateFileKeyColumns(db: Db): Promise<FileKeyColumn[]> {
  const rows = await db.execute(sql`
    SELECT
      n.nspname || '.' || c.relname AS "table",
      a.attname                     AS "column"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = ANY(${APP_SCHEMAS})
      AND c.relkind = 'r'
      AND t.typname IN ('text', 'varchar', 'bpchar')
      AND (
        a.attname LIKE '%\\_key'
        OR a.attname IN ('file_url', 'storage_url', 'document_url')
      )
    ORDER BY "table", "column"
  `);
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    table: String(r["table"]),
    column: String(r["column"]),
  }));
}

/**
 * Returns every non-null storage key stored for `orgId` across all file-key
 * columns.  Runs each table query individually — a join across 20+ tables
 * is impractical — and deduplicates.
 *
 * MUST be called as a DB role with direct table access (no RLS or BYPASSRLS).
 * Never call this inside a tenant transaction; the GUC is irrelevant here.
 */
export async function collectOrgFileKeys(
  db: Db,
  orgId: string,
  columns: FileKeyColumn[],
): Promise<string[]> {
  const keys = new Set<string>();
  for (const { table, column } of columns) {
    try {
      const rows = await db.execute(
        sql.raw(
          `SELECT "${column}" AS k FROM ${table} WHERE org_id = '${orgId.replace(/'/g, "''")}' AND "${column}" IS NOT NULL`,
        ),
      );
      for (const row of rows as Array<Record<string, unknown>>) {
        const k = row["k"];
        if (typeof k === "string" && k.length > 0) keys.add(k);
      }
    } catch {
      // Table has no org_id column or was dropped — skip silently.
    }
  }
  return [...keys];
}

/**
 * Returns every non-null storage key for rows referencing `userId` across
 * all user-scoped file-key columns.  Used by the purge-user script.
 */
export async function collectUserFileKeys(
  db: Db,
  userId: string,
  columns: FileKeyColumn[],
): Promise<string[]> {
  const keys = new Set<string>();
  for (const { table, column } of columns) {
    for (const userCol of ["user_id", "created_by", "uploaded_by", "actor_id"]) {
      try {
        const rows = await db.execute(
          sql.raw(
            `SELECT "${column}" AS k FROM ${table} WHERE "${userCol}" = '${userId.replace(/'/g, "''")}' AND "${column}" IS NOT NULL`,
          ),
        );
        for (const row of rows as Array<Record<string, unknown>>) {
          const k = row["k"];
          if (typeof k === "string" && k.length > 0) keys.add(k);
        }
      } catch {
        // Column absent on this table — skip.
      }
    }
  }
  return [...keys];
}
