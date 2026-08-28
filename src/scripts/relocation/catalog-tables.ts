import type { Sql } from "postgres";
import type { CatalogTenantTable } from "../../common/relocation/relocation-plan";
import type { ForeignKeyEdge } from "../../common/relocation/table-graph";

const TENANT_COLUMNS = ["org_id", "organization_id"];
const RELOCATION_SCHEMAS = ["public", "build", "build_events"];

function str(value: unknown): string {
  return String(value);
}

export async function readTenantTables(sql: Sql): Promise<readonly CatalogTenantTable[]> {
  const rows = await sql`
    SELECT n.nspname AS schema, c.relname AS "table", a.attname AS tenant_column,
           c.relkind AS kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = ANY(${RELOCATION_SCHEMAS})
      AND c.relkind IN ('r', 'p')
      AND a.attname = ANY(${TENANT_COLUMNS})
      AND format_type(a.atttypid, NULL) = 'text'
      AND NOT EXISTS (
        SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid
      )
    UNION ALL
    SELECT n.nspname AS schema, c.relname AS "table", 'id' AS tenant_column, c.relkind AS kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'organizations'
    ORDER BY 1, 2`;

  const seen = new Set<string>();
  const tables: CatalogTenantTable[] = [];
  for (const row of rows) {
    const key = `${str(row.schema)}.${str(row.table)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tables.push({
      schema: str(row.schema),
      table: str(row.table),
      tenantColumn: str(row.tenant_column),
      isPartitioned: str(row.kind) === "p",
    });
  }
  return tables;
}

export async function readForeignKeyEdges(sql: Sql): Promise<readonly ForeignKeyEdge[]> {
  const rows = await sql`
    SELECT cn.nspname AS child_schema, c.relname AS child_table,
           pn.nspname AS parent_schema, p.relname AS parent_table,
           k.condeferrable AS deferrable
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace cn ON cn.oid = c.relnamespace
    JOIN pg_class p ON p.oid = k.confrelid
    JOIN pg_namespace pn ON pn.oid = p.relnamespace
    WHERE k.contype = 'f'`;

  return rows.map((row) => ({
    childSchema: str(row.child_schema),
    childTable: str(row.child_table),
    parentSchema: str(row.parent_schema),
    parentTable: str(row.parent_table),
    deferrable: row.deferrable === true,
  }));
}

export async function readPrimaryKeyColumns(
  sql: Sql,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const rows = await sql`
    SELECT n.nspname AS schema, c.relname AS "table",
           array_agg(a.attname ORDER BY x.ord) AS columns
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN LATERAL unnest(k.conkey) WITH ORDINALITY AS x(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = x.attnum
    WHERE k.contype = 'p'
    GROUP BY n.nspname, c.relname`;

  const map = new Map<string, readonly string[]>();
  for (const row of rows) {
    const columns = Array.isArray(row.columns) ? row.columns.map((c) => str(c)) : [];
    map.set(`${str(row.schema)}.${str(row.table)}`, columns);
  }
  return map;
}

export interface CycleBreakingConstraint {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly definition: string;
}

export async function readCycleBreakers(
  sql: Sql,
  cyclic: readonly { schema: string; table: string }[],
): Promise<readonly CycleBreakingConstraint[]> {
  if (cyclic.length === 0) return [];
  const names = cyclic.map((t) => t.table);
  const rows = await sql`
    SELECT cn.nspname AS schema, c.relname AS "table", k.conname AS name,
           pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace cn ON cn.oid = c.relnamespace
    JOIN pg_class p ON p.oid = k.confrelid
    WHERE k.contype = 'f'
      AND c.relname = ANY(${names})
      AND p.relname = ANY(${names})`;

  return rows.map((row) => ({
    schema: str(row.schema),
    table: str(row.table),
    name: str(row.name),
    definition: str(row.definition),
  }));
}
