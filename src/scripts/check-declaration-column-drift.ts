#!/usr/bin/env node
/**
 * Gate: no live column that an INSERT must supply may be missing from the Drizzle
 * declaration, and no declared column may be missing from the live table.
 *
 * The defect class this exists for is `support_ticket_watchers.user_id` (migration
 * 1046). `0865` expanded the table onto `user_membership_id`, `0866` validated the
 * new foreign key, and no migration ever contracted the pair — while the Drizzle
 * declaration stopped declaring `user_id`. The column stayed `NOT NULL` with no
 * default, so every insert Drizzle built omitted a column Postgres required and
 * `POST /support/:supportTicketId/follow` answered 500 to every caller in every
 * tenant. 73 tables sit in the same expanded state; that one is the only one whose
 * declaration dropped the legacy column, which is why it is the only one failing.
 *
 * Report 07b (`reports/07b-declaration-drift.md`) scanned two populations and this
 * fell between them:
 *
 *   Population A — live TABLES with no declaration. Table granularity.
 *                  `support_ticket_watchers` IS declared, so it was never a row.
 *   Population B — DECLARED `.references()` with no constraint in the catalog.
 *                  Declaration -> live, and foreign keys only. `user_id` was not
 *                  declared at all, so it could not be one of the 1,385 parsed.
 *
 * Neither population is live -> declaration at COLUMN granularity. That is this
 * gate's population, and it is the one that breaks writes.
 *
 * `check:drop-column-safety` is the static sibling and covers a different case: a
 * column dropped by an UNAPPLIED migration that the schema still declares. It reads
 * `migrations/`, so drift that never came through a `DROP COLUMN` statement — which
 * is exactly this one, since no migration ever dropped anything — is invisible to it.
 *
 * Two verdict classes, because they fail differently:
 *
 *   WRITE-BLOCKING  a live column that is NOT NULL, has no default, and is neither
 *                   generated nor an identity column, absent from the declaration.
 *                   Drizzle omits it from every INSERT and Postgres raises 23502.
 *   READ-BLOCKING   a declared column with no live counterpart. Drizzle emits it in
 *                   every `findFirst`/`findMany` without an explicit projection and
 *                   Postgres raises 42703.
 *
 * A live column that is nullable or defaulted and undeclared is REPORTED, never
 * failed: writes still succeed, the column is merely invisible to the runtime. That
 * bucket is where the other 72 expanded tables would sit if their declarations were
 * ever trimmed, so its size is the leading indicator and it is printed every run.
 *
 * The discriminator that makes the write-blocking class usable — and the reason a
 * naive NOT NULL scan is a broken scan. The first run of this gate reported 23
 * write-blocking columns. Twenty-two were `org_id` on a child table
 * (`invoice_items`, `quote_line_items`, every `inv_*_lines`, …) and every one of
 * them is a FALSE POSITIVE: the table carries a `BEFORE INSERT … FOR EACH ROW`
 * trigger `trg_set_org_id` running `set_org_id_from_parent(parent, 'id', 'org_id',
 * fk)`, so the tenant column is derived from the parent and is deliberately NOT
 * declared, precisely so the ORM cannot write it. Postgres never demands a value
 * for it. `support_ticket_watchers` carries no trigger at all, which is why it was
 * the one that actually 500'd. So a NOT NULL, no-default, undeclared column is
 * write-blocking only when no BEFORE INSERT row trigger on that table names it;
 * otherwise it is reported as trigger-supplied. Validated in both directions: the
 * 22 downgrade and the 1 still fails.
 *
 * Usage:
 *   node -r ts-node/register/transpile-only src/scripts/check-declaration-column-drift.ts
 *   node -r ts-node/register/transpile-only src/scripts/check-declaration-column-drift.ts --self-test
 *   COLUMN_DRIFT_GATE_DATABASE_URL=postgresql://… node -r ts-node/register/transpile-only \
 *     src/scripts/check-declaration-column-drift.ts
 *
 * The URL is a dedicated variable rather than DATABASE_URL so a local run cannot
 * reach the shared instance by inheriting it. The gate only ever SELECTs from
 * pg_catalog.
 *
 * Exit codes:
 *   0  clean, or accepted as PARTIAL via STREAMLINE_ALLOW_PARTIAL_GATES=1
 *   1  a write-blocking or read-blocking drift (or a self-test failure)
 *   2  INCONCLUSIVE — no database, or the scan is vacuous
 */

import { getTableConfig, getViewConfig, PgTable, PgView } from "drizzle-orm/pg-core";
import postgres from "postgres";

import * as schema from "../db/schema";

const SELF_TEST = process.argv.includes("--self-test");
const GATE_URL = process.env.COLUMN_DRIFT_GATE_DATABASE_URL;
const ALLOW_PARTIAL = process.env.STREAMLINE_ALLOW_PARTIAL_GATES === "1";

/**
 * Floors, not targets. A barrel rename or a `getTableConfig` API change would
 * otherwise leave this gate comparing nothing against nothing and reporting clean.
 */
const MIN_DECLARED_TABLES = 700;
const MIN_DECLARED_COLUMNS = 5000;
const MIN_LIVE_COLUMNS = 5000;

export interface LiveColumn {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
  readonly isIdentity: boolean;
  readonly isGenerated: boolean;
}

export interface LiveTrigger {
  readonly schema: string;
  readonly table: string;
  readonly trigger: string;
  readonly definition: string;
}

export interface DeclaredTable {
  readonly schema: string;
  readonly table: string;
  readonly columns: ReadonlySet<string>;
}

export interface DriftFinding {
  readonly key: string;
  readonly column: string;
  readonly detail: string;
}

export interface DriftReport {
  readonly writeBlocking: readonly DriftFinding[];
  readonly readBlocking: readonly DriftFinding[];
  readonly triggerSupplied: readonly DriftFinding[];
  readonly invisible: readonly DriftFinding[];
  readonly undeclaredTables: readonly string[];
  readonly missingTables: readonly string[];
  readonly comparedTables: number;
}

/**
 * A column Postgres demands a value for on INSERT. `serial`/`identity` and every
 * defaulted column are excluded: Drizzle omitting those is correct, not drift.
 * `attgenerated <> ''` also sets `atthasdef`, so it is excluded explicitly rather
 * than relied on.
 */
export function requiresValueOnInsert(column: LiveColumn): boolean {
  if (!column.notNull) return false;
  if (column.hasDefault) return false;
  if (column.isIdentity) return false;
  if (column.isGenerated) return false;
  return true;
}

export const LIVE_COLUMNS_QUERY = `
  SELECT n.nspname                                   AS "schema",
         c.relname                                   AS "table",
         a.attname                                   AS "column",
         a.attnotnull                                AS "notNull",
         (a.atthasdef AND a.attgenerated = '')       AS "hasDefault",
         (a.attidentity <> '')                       AS "isIdentity",
         (a.attgenerated <> '')                      AS "isGenerated"
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE a.attnum > 0
    AND NOT a.attisdropped
    AND c.relkind IN ('r', 'p')
    AND NOT c.relispartition
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'drizzle', 'pg_toast')
`;

/**
 * `tgtype` bits: 1 = FOR EACH ROW, 2 = BEFORE, 4 = INSERT. A statement-level or
 * AFTER trigger cannot supply a value to the row being inserted, so neither
 * qualifies as a reason to downgrade a missing NOT NULL column.
 */
export const INSERT_TRIGGERS_QUERY = `
  SELECT n.nspname            AS "schema",
         c.relname            AS "table",
         t.tgname             AS "trigger",
         pg_get_triggerdef(t.oid) AS "definition"
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE NOT t.tgisinternal
    AND (t.tgtype & 1) <> 0
    AND (t.tgtype & 2) <> 0
    AND (t.tgtype & 4) <> 0
`;

/**
 * Word-boundary rather than substring: `org_id` must not match `source_org_id`.
 * `_` is a word character, so \b does that correctly, and the trigger definition
 * quotes the argument (`'org_id'`), which supplies the boundaries.
 */
export function triggerNamesColumn(definition: string, column: string): boolean {
  return new RegExp(`\\b${column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(definition);
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

export function compare(
  declared: readonly DeclaredTable[],
  live: readonly LiveColumn[],
  triggers: readonly LiveTrigger[] = [],
): DriftReport {
  const triggersByTable = new Map<string, LiveTrigger[]>();
  for (const trigger of triggers) {
    const key = `${trigger.schema}.${trigger.table}`;
    const bucket = triggersByTable.get(key);
    if (bucket === undefined) triggersByTable.set(key, [trigger]);
    else bucket.push(trigger);
  }

  const liveByTable = new Map<string, LiveColumn[]>();
  for (const column of live) {
    const key = `${column.schema}.${column.table}`;
    const bucket = liveByTable.get(key);
    if (bucket === undefined) liveByTable.set(key, [column]);
    else bucket.push(column);
  }

  const writeBlocking: DriftFinding[] = [];
  const readBlocking: DriftFinding[] = [];
  const triggerSupplied: DriftFinding[] = [];
  const invisible: DriftFinding[] = [];
  const missingTables: string[] = [];
  const declaredKeys = new Set<string>();
  let comparedTables = 0;

  for (const table of declared) {
    const key = `${table.schema}.${table.table}`;
    declaredKeys.add(key);
    const liveColumns = liveByTable.get(key);
    if (liveColumns === undefined) {
      missingTables.push(key);
      continue;
    }
    comparedTables += 1;
    const liveNames = new Set(liveColumns.map((column) => column.column));

    for (const column of liveColumns) {
      if (table.columns.has(column.column)) continue;
      if (requiresValueOnInsert(column)) {
        const supplier = (triggersByTable.get(key) ?? []).find((trigger) =>
          triggerNamesColumn(trigger.definition, column.column),
        );
        if (supplier === undefined)
          writeBlocking.push({
            key,
            column: column.column,
            detail: "live NOT NULL with no default and undeclared — every Drizzle INSERT raises 23502",
          });
        else
          triggerSupplied.push({
            key,
            column: column.column,
            detail: `supplied by BEFORE INSERT trigger ${supplier.trigger} — undeclared on purpose`,
          });
      } else
        invisible.push({
          key,
          column: column.column,
          detail: column.notNull ? "live NOT NULL with a default, undeclared" : "live nullable, undeclared",
        });
    }

    for (const name of table.columns) {
      if (liveNames.has(name)) continue;
      readBlocking.push({
        key,
        column: name,
        detail: "declared with no live column — every unprojected read raises 42703",
      });
    }
  }

  const undeclaredTables = [...liveByTable.keys()].filter((key) => !declaredKeys.has(key)).sort();

  const order = (a: DriftFinding, b: DriftFinding): number =>
    `${a.key}.${a.column}`.localeCompare(`${b.key}.${b.column}`);
  return {
    writeBlocking: writeBlocking.sort(order),
    readBlocking: readBlocking.sort(order),
    triggerSupplied: triggerSupplied.sort(order),
    invisible: invisible.sort(order),
    undeclaredTables,
    missingTables: missingTables.sort(),
    comparedTables,
  };
}

function runSelfTest(): never {
  const failures: string[] = [];
  let passed = 0;
  const assert = (label: string, ok: boolean): void => {
    if (ok) passed += 1;
    else failures.push(label);
  };

  const col = (over: Partial<LiveColumn> & Pick<LiveColumn, "table" | "column">): LiveColumn => ({
    schema: "public",
    notNull: false,
    hasDefault: false,
    isIdentity: false,
    isGenerated: false,
    ...over,
  });

  // The real defect, reduced: a declaration that lost a NOT NULL live column.
  const watchers: DeclaredTable = {
    schema: "public",
    table: "support_ticket_watchers",
    columns: new Set(["id", "org_id", "ticket_id", "user_membership_id", "created_at"]),
  };
  const watchersLive: LiveColumn[] = [
    col({ table: "support_ticket_watchers", column: "id", notNull: true, hasDefault: true }),
    col({ table: "support_ticket_watchers", column: "org_id", notNull: true }),
    col({ table: "support_ticket_watchers", column: "ticket_id", notNull: true }),
    col({ table: "support_ticket_watchers", column: "user_id", notNull: true }),
    col({ table: "support_ticket_watchers", column: "user_membership_id" }),
    col({ table: "support_ticket_watchers", column: "created_at", notNull: true, hasDefault: true }),
  ];
  const bite = compare([watchers], watchersLive);
  assert(
    "the real defect is caught: support_ticket_watchers.user_id is write-blocking",
    bite.writeBlocking.length === 1 &&
      bite.writeBlocking[0]?.key === "public.support_ticket_watchers" &&
      bite.writeBlocking[0]?.column === "user_id",
  );
  assert("the serial id column does not fire", !bite.writeBlocking.some((f) => f.column === "id"));
  assert("the defaulted created_at does not fire", !bite.writeBlocking.some((f) => f.column === "created_at"));
  assert("the contracted table is clean", compare([watchers], watchersLive.filter((c) => c.column !== "user_id")).writeBlocking.length === 0);

  // The 22 false positives the first real run produced, reduced: a NOT NULL,
  // no-default, undeclared column that a BEFORE INSERT row trigger fills.
  const items: DeclaredTable = { schema: "public", table: "invoice_items", columns: new Set(["id", "invoice_id"]) };
  const itemsLive: LiveColumn[] = [
    col({ table: "invoice_items", column: "id", notNull: true, hasDefault: true }),
    col({ table: "invoice_items", column: "invoice_id", notNull: true }),
    col({ table: "invoice_items", column: "org_id", notNull: true }),
  ];
  const setOrgId: LiveTrigger = {
    schema: "public",
    table: "invoice_items",
    trigger: "trg_set_org_id",
    definition:
      "CREATE TRIGGER trg_set_org_id BEFORE INSERT ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION set_org_id_from_parent('invoices', 'id', 'org_id', 'invoice_id')",
  };
  const supplied = compare([items], itemsLive, [setOrgId]);
  assert(
    "a trigger-filled tenant column is downgraded, not failed",
    supplied.writeBlocking.length === 0 &&
      supplied.triggerSupplied.length === 1 &&
      supplied.triggerSupplied[0]?.column === "org_id",
  );
  assert(
    "without the trigger the same column DOES fail — the downgrade is the trigger's doing, not the column's",
    compare([items], itemsLive).writeBlocking.length === 1,
  );
  assert(
    "a trigger that does not name the column does not downgrade it",
    compare([items], itemsLive, [{ ...setOrgId, definition: "CREATE TRIGGER t BEFORE INSERT ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION touch_updated_at()" }]).writeBlocking.length === 1,
  );
  assert(
    "a trigger on a different table does not downgrade",
    compare([items], itemsLive, [{ ...setOrgId, table: "other_table" }]).writeBlocking.length === 1,
  );
  assert(
    "the column match is word-bounded — source_org_id does not count as org_id",
    !triggerNamesColumn("EXECUTE FUNCTION f('source_org_id')", "org_id"),
  );
  assert("the column match finds the quoted argument", triggerNamesColumn("f('invoices', 'id', 'org_id', 'invoice_id')", "org_id"));
  assert(
    "support_ticket_watchers still fails with the trigger set present — it carries no trigger",
    compare([watchers], watchersLive, [setOrgId]).writeBlocking.length === 1,
  );
  assert("the trigger query selects BEFORE INSERT row triggers only", INSERT_TRIGGERS_QUERY.includes("t.tgtype & 1") && INSERT_TRIGGERS_QUERY.includes("t.tgtype & 2") && INSERT_TRIGGERS_QUERY.includes("t.tgtype & 4"));

  // A nullable or defaulted undeclared column is invisible, not blocking — this is
  // the bucket the other 72 expanded tables occupy.
  const t: DeclaredTable = { schema: "public", table: "t", columns: new Set(["id"]) };
  const nullableDrift = compare([t], [col({ table: "t", column: "id", notNull: true, hasDefault: true }), col({ table: "t", column: "note" })]);
  assert("a nullable undeclared column is reported, not failed", nullableDrift.writeBlocking.length === 0 && nullableDrift.invisible.length === 1);
  const defaulted = compare([t], [col({ table: "t", column: "id", notNull: true, hasDefault: true }), col({ table: "t", column: "n", notNull: true, hasDefault: true })]);
  assert("a NOT NULL undeclared column WITH a default does not fail", defaulted.writeBlocking.length === 0 && defaulted.invisible.length === 1);
  const identity = compare([t], [col({ table: "t", column: "id", notNull: true, hasDefault: true }), col({ table: "t", column: "n", notNull: true, isIdentity: true })]);
  assert("an identity column does not fail", identity.writeBlocking.length === 0);
  const generated = compare([t], [col({ table: "t", column: "id", notNull: true, hasDefault: true }), col({ table: "t", column: "n", notNull: true, hasDefault: true, isGenerated: true })]);
  assert("a generated column does not fail", generated.writeBlocking.length === 0);

  // The other direction: declared, not live.
  const missingColumn = compare([{ schema: "public", table: "t", columns: new Set(["id", "gone"]) }], [col({ table: "t", column: "id", notNull: true, hasDefault: true })]);
  assert("a declared column with no live counterpart is read-blocking", missingColumn.readBlocking.length === 1 && missingColumn.readBlocking[0]?.column === "gone");

  // A same-named column on a neighbouring table must not cross-fire.
  const crossFire = compare(
    [{ schema: "public", table: "a", columns: new Set(["user_id"]) }, { schema: "public", table: "b", columns: new Set(["id"]) }],
    [col({ table: "a", column: "user_id", notNull: true }), col({ table: "b", column: "id", notNull: true, hasDefault: true }), col({ table: "b", column: "user_id", notNull: true })],
  );
  assert(
    "a same-named column on another table is attributed to that table only",
    crossFire.writeBlocking.length === 1 && crossFire.writeBlocking[0]?.key === "public.b",
  );

  // Schema qualification: `build.tickets` and `public.tickets` are different tables.
  const schemaQualified = compare(
    [{ schema: "build", table: "tickets", columns: new Set(["id"]) }],
    [col({ schema: "public", table: "tickets", column: "id", notNull: true }), col({ schema: "public", table: "tickets", column: "legacy", notNull: true })],
  );
  assert(
    "a declared table in another schema is not compared against the public one",
    schemaQualified.writeBlocking.length === 0 && schemaQualified.missingTables.length === 1,
  );

  assert("the live query reads attnotnull", LIVE_COLUMNS_QUERY.includes("attnotnull"));
  assert("the live query excludes dropped columns", LIVE_COLUMNS_QUERY.includes("attisdropped"));
  assert("the live query excludes partition children", LIVE_COLUMNS_QUERY.includes("relispartition"));

  // The real barrel, so an empty scan fails here rather than passing over nothing.
  const real = declaredTablesOf(schema as unknown as Record<string, unknown>);
  const realColumns = real.reduce((sum, t2) => sum + t2.columns.size, 0);
  assert(`the real schema yields at least ${String(MIN_DECLARED_TABLES)} tables (found ${String(real.length)})`, real.length >= MIN_DECLARED_TABLES);
  assert(`the real schema yields at least ${String(MIN_DECLARED_COLUMNS)} columns (found ${String(realColumns)})`, realColumns >= MIN_DECLARED_COLUMNS);
  assert(
    "the real schema declares support_ticket_watchers without user_id (the shape 1046 contracted the database onto)",
    real.some((t2) => t2.table === "support_ticket_watchers" && !t2.columns.has("user_id") && t2.columns.has("user_membership_id")),
  );

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`check-declaration-column-drift self-tests: ${String(failures.length)} failed, ${String(passed)} passed`);
    process.exit(1);
  }
  console.log(`check-declaration-column-drift self-tests: ${String(passed)} passed`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (SELF_TEST) runSelfTest();

  const declared = declaredTablesOf(schema as unknown as Record<string, unknown>);
  const declaredColumns = declared.reduce((sum, t) => sum + t.columns.size, 0);
  console.log(`Declared tables ${String(declared.length)}  ·  declared columns ${String(declaredColumns)}`);

  if (declared.length < MIN_DECLARED_TABLES || declaredColumns < MIN_DECLARED_COLUMNS) {
    console.error(
      `INCONCLUSIVE — the declaration scan found ${String(declared.length)} tables (floor ${String(MIN_DECLARED_TABLES)}) and ${String(declaredColumns)} columns (floor ${String(MIN_DECLARED_COLUMNS)}). A clean result over an empty scan proves nothing.`,
    );
    process.exit(2);
  }

  if (GATE_URL === undefined || GATE_URL === "") {
    const stream = ALLOW_PARTIAL ? console.warn : console.error;
    stream(
      `${ALLOW_PARTIAL ? "PARTIAL" : "INCONCLUSIVE"} — the catalog half did not run. Whether a live column is missing from a declaration is only in pg_attribute; nothing static can see it, so all ${String(declared.length)} declared tables are UNVERIFIED.`,
    );
    stream("  Set COLUMN_DRIFT_GATE_DATABASE_URL to a database bootstrapped to head to run it.");
    if (!ALLOW_PARTIAL) {
      console.error("  Or set STREAMLINE_ALLOW_PARTIAL_GATES=1 to accept a declaration-only run.");
      process.exit(2);
    }
    console.warn("  STREAMLINE_ALLOW_PARTIAL_GATES=1 — this run proves nothing about the catalog.");
    return;
  }

  const sql = postgres(GATE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const live = (await sql.unsafe(LIVE_COLUMNS_QUERY)) as unknown as LiveColumn[];
    if (live.length < MIN_LIVE_COLUMNS) {
      console.error(
        `INCONCLUSIVE — the catalog reports ${String(live.length)} columns (floor ${String(MIN_LIVE_COLUMNS)}). This database is not bootstrapped to head; the catalog half proves nothing.`,
      );
      process.exit(2);
    }

    const triggers = (await sql.unsafe(INSERT_TRIGGERS_QUERY)) as unknown as LiveTrigger[];
    const report = compare(declared, live, triggers);
    console.log(
      `Live columns ${String(live.length)}  ·  tables compared ${String(report.comparedTables)}  ·  declared-but-absent tables ${String(report.missingTables.length)}  ·  live-but-undeclared tables ${String(report.undeclaredTables.length)}`,
    );
    console.log(
      `Undeclared-but-harmless live columns (nullable or defaulted) ${String(report.invisible.length)} — reported, not failed.`,
    );
    console.log(
      `Undeclared live columns supplied by a BEFORE INSERT trigger ${String(report.triggerSupplied.length)} (of ${String(triggers.length)} such triggers) — reported, not failed.`,
    );
    for (const f of report.triggerSupplied) console.log(`  ${f.key}.${f.column}  — ${f.detail}`);

    let failed = false;
    if (report.writeBlocking.length > 0) {
      failed = true;
      console.error(
        `FAIL — ${String(report.writeBlocking.length)} live column(s) are NOT NULL with no default and missing from the declaration. Every Drizzle INSERT on these tables raises 23502:`,
      );
      for (const f of report.writeBlocking) console.error(`  ${f.key}.${f.column}  — ${f.detail}`);
    }
    if (report.readBlocking.length > 0) {
      failed = true;
      console.error(
        `FAIL — ${String(report.readBlocking.length)} declared column(s) have no live counterpart. Every unprojected read raises 42703:`,
      );
      for (const f of report.readBlocking) console.error(`  ${f.key}.${f.column}  — ${f.detail}`);
    }
    if (failed) {
      console.error(
        "\nFix: contract the pair with a migration (drop the legacy column) or restore the column to the declaration. Never one without measuring the other.",
      );
      process.exit(1);
    }

    console.log("Catalog half OK — no write-blocking or read-blocking column drift.");
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(`check-declaration-column-drift: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
