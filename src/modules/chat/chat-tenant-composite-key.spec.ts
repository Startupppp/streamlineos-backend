import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../db/schema";

/**
 * Every chat table carries the composite tenant key `(org_id, id)`.
 *
 * `backend/CLAUDE.md` §3 requires it so a sibling table can declare
 * `FOREIGN KEY (org_id, x) REFERENCES t(org_id, id)` and have the tenant travel with the
 * reference instead of a bare `(id)` FK that any tenant's row satisfies. Twelve of the
 * thirteen chat tables declared it; `chat_message_reactions` was the exception, in the
 * declaration AND in the live catalog, so nothing could compositely reference a reaction row.
 *
 * The corpus is DERIVED — every `chat_*` table in the schema barrel — rather than being the
 * one table this spec was written for. A fourteenth chat table added without the key fails
 * here, which is the only version of this assertion that is worth anything.
 */

/** Measured at 299cd1009: 13 tables whose name begins `chat_`. */
const MEASURED_CHAT_TABLE_FLOOR = 13;

interface ChatTable {
  readonly name: string;
  readonly columns: ReadonlySet<string>;
  readonly compositeTenantKeys: string[][];
}

function chatTables(): ChatTable[] {
  const tables: ChatTable[] = [];
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value);
    if (!config.name.startsWith("chat_")) continue;

    const columns = new Set(config.columns.map((column) => column.name));
    // Both spellings count: `unique(...)` becomes a table constraint and
    // `uniqueIndex(...)` becomes a unique index. Either one makes `(org_id, id)`
    // a legal FK target, so reading only one of the two would report a table
    // keyless that is not.
    const fromConstraints = config.uniqueConstraints.map((constraint) =>
      constraint.columns.map((column) => column.name),
    );
    const fromIndexes = config.indexes
      .filter((index) => index.config.unique)
      .map((index) =>
        index.config.columns
          .map((column) => ("name" in column ? String(column.name) : ""))
          .filter((name) => name.length > 0),
      );

    tables.push({
      name: config.name,
      columns,
      compositeTenantKeys: [...fromConstraints, ...fromIndexes].filter(
        (cols) => cols.length === 2 && cols.includes("org_id") && cols.includes("id"),
      ),
    });
  }
  return tables.sort((a, b) => a.name.localeCompare(b.name));
}

describe("chat tenant composite keys", () => {
  it("reads every chat table out of the schema barrel", () => {
    // Anti-vacuity: a name filter that stopped matching would derive an empty corpus
    // and the assertion below would pass over nothing.
    const tables = chatTables();
    expect(tables.length).toBeGreaterThanOrEqual(MEASURED_CHAT_TABLE_FLOOR);
  });

  it("gives every chat table with an org_id and an id the composite tenant key", () => {
    const keyless = chatTables()
      .filter((table) => table.columns.has("org_id") && table.columns.has("id"))
      .filter((table) => table.compositeTenantKeys.length === 0)
      .map((table) => table.name);

    expect(keyless).toEqual([]);
  });

  it("includes chat_message_reactions in the corpus it just checked", () => {
    // The table this was written for must actually be IN the derived set — a filter
    // that quietly excluded it would make the assertion above true and meaningless.
    expect(chatTables().map((table) => table.name)).toContain(
      "chat_message_reactions",
    );
  });
});
