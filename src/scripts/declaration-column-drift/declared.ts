/**
 * The DECLARED half: walk the Drizzle barrel and read the column names each
 * table states. Split out of the entry script under CLAUDE.md §7; the entry
 * file carries the defect narrative.
 *
 * A `PgView` is recorded in `seen` and never emitted as a declared table — the
 * live half reads `relkind IN ('r','p')`, so a view has no counterpart there
 * and every column it declares would read as missing.
 */

import { getTableConfig, getViewConfig, PgTable, PgView } from "drizzle-orm/pg-core";

export interface DeclaredTable {
  readonly schema: string;
  readonly table: string;
  readonly columns: ReadonlySet<string>;
}

export function declaredTablesOf(barrel: Record<string, unknown>): DeclaredTable[] {
  const out: DeclaredTable[] = [];
  const seen = new Set<string>();
  for (const exported of Object.values(barrel)) {
    if (exported instanceof PgView) {
      const view = getViewConfig(exported);
      seen.add(`${view.schema ?? "public"}.${view.name}`);
      continue;
    }
    if (!(exported instanceof PgTable)) continue;
    const config = getTableConfig(exported);
    const key = `${config.schema ?? "public"}.${config.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      schema: config.schema ?? "public",
      table: config.name,
      columns: new Set(config.columns.map((column) => column.name)),
    });
  }
  return out.sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`));
}

export function countDeclaredColumns(tables: readonly DeclaredTable[]): number {
  return tables.reduce((sum, table) => sum + table.columns.size, 0);
}
