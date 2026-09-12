import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * NEO-15 - every `inv_*` table is reachable, or is named here with a reason.
 *
 * The sibling of `inventory-reachability.spec.ts`, one level down. That one asks
 * whether a *module* has a caller; this asks whether a *table* does. Both exist
 * because this programme's recurring failure is the gap between committed and
 * reachable, and a table nothing reads is the quietest version of it: it costs
 * nothing at runtime, it survives every review, and it makes the schema
 * gradually stop describing the product.
 *
 * ## What counts as reachable
 *
 * A reference to the Drizzle export or to the raw table name from a
 * non-test file under `src/modules/`. Tests are excluded deliberately: a table
 * whose only reader is a spec asserting the table exists is the exact case this
 * check is for, and letting the spec count would make the check agree with the
 * defect.
 *
 * ## What this does NOT do
 *
 * It does not drop anything, and neither did NEO-15. The work order's bar for a
 * drop is a dependency manifest, **zero live rows or a proven archive**, a
 * ratchet, and an entry in the handoff. This session could gather the first and
 * the third; the second needs a row count against a live database, which is not
 * something a code change can assert. Default is keep, and one table is parked
 * below with exactly what it is waiting on.
 */

const SCHEMA_ROOT = join(__dirname, "..", "..", "..", "db", "schema");
const MODULES_ROOT = join(__dirname, "..", "..");

/**
 * Tables with no reader, and why they are still here.
 *
 * A name and a sentence, never a bare list: an exemption nobody can read is how a
 * check stops checking, which is the argument `inventory-reachability.spec.ts`
 * makes for its own exemptions and the reason both files carry them this way.
 */
const UNREAD_TABLES: ReadonlyArray<{ table: string; reason: string }> = [
  // Empty, and that is the finding rather than an oversight.
  //
  // `inv_reason_codes` was the only entry here. PEND-15 answered the question
  // this list was holding open — zero rows in every tenant on the only database
  // carrying real ones, and zero by construction, since the sole writer that
  // ever existed was 0407's one-shot seed — and `0589` dropped it. Every
  // remaining `inv_*` table has a reader.
  //
  // Adding an entry means writing the sentence that justifies it. An exemption
  // nobody can read is how a check stops checking.
];

interface TableRef {
  table: string;
  exportName: string;
  file: string;
}

function tsFiles(dir: string, options: { includeTests: boolean }): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!options.includeTests && entry === "__tests__") continue;
      found.push(...tsFiles(path, options));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (!options.includeTests && /\.(spec|e2e-spec|test)\.ts$/.test(entry)) continue;
    found.push(path);
  }
  return found;
}

function declaredTables(): TableRef[] {
  const declared: TableRef[] = [];
  for (const file of tsFiles(SCHEMA_ROOT, { includeTests: true })) {
    const source = readFileSync(file, "utf8");
    const pattern = /export const (\w+) = pgTable\("(inv_[a-z0-9_]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      declared.push({ exportName: match[1]!, table: match[2]!, file });
    }
  }
  return declared.sort((a, b) => a.table.localeCompare(b.table));
}

function moduleSources(): string[] {
  return tsFiles(MODULES_ROOT, { includeTests: false }).map((file) => readFileSync(file, "utf8"));
}

describe("NEO-15 - the inventory schema describes the product", () => {
  const tables = declaredTables();
  const sources = moduleSources();

  it("finds the schema at all, so a broken walk cannot pass silently", () => {
    // The number is a floor rather than an exact count: units add tables, and a
    // check that had to be edited for every addition would be edited without
    // being read.
    expect(tables.length).toBeGreaterThanOrEqual(80);
    expect(sources.length).toBeGreaterThanOrEqual(100);
  });

  it("declares no table twice", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const ref of tables) {
      const previous = seen.get(ref.table);
      if (previous !== undefined) duplicates.push(`${ref.table} (${previous} and ${ref.file})`);
      seen.set(ref.table, ref.file);
    }
    expect(duplicates).toEqual([]);
  });

  it("gives every table a reader outside the schema and outside the tests", () => {
    const exempt = new Set(UNREAD_TABLES.map((entry) => entry.table));
    const unread = tables
      .filter((ref) => !exempt.has(ref.table))
      .filter(
        (ref) =>
          !sources.some(
            (source) =>
              new RegExp(`\\b${ref.exportName}\\b`).test(source) || source.includes(ref.table),
          ),
      )
      .map((ref) => ref.table);

    expect(unread).toEqual([]);
  });

  it("names every exemption, so the list cannot quietly absorb a real gap", () => {
    for (const entry of UNREAD_TABLES) {
      expect(entry.reason.length).toBeGreaterThan(80);
      expect(tables.some((ref) => ref.table === entry.table)).toBe(true);
    }
  });

  it("keeps the exemption list honest — a table that gained a reader must leave it", () => {
    // The other direction. An entry that is no longer true means somebody gave
    // the table a reader and left the excuse behind, and a stale exemption is how
    // the next genuinely dead table hides.
    const stillUnread = UNREAD_TABLES.filter((entry) => {
      const ref = tables.find((t) => t.table === entry.table);
      if (!ref) return false;
      return !sources.some(
        (source) =>
          new RegExp(`\\b${ref.exportName}\\b`).test(source) || source.includes(ref.table),
      );
    }).map((entry) => entry.table);

    expect(stillUnread).toEqual(UNREAD_TABLES.map((entry) => entry.table));
  });

  it("never lets the ledger or a document table be exempted", () => {
    // The work order's hard floor: these may not be dropped, so they may not
    // even be parked. Listing them by name rather than by a pattern, because a
    // pattern is something somebody widens.
    const NEVER = [
      "inv_stock_transactions",
      "inv_stock_levels",
      "inv_products",
      "inv_product_variants",
      "inv_purchase_orders",
      "inv_sales_orders",
      "inv_grns",
      "inv_audit_events",
      "inv_idempotency_keys",
    ];
    const parked = UNREAD_TABLES.map((entry) => entry.table);
    expect(NEVER.filter((table) => parked.includes(table))).toEqual([]);
  });
});
