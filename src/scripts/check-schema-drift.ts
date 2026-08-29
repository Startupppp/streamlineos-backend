import postgres from "postgres";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";

/**
 * What the code declares, against what the migrations actually built.
 *
 * The two are supposed to be the same thing and drift apart quietly: a column
 * added to a Drizzle table without a matching migration works on every developer
 * database that was ever `push`ed and fails on the first one built from the
 * journal. The failure surfaces a long way from the cause — a seeded e2e run
 * that dies inserting a row, naming a column nobody remembers adding.
 *
 * Reports both directions. A column the code declares and the database lacks is
 * a write that will fail in production. A column the database has and the code
 * does not declare is usually harmless and occasionally a dropped feature whose
 * migration never ran, so it is listed separately rather than ignored.
 *
 *   node --env-file=.env -r ts-node/register src/scripts/check-schema-drift.ts
 *
 * Exits non-zero when the code declares something the database has not got.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

interface Declared {
  readonly table: string;
  readonly columns: Set<string>;
}

function declaredTables(): Declared[] {
  const found: Declared[] = [];

  for (const value of Object.values(schema)) {
    // A Drizzle table is the only export `getTableConfig` accepts; everything
    // else in the barrel (enums, types, relations, helpers) throws.
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as PgTable);
    } catch {
      continue;
    }
    if (!config?.name) continue;
    // Only the default schema: `build` and `build_events` are managed apart.
    if (config.schema && config.schema !== "public") continue;

    found.push({
      table: config.name,
      columns: new Set(config.columns.map((column) => column.name)),
    });
  }

  return found;
}

async function main(): Promise<void> {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });

  try {
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `;

    const live = new Map<string, Set<string>>();
    for (const row of rows) {
      const columns = live.get(row.table_name) ?? new Set<string>();
      columns.add(row.column_name);
      live.set(row.table_name, columns);
    }

    const missingTables: string[] = [];
    const missingColumns: string[] = [];
    const undeclaredColumns: string[] = [];

    for (const declared of declaredTables()) {
      const actual = live.get(declared.table);
      if (!actual) {
        missingTables.push(declared.table);
        continue;
      }

      for (const column of declared.columns)
        if (!actual.has(column)) missingColumns.push(`${declared.table}.${column}`);

      for (const column of actual)
        if (!declared.columns.has(column)) undeclaredColumns.push(`${declared.table}.${column}`);
    }

    const report = (title: string, items: readonly string[]) => {
      console.log(`\n${title}: ${items.length}`);
      for (const item of [...items].sort()) console.log(`  ${item}`);
    };

    report("Declared tables the database has not got", missingTables);
    report("Declared columns the database has not got", missingColumns);
    report("Columns the database has that the code does not declare", undeclaredColumns);

    const breaking = missingTables.length + missingColumns.length;
    console.log(
      `\n${breaking === 0 ? "OK" : "DRIFT"} — ${breaking} declaration(s) the database cannot satisfy.`,
    );
    process.exitCode = breaking === 0 ? 0 : 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main();
