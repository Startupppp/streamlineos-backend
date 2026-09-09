import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  GLOBAL_PERSONAL_DATA_TABLES,
  PERSONAL_DATA_TABLES,
  PERSONAL_DATA_TABLE_NAMES,
} from "./personal-data-registry";

/**
 * The thing ticket 17 was missing, and the reason its gap could grow unseen.
 *
 * Erasure itself is a large piece of work with a legal answer per table. This is
 * the smaller piece that has to come first: nothing anywhere failed when a new
 * table started holding personal data, so the set of things nobody erases grew
 * every time somebody added a column, silently, and would have kept growing.
 *
 * The scan is deliberately coarse. It reads column DECLARATIONS out of
 * `db/schema` and flags any whose name denotes an identifiable person. It will
 * occasionally flag something harmless, and the answer to that is one line in
 * the registry saying so — a false positive costs an argument, a false negative
 * costs a table nobody erases.
 */
describe("every table holding personal data is registered", () => {
  const SCHEMA_ROOT = join(__dirname, "../../db/schema");

  /** A real column, not an index name — those repeat the column and are not storage. */
  const COLUMN =
    /\b\w+\s*:\s*(?:text|varchar|char|jsonb|json|timestamp|date|integer|numeric|boolean)\(\s*"([a-z0-9_]+)"/g;

  /** Column names that denote an identifiable person. */
  const PERSONAL =
    /(email|phone|mobile|whatsapp|first_name|last_name|full_name|dob|date_of_birth|address|postal|pincode|ssn|aadhaar|passport|national_id|ip_address|user_agent|gstin|pan\b|tax_number)/i;

  const TABLE = /export const \w+ = pgTable\(\s*\n?\s*"([a-z0-9_]+)"/g;

  /** Any column declaration, whatever its type — for the registry-side check. */
  const ANY_COLUMN = /\b\w+\s*:\s*\w+\(\s*"([a-z0-9_]+)"/g;

  /**
   * A table's own body, and not one character of the next table's.
   *
   * This used to be `source.slice(afterTheMatch).split("\n);")[0]`, which is
   * only correct for a table whose definition ends on a line-initial `);` — the
   * two-argument form with an index callback. The far commoner
   * `pgTable("x", { … });` ends `});`, so the split ran on until some later
   * table happened to end the other way, and every column in between was
   * attributed to the earlier table. That is how `organization_members` came to
   * be credited with `users`' email and how a phantom `address_hash` reached two
   * consent tables: 81 of 149 registry entries were column bleed.
   *
   * Balancing parentheses from `pgTable(` stops exactly where the call does.
   */
  function tableBody(source: string, matchIndex: number): string {
    const open = source.indexOf("(", matchIndex);
    if (open === -1) return "";
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      const char = source[i];
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) return source.slice(open, i);
      }
    }
    return source.slice(open);
  }

  function walk(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, found);
      else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) found.push(full);
    }
    return found;
  }

  function tablesHoldingPersonalData(): string[] {
    const found: string[] = [];
    for (const file of walk(SCHEMA_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(TABLE)) {
        const body = tableBody(source, match.index!);
        const columns = [...body.matchAll(COLUMN)].map((column) => column[1]!);
        if (columns.some((column) => PERSONAL.test(column))) found.push(match[1]!);
      }
    }
    return [...new Set(found)].sort();
  }

  it("registers every table that holds personal data", () => {
    const unregistered = tablesHoldingPersonalData().filter(
      (table) => !PERSONAL_DATA_TABLE_NAMES.has(table),
    );

    // Add it to PERSONAL_DATA_TABLES. If the column is not really personal data,
    // add it anyway with a note -- the registry is what makes the surface
    // countable, and an argument in a diff is better than a silent omission.
    expect(unregistered).toEqual([]);
  });

  it("keeps no entry for a table that no longer holds any", () => {
    const actual = new Set(tablesHoldingPersonalData());
    const stale = [...PERSONAL_DATA_TABLE_NAMES].filter((table) => !actual.has(table));

    // A register that counts tables which no longer exist overstates the problem,
    // and an overstated problem is one people stop reading.
    expect(stale).toEqual([]);
  });

  /** Every column the schema declares, per table, whatever its type. */
  function columnsByTable(): Map<string, Set<string>> {
    const byTable = new Map<string, Set<string>>();
    for (const file of walk(SCHEMA_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(TABLE)) {
        const body = tableBody(source, match.index!);
        const bucket = byTable.get(match[1]!) ?? new Set<string>();
        for (const column of body.matchAll(ANY_COLUMN)) bucket.add(column[1]!);
        byTable.set(match[1]!, bucket);
      }
    }
    return byTable;
  }

  /**
   * The direction nothing checked, and the reason a phantom column survived.
   *
   * The test above asks "does the schema hold anything the registry missed". It
   * cannot ask the opposite, so an entry naming a column no table has passed
   * silently — and an erasure built from such an entry emits SQL that fails on a
   * column that does not exist, in the one code path where failing quietly is
   * worst. 94 of 149 entries were in that state on 2026-09-09.
   */
  it("names no column the schema does not declare", () => {
    const schema = columnsByTable();
    const phantom: string[] = [];

    for (const entry of PERSONAL_DATA_TABLES) {
      const columns = schema.get(entry.table);
      // A table the scan cannot see at all is the other test's problem, not this
      // one's — reporting it here would blame the wrong thing twice.
      if (!columns) continue;
      for (const column of entry.columns)
        if (!columns.has(column)) phantom.push(`${entry.table}.${column}`);
    }

    // Either the column was renamed and the entry needs following, or it was
    // never on this table. Both are worth a diff; neither is worth an inventory
    // that quietly describes a database nobody has.
    expect(phantom).toEqual([]);
  });

  it("says how a person is scoped in every entry", () => {
    const unscoped = PERSONAL_DATA_TABLES.filter(
      (entry) => entry.columns.length === 0 || !entry.scope,
    ).map((entry) => entry.table);

    expect(unscoped).toEqual([]);
  });

  it("keeps the tables no tenant predicate reaches visible and counted", () => {
    // These are what an erasure written around organisations misses entirely.
    // The number may fall. It may not rise without somebody saying why: a new
    // global table holding personal data is the most expensive kind to add.
    expect(GLOBAL_PERSONAL_DATA_TABLES.length).toBeLessThanOrEqual(6);
    expect(GLOBAL_PERSONAL_DATA_TABLES).toContain("subject_requests");
  });
});
