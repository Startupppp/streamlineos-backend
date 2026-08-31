import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
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

export interface SubjectFileKey {
  key: string;
  table: string;
  column: string;
  source: "user-fk" | "org-id";
}

/**
 * Discovers all single-column FK columns pointing to public.users across the
 * given schemas. Catalog-driven — survives schema evolution without code
 * changes: a new table with a user FK is picked up automatically.
 */
export async function discoverUserFkColumns(
  db: Db,
  schemas: string[],
): Promise<Map<string, string[]>> {
  const rows = await db.execute(sql`
    SELECT
      n.nspname || '.' || c.relname AS "table",
      a.attname                     AS "col"
    FROM pg_constraint k
    JOIN pg_class   c  ON c.oid = k.conrelid
    JOIN pg_class   p  ON p.oid = k.confrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_namespace pn ON pn.oid = p.relnamespace
    JOIN LATERAL unnest(k.conkey) ck(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ck.attnum
    WHERE k.contype = 'f'
      AND n.nspname = ANY(${schemas})
      AND pn.nspname = 'public' AND p.relname = 'users'
      AND array_length(k.conkey, 1) = 1
  `);
  const map = new Map<string, string[]>();
  for (const row of rows as Array<Record<string, unknown>>) {
    const tbl = String(row["table"]);
    const col = String(row["col"]);
    if (!map.has(tbl)) map.set(tbl, []);
    map.get(tbl)!.push(col);
  }
  return map;
}

/**
 * Builds the per-table enumeration SQL as a Drizzle SQL object. Kept
 * separate so tests can capture and inspect the rendered SQL.
 */
export function buildSubjectKeyQuery(
  table: string,
  column: string,
  filterCol: string,
  filterValue: string | string[],
  userId: string,
  filterKind: "user-col" | "org-id",
): SQL {
  const colId = sql.raw(`"${column}"`);
  const tableId = sql.raw(table);
  const filterColId = sql.raw(`"${filterCol}"`);
  const legalHoldBlock = sql`
    AND NOT EXISTS (
      SELECT 1 FROM public.hr_legal_holds
      WHERE  subject_user_id = ${userId}
        AND  status = 'active'
        AND  deleted_at IS NULL
    )`;

  if (filterKind === "user-col") {
    return sql`
      SELECT ${colId} AS k
      FROM   ${tableId}
      WHERE  ${filterColId} = ${filterValue as string}
        AND  ${colId} IS NOT NULL
        ${legalHoldBlock}
    `;
  }
  return sql`
    SELECT ${colId} AS k
    FROM   ${tableId}
    WHERE  ${filterColId} = ANY(${filterValue as string[]})
      AND  ${colId} IS NOT NULL
      ${legalHoldBlock}
  `;
}

/**
 * Returns every non-null storage key for a data subject that is NOT under an
 * active legal hold. The hold exclusion is applied IN the SQL predicate of
 * every per-table query (NOT as a post-filter), so concurrent hold placement
 * cannot race with enumeration.
 *
 * Discovery is fully catalog-driven:
 *   - File-key columns via pg_attribute (attname LIKE '%\_key')
 *   - User-FK columns via pg_constraint → public.users (single-column FKs)
 * A new table carrying both is included automatically without code changes.
 *
 * Org-scoped fallback: tables with no direct FK to users are queried by
 * org_id using the caller's org membership list so files belonging to an org
 * the subject owned are also captured.
 */
export async function collectSubjectFileKeysWithLegalHold(
  db: Db,
  userId: string,
  orgIds: string[],
  columns: FileKeyColumn[],
  schemas: string[] = APP_SCHEMAS,
): Promise<SubjectFileKey[]> {
  const userFkMap = await discoverUserFkColumns(db, schemas);
  const seen = new Set<string>();
  const result: SubjectFileKey[] = [];

  for (const { table, column } of columns) {
    const userCols = userFkMap.get(table) ?? [];

    if (userCols.length > 0) {
      for (const userCol of userCols) {
        const q = buildSubjectKeyQuery(table, column, userCol, userId, userId, "user-col");
        for (const row of (await db.execute(q)) as Array<Record<string, unknown>>) {
          const k = row["k"];
          if (typeof k === "string" && k.length > 0 && !seen.has(k)) {
            seen.add(k);
            result.push({ key: k, table, column, source: "user-fk" });
          }
        }
      }
    } else if (orgIds.length > 0) {
      const q = buildSubjectKeyQuery(table, column, "org_id", orgIds, userId, "org-id");
      for (const row of (await db.execute(q)) as Array<Record<string, unknown>>) {
        const k = row["k"];
        if (typeof k === "string" && k.length > 0 && !seen.has(k)) {
          seen.add(k);
          result.push({ key: k, table, column, source: "org-id" });
        }
      }
    }
  }

  return result;
}
