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
      name: index.config.name,
      unique: index.config.unique === true,
      partial: index.config.where !== undefined,
      columns: index.config.columns.map((column) =>
        column instanceof Object && "name" in column && typeof column.name === "string" ? column.name : "<expr>",
      ),
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
