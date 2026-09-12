/**
 * The DECLARED half: walk the Drizzle barrel and read every unique constraint,
 * unique index, plain index, foreign key and check the schema states.
 *
 * `unique()` and `uniqueIndex()` are merged into one `uniques` population here
 * rather than at the comparison, because Postgres implements both with a unique
 * index and only one of them leaves a `pg_constraint` row.
 */

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import type { DeclaredIndex, DeclaredTable } from "./catalog";

/**
 * The column an index entry names, seeing through an ordering wrapper only.
 *
 * `index(...).on(table.createdAt.desc())` hands drizzle an SQL wrapper rather
 * than a column, and reading only `.name` rendered it `<expr>`. The live side
 * emits `<expr>` only for a genuine expression column (`attnum = 0`), so seven
 * inventory indexes that exist exactly as declared were reported missing —
 * every one declared with a `desc()`.
 *
 * The unwrapping is deliberately narrow: exactly one column chunk, and every
 * other chunk empty or an ordering keyword. A real expression such as
 * `lower(name)` also carries a column chunk, and returning that column's name
 * would invert the bug — the live side says `<expr>` there, and a declaration
 * claiming the bare column would report a mismatch on an index that matches.
 */
function indexColumnName(column: unknown): string {
  if (column instanceof Object && "name" in column && typeof (column as { name: unknown }).name === "string")
    return (column as { name: string }).name;
  const chunks = (column as { queryChunks?: readonly unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return "<expr>";
  let name: string | null = null;
  for (const chunk of chunks) {
    if (chunk instanceof Object && "name" in chunk && typeof (chunk as { name: unknown }).name === "string") {
      if (name !== null) return "<expr>";
      name = (chunk as { name: string }).name;
      continue;
    }
    const raw = chunk instanceof Object && "value" in chunk ? (chunk as { value: unknown }).value : chunk;
    const text = Array.isArray(raw) ? raw.join("") : typeof raw === "string" ? raw : null;
    if (text === null) return "<expr>";
    if (!/^\s*(asc|desc)?(\s+nulls\s+(first|last))?\s*$/i.test(text)) return "<expr>";
  }
  return name ?? "<expr>";
}

export function declaredTablesOf(barrel: Readonly<Record<string, unknown>>): DeclaredTable[] {
  const out: DeclaredTable[] = [];
  const seen = new Set<string>();
  for (const exported of Object.values(barrel)) {
    if (!(exported instanceof PgTable)) continue;
    const config = getTableConfig(exported);
    const key = `${config.schema ?? "public"}.${config.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const declaredIndexes: DeclaredIndex[] = config.indexes.map((index) => ({
      name: index.config.name ?? "",
      unique: index.config.unique === true,
      partial: index.config.where !== undefined,
      columns: index.config.columns.map(indexColumnName),
    }));
    out.push({
      schema: config.schema ?? "public",
      table: config.name,
      uniques: [
        ...config.uniqueConstraints.map((constraint) => ({
          name: constraint.name ?? "",
          unique: true,
          partial: false,
          columns: constraint.columns.map((column) => column.name),
        })),
        ...declaredIndexes.filter((index) => index.unique),
      ],
      indexes: declaredIndexes.filter((index) => !index.unique),
      foreignKeys: config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        const target = getTableConfig(reference.foreignTable);
        return {
          name: foreignKey.getName(),
          columns: reference.columns.map((column) => column.name),
          foreignTable: `${target.schema ?? "public"}.${target.name}`,
          foreignColumns: reference.foreignColumns.map((column) => column.name),
        };
      }),
      checks: config.checks.map((check) => check.name),
    });
  }
  return out.sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`));
}

export function countDeclaredObjects(tables: readonly DeclaredTable[]): number {
  return tables.reduce(
    (sum, table) =>
      sum + table.uniques.length + table.indexes.length + table.foreignKeys.length + table.checks.length,
    0,
  );
}
