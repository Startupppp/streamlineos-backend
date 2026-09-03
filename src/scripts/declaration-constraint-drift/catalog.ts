/**
 * Catalog shapes and the two pg_catalog reads behind
 * `check:declaration-constraint-drift`, plus the two coverage predicates that
 * keep its false-positive controls honest. Split out of the entry script under
 * CLAUDE.md §7; the entry file carries the defect narrative.
 */

export interface LiveIndex {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly unique: boolean;
  readonly primary: boolean;
  readonly partial: boolean;
  readonly predicate: string;
  readonly columns: string;
}

export interface LiveConstraint {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  /** `p` primary key · `u` unique · `f` foreign key · `c` check · `x` exclusion. */
  readonly kind: string;
  readonly columns: string;
  readonly foreignSchema: string;
  readonly foreignTable: string;
  readonly foreignColumns: string;
}

export interface DeclaredIndex {
  readonly name: string;
  readonly unique: boolean;
  readonly partial: boolean;
  readonly columns: readonly string[];
}

export interface DeclaredForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly foreignTable: string;
  readonly foreignColumns: readonly string[];
}

export interface DeclaredTable {
  readonly schema: string;
  readonly table: string;
  /** `unique()` and `uniqueIndex()` merged — control A. */
  readonly uniques: readonly DeclaredIndex[];
  readonly indexes: readonly DeclaredIndex[];
  readonly foreignKeys: readonly DeclaredForeignKey[];
  readonly checks: readonly string[];
}

export type FindingClass =
  | "integrity"
  | "performance"
  | "name-drift"
  | "partial-mismatch"
  | "undeclared";

export interface Finding {
  readonly id: string;
  readonly verdict: FindingClass;
  readonly table: string;
  readonly name: string;
  readonly detail: string;
}

export interface DriftReport {
  readonly integrity: readonly Finding[];
  readonly performance: readonly Finding[];
  readonly nameDrift: readonly Finding[];
  readonly partialMismatch: readonly Finding[];
  readonly undeclared: readonly Finding[];
  readonly comparedTables: number;
  readonly missingTables: readonly string[];
}

export const LIVE_INDEXES_QUERY = `
  SELECT n.nspname AS "schema",
         tc.relname AS "table",
         ic.relname AS "name",
         i.indisunique AS "unique",
         i.indisprimary AS "primary",
         (i.indpred IS NOT NULL) AS "partial",
         coalesce(pg_get_expr(i.indpred, i.indrelid), '') AS "predicate",
         coalesce((SELECT string_agg(CASE WHEN k.attnum = 0 THEN '<expr>' ELSE a.attname END, ',' ORDER BY k.ord)
                     FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                     LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                    WHERE k.ord <= i.indnkeyatts), '') AS "columns"
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class tc ON tc.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = tc.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'drizzle', 'pg_toast')
    AND tc.relkind IN ('r', 'p')
    AND NOT tc.relispartition
`;

/**
 * `contype` 'n' is excluded: Postgres 17 gave every NOT NULL its own
 * `pg_constraint` row, and on this schema those alone are 8,542 rows that no
 * declaration names and that the column gate already covers.
 */
export const LIVE_CONSTRAINTS_QUERY = `
  SELECT n.nspname AS "schema",
         c.relname AS "table",
         con.conname AS "name",
         con.contype AS "kind",
         coalesce((SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                     FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum), '') AS "columns",
         coalesce(fn.nspname, '') AS "foreignSchema",
         coalesce(fc.relname, '') AS "foreignTable",
         coalesce((SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                     FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                     JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum), '') AS "foreignColumns"
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_class fc ON fc.oid = con.confrelid
  LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'drizzle', 'pg_toast')
    AND c.relkind IN ('r', 'p')
    AND con.contype <> 'n'
`;

export const list = (columns: readonly string[]): string => columns.join(",");

/** Control D: a btree answers any query its key columns lead. */
export function coversAsPrefix(liveColumns: string, declaredColumns: string): boolean {
  return liveColumns === declaredColumns || liveColumns.startsWith(`${declaredColumns},`);
}

/** Control C: a wider foreign key to the same parent is strictly stronger. */
export function foreignKeyCovers(live: LiveConstraint, declared: DeclaredForeignKey): boolean {
  if (live.kind !== "f") return false;
  if (`${live.foreignSchema}.${live.foreignTable}` !== declared.foreignTable) return false;
  const liveColumns = live.columns.split(",");
  const liveForeign = live.foreignColumns.split(",");
  return (
    declared.columns.every((column) => liveColumns.includes(column)) &&
    declared.foreignColumns.every((column) => liveForeign.includes(column))
  );
}
