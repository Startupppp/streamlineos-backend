import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";

const APP_SCHEMAS = ["public", "build", "build_events"];

export interface FileKeyColumn {
  table: string;
  column: string;
}

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
  return rows.map((r) => ({
    table: String(r["table"]),
    column: String(r["column"]),
  }));
}

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
      for (const row of rows) {
        const k = row["k"];
        if (typeof k === "string" && k.length > 0) keys.add(k);
      }
    } catch {
    }
  }
  return [...keys];
}

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
        for (const row of rows) {
          const k = row["k"];
          if (typeof k === "string" && k.length > 0) keys.add(k);
        }
      } catch {
      }
    }
  }
  return [...keys];
}

export const SUBJECT_KEY_PAGE_LIMIT = 5_000;

export interface SubjectFileKey {
  key: string;
  table: string;
  column: string;
  source: "user-fk" | "org-id";
  orgId: string | null;
}

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
  for (const row of rows) {
    const tbl = String(row["table"]);
    const col = String(row["col"]);
    const existing = map.get(tbl);
    if (existing) existing.push(col);
    else map.set(tbl, [col]);
  }
  return map;
}

async function discoverOrgIdTables(db: Db, schemas: string[]): Promise<Set<string>> {
  const rows = await db.execute(sql`
    SELECT n.nspname || '.' || c.relname AS "table"
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    JOIN   pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE  n.nspname = ANY(${schemas})
      AND  c.relkind = 'r'
      ${sql.raw("AND  a.attname = 'org_id'")}
  `);
  return new Set(rows.map((r) => String(r["table"])));
}

export function buildSubjectKeyQuery(
  table: string,
  column: string,
  filterCol: string,
  filterValue: string | string[],
  userId: string,
  filterKind: "user-col" | "org-id",
  hasOrgId: boolean,
  afterKey?: string,
): SQL {
  const colId = sql.raw(`"${column}"`);
  const tableId = sql.raw(table);
  const filterColId = sql.raw(`"${filterCol}"`);
  const afterClause = afterKey === undefined ? sql`` : sql` AND ${colId} > ${afterKey}`;
  const orgIdSelect = hasOrgId ? sql.raw(", org_id AS key_org_id") : sql``;
  const orderClause = sql.raw(`ORDER BY "${column}" ASC`);
  const legalHoldBlock = sql`
    AND NOT EXISTS (
      SELECT 1 FROM public.hr_legal_holds
      WHERE  subject_user_id = ${userId}
        AND  status = 'active'
        AND  deleted_at IS NULL
    )`;
  const limitClause = sql.raw(`LIMIT ${SUBJECT_KEY_PAGE_LIMIT}`);

  if (filterKind === "user-col") {
    return sql`
      SELECT ${colId} AS k${orgIdSelect}
      FROM   ${tableId}
      WHERE  ${filterColId} = ${filterValue as string}
        AND  ${colId} IS NOT NULL
        ${afterClause}
        ${legalHoldBlock}
      ${orderClause}
      ${limitClause}
    `;
  }
  return sql`
    SELECT ${colId} AS k${orgIdSelect}
    FROM   ${tableId}
    WHERE  ${filterColId} = ANY(${filterValue as string[]})
      AND  ${colId} IS NOT NULL
      ${afterClause}
      ${legalHoldBlock}
    ${orderClause}
    ${limitClause}
  `;
}

async function drainPages(
  db: Db,
  table: string,
  column: string,
  filterCol: string,
  filterValue: string | string[],
  userId: string,
  source: "user-fk" | "org-id",
  hasOrgId: boolean,
  seen: Set<string>,
  result: SubjectFileKey[],
): Promise<void> {
  const filterKind = source === "user-fk" ? "user-col" : "org-id";
  let afterKey: string | undefined;

  for (;;) {
    const q = buildSubjectKeyQuery(
      table, column, filterCol, filterValue, userId, filterKind, hasOrgId, afterKey,
    );
    const rows = await db.execute(q);
    let lastKey: string | undefined;

    for (const row of rows) {
      const k = row["k"];
      if (typeof k !== "string" || k.length === 0) continue;
      lastKey = k;
      if (seen.has(k)) continue;
      seen.add(k);
      const rawOrgId = row["key_org_id"];
      const orgId =
        hasOrgId && typeof rawOrgId === "string" && rawOrgId.length > 0
          ? rawOrgId
          : null;
      result.push({ key: k, table, column, source, orgId });
    }

    if (rows.length < SUBJECT_KEY_PAGE_LIMIT || lastKey === undefined) return;
    afterKey = lastKey;
  }
}

export async function collectSubjectFileKeysWithLegalHold(
  db: Db,
  userId: string,
  orgIds: string[],
  columns: FileKeyColumn[],
  schemas: string[] = APP_SCHEMAS,
): Promise<SubjectFileKey[]> {
  const userFkMap = await discoverUserFkColumns(db, schemas);
  const orgIdTables = await discoverOrgIdTables(db, schemas);
  const seen = new Set<string>();
  const result: SubjectFileKey[] = [];

  for (const { table, column } of columns) {
    const userCols = userFkMap.get(table) ?? [];

    if (userCols.length > 0) {
      const hasOrgId = orgIdTables.has(table);
      for (const userCol of userCols) {
        await drainPages(
          db, table, column, userCol, userId, userId, "user-fk", hasOrgId, seen, result,
        );
      }
    } else if (orgIds.length > 0) {
      await drainPages(
        db, table, column, "org_id", orgIds, userId, "org-id", true, seen, result,
      );
    }
  }

  return result;
}
