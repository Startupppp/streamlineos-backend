#!/usr/bin/env node
/**
 * Gate: no `ON DELETE SET NULL` foreign key may write a non-nullable column.
 *
 * The defect class migration 0770 swept once and 0923/0927 immediately
 * reintroduced. Drizzle's `onDelete("set null")` emits a bare
 * `ON DELETE SET NULL`; on a composite key whose members are not all nullable
 * that raises 23502 on every parent delete instead of doing anything. The
 * correct form carries a column list, which lives only in
 * `pg_constraint.confdelsetcols` — Drizzle cannot declare it and drizzle-kit
 * cannot introspect it (`information_schema.referential_constraints.delete_rule`
 * answers "SET NULL" for the correct and the broken form alike).
 *
 * Two halves, because neither alone is sufficient:
 *
 *   DECLARATION half — hermetic, always runs. Derives from the schema module
 *   itself, so it cannot go stale. Catches the one shape Drizzle can express and
 *   get wrong: a SET NULL foreign key with no nullable member at all.
 *
 *   CATALOG half — needs a bootstrapped database via SET_NULL_GATE_DATABASE_URL,
 *   because the column list is only in pg_catalog. Without that URL this gate
 *   reports INCONCLUSIVE and exits 2. It does NOT quietly pass: the jest twin
 *   uses `describe.skip`, which is indistinguishable from success.
 *
 * Usage:
 *   node -r ts-node/register/transpile-only src/scripts/check-set-null-column-lists.ts
 *   node -r ts-node/register/transpile-only src/scripts/check-set-null-column-lists.ts --self-test
 *   SET_NULL_GATE_DATABASE_URL=postgresql://… node -r ts-node/register/transpile-only src/scripts/check-set-null-column-lists.ts
 *
 * Exit codes:
 *   0  declaration half clean, and the catalog half either clean or explicitly
 *      accepted as PARTIAL via STREAMLINE_ALLOW_PARTIAL_GATES=1
 *   1  a violation (or a self-test failure)
 *   2  INCONCLUSIVE — the catalog half could not run, or the scan is vacuous
 */

import { integer, pgTable, text, foreignKey } from "drizzle-orm/pg-core";
import postgres from "postgres";

import * as schema from "../db/schema";
import {
  deriveSetNullDeclarations,
  SET_NULL_COLUMN_SETS_QUERY,
  UNREACHABLE_SET_NULL_QUERY,
} from "../db/schema/set-null-column-lists";

const SELF_TEST = process.argv.includes("--self-test");
const GATE_URL = process.env.SET_NULL_GATE_DATABASE_URL;
const ALLOW_PARTIAL = process.env.STREAMLINE_ALLOW_PARTIAL_GATES === "1";

/**
 * Floors, not targets. A schema refactor that renames `onDelete` or moves the
 * barrel would otherwise leave this gate scanning nothing and reporting clean.
 */
const MIN_DECLARED = 100;
const MIN_REQUIRING_COLUMN_LIST = 20;

type UnreachableRow = {
  schema: string;
  table: string;
  constraint_name: string;
  definition: string;
};

type ColumnSetRow = {
  schema: string;
  table: string;
  constraint_name: string;
  key_columns: string[];
  set_null_columns: string[];
};

function buildKnownBadFixture(): Record<string, unknown> {
  const parents = pgTable("gate_parents", {
    orgId: text("org_id").notNull(),
    id: integer("id").notNull(),
  });

  // Composite key, one non-nullable member: bare SET NULL raises 23502.
  // This is the shape that needs a column list.
  const needsColumnList = pgTable(
    "gate_needs_column_list",
    {
      orgId: text("org_id").notNull(),
      ownerId: integer("owner_id"),
    },
    (t) => [
      foreignKey({
        columns: [t.orgId, t.ownerId],
        foreignColumns: [parents.orgId, parents.id],
        name: "fk_gate_needs_column_list",
      }).onDelete("set null"),
    ],
  );

  // Every member nullable: a bare SET NULL is already correct.
  const bareIsFine = pgTable(
    "gate_bare_is_fine",
    {
      orgId: text("org_id"),
      ownerId: integer("owner_id"),
    },
    (t) => [
      foreignKey({
        columns: [t.orgId, t.ownerId],
        foreignColumns: [parents.orgId, parents.id],
        name: "fk_gate_bare_is_fine",
      }).onDelete("set null"),
    ],
  );

  // No nullable member at all: no column list can rescue this. Every parent
  // delete raises 23502. This is the known-bad the gate must reject.
  const unreachable = pgTable(
    "gate_unreachable",
    {
      orgId: text("org_id").notNull(),
      ownerId: integer("owner_id").notNull(),
    },
    (t) => [
      foreignKey({
        columns: [t.orgId, t.ownerId],
        foreignColumns: [parents.orgId, parents.id],
        name: "fk_gate_unreachable",
      }).onDelete("set null"),
    ],
  );

  // A different delete action must not be picked up at all.
  const cascade = pgTable(
    "gate_cascade",
    {
      orgId: text("org_id").notNull(),
      ownerId: integer("owner_id").notNull(),
    },
    (t) => [
      foreignKey({
        columns: [t.orgId, t.ownerId],
        foreignColumns: [parents.orgId, parents.id],
        name: "fk_gate_cascade",
      }).onDelete("cascade"),
    ],
  );

  return { parents, needsColumnList, bareIsFine, unreachable, cascade };
}

function runSelfTest(): never {
  let passed = 0;
  const failures: string[] = [];
  const assert = (label: string, condition: boolean): void => {
    if (condition) passed++;
    else failures.push(label);
  };

  const fixture = deriveSetNullDeclarations(buildKnownBadFixture());
  const declaredNames = fixture.declared.map((fk) => fk.constraint);
  const unreachableNames = fixture.unreachable.map((fk) => fk.constraint);

  assert(
    "a SET NULL foreign key with no nullable member is rejected as unreachable",
    unreachableNames.includes("fk_gate_unreachable"),
  );
  assert("exactly the one unreachable key is reported", fixture.unreachable.length === 1);
  assert(
    "the unreachable finding names every referencing column",
    fixture.unreachable[0]?.columns.join(",") === "org_id,owner_id",
  );
  assert(
    "a composite key with one non-nullable member requires a column list",
    fixture.declared.find((fk) => fk.constraint === "fk_gate_needs_column_list")?.requiresColumnList === true,
  );
  assert(
    "the required column list is exactly the nullable subset",
    fixture.declared.find((fk) => fk.constraint === "fk_gate_needs_column_list")?.setNullColumns.join(",") ===
      "owner_id",
  );
  assert(
    "an all-nullable key does NOT require a column list",
    fixture.declared.find((fk) => fk.constraint === "fk_gate_bare_is_fine")?.requiresColumnList === false,
  );
  assert("a CASCADE foreign key is not picked up at all", !declaredNames.includes("fk_gate_cascade"));
  assert("a CASCADE foreign key is not reported unreachable", !unreachableNames.includes("fk_gate_cascade"));

  // The catalog queries. A query that stops selecting confdelsetcols silently
  // reduces the catalog half to a delete_rule check, which is the exact blind
  // spot this gate exists for.
  assert(
    "the unreachable query reads confdelsetcols, not information_schema.delete_rule",
    UNREACHABLE_SET_NULL_QUERY.includes("confdelsetcols") &&
      !UNREACHABLE_SET_NULL_QUERY.includes("information_schema"),
  );
  assert(
    "the unreachable query filters on SET NULL constraints only",
    UNREACHABLE_SET_NULL_QUERY.includes("confdeltype = 'n'"),
  );
  assert(
    "the unreachable query requires a non-nullable member",
    UNREACHABLE_SET_NULL_QUERY.includes("a.attnotnull"),
  );
  assert(
    "the column-set query reads confdelsetcols",
    SET_NULL_COLUMN_SETS_QUERY.includes("confdelsetcols"),
  );

  // The real schema, so a barrel or API change that empties the scan fails here
  // rather than producing a clean run over nothing.
  const real = deriveSetNullDeclarations(schema as unknown as Record<string, unknown>);
  const requiring = real.declared.filter((fk) => fk.requiresColumnList).length;
  assert(
    `the real schema yields at least ${MIN_DECLARED} declared SET NULL keys (found ${real.declared.length})`,
    real.declared.length >= MIN_DECLARED,
  );
  assert(
    `at least ${MIN_REQUIRING_COLUMN_LIST} of them require a column list (found ${requiring})`,
    requiring >= MIN_REQUIRING_COLUMN_LIST,
  );

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`check-set-null-column-lists self-tests: ${failures.length} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-set-null-column-lists self-tests: ${passed} passed`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (SELF_TEST) runSelfTest();

  const declarations = deriveSetNullDeclarations(schema as unknown as Record<string, unknown>);
  const requiring = declarations.declared.filter((fk) => fk.requiresColumnList);

  console.log(
    `Declared SET NULL foreign keys ${declarations.declared.length}  ·  requiring a column list ${requiring.length}  ·  unreachable ${declarations.unreachable.length}`,
  );

  if (
    declarations.declared.length < MIN_DECLARED ||
    requiring.length < MIN_REQUIRING_COLUMN_LIST
  ) {
    console.error(
      `INCONCLUSIVE — the declaration scan found ${declarations.declared.length} SET NULL keys (floor ${MIN_DECLARED}) of which ${requiring.length} require a column list (floor ${MIN_REQUIRING_COLUMN_LIST}). A clean result over an empty scan proves nothing.`,
    );
    process.exit(2);
  }

  if (declarations.unreachable.length > 0) {
    console.error(
      `FAIL — ${declarations.unreachable.length} SET NULL foreign key(s) have no nullable member. No column list can rescue these; every parent delete raises 23502:`,
    );
    for (const fk of declarations.unreachable)
      console.error(`  ${fk.schema}.${fk.table}.${fk.constraint}  (${fk.columns.join(", ")})`);
    console.error("\nFix: make the nullable members nullable, or change the delete action.");
    process.exit(1);
  }

  console.log("Declaration half OK — every declared SET NULL key has at least one nullable member.");

  if (GATE_URL === undefined || GATE_URL === "") {
    const stream = ALLOW_PARTIAL ? console.warn : console.error;
    stream(
      `${ALLOW_PARTIAL ? "PARTIAL" : "INCONCLUSIVE"} — the catalog half did not run. The ON DELETE SET NULL column list lives only in pg_constraint.confdelsetcols; nothing static can see it, so ${requiring.length} constraint(s) are UNVERIFIED.`,
    );
    stream("  Set SET_NULL_GATE_DATABASE_URL to a bootstrapped database to run it.");
    if (!ALLOW_PARTIAL) {
      console.error("  Or set STREAMLINE_ALLOW_PARTIAL_GATES=1 to accept a declaration-only run.");
      process.exit(2);
    }
    console.warn("  STREAMLINE_ALLOW_PARTIAL_GATES=1 — this run proves nothing about the catalog.");
    return;
  }

  const sql = postgres(GATE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const unreachableRows = (await sql.unsafe(UNREACHABLE_SET_NULL_QUERY)) as unknown as UnreachableRow[];
    const columnSets = (await sql.unsafe(SET_NULL_COLUMN_SETS_QUERY)) as unknown as ColumnSetRow[];

    if (columnSets.length < MIN_DECLARED) {
      console.error(
        `INCONCLUSIVE — the catalog reports ${columnSets.length} SET NULL constraints (floor ${MIN_DECLARED}). This database is not bootstrapped to head; the catalog half proves nothing.`,
      );
      process.exit(2);
    }

    console.log(`Catalog SET NULL constraints ${columnSets.length}`);

    if (unreachableRows.length > 0) {
      console.error(
        `FAIL — ${unreachableRows.length} SET NULL constraint(s) in the catalog write a non-nullable column:`,
      );
      for (const row of unreachableRows)
        console.error(`  ${row.schema}.${row.table}.${row.constraint_name}\n    ${row.definition}`);
      process.exit(1);
    }

    const byConstraint = new Map(
      columnSets.map((row) => [`${row.schema}.${row.table}.${row.constraint_name}`, row]),
    );
    const drifted: string[] = [];
    for (const fk of requiring) {
      const key = `${fk.schema}.${fk.table}.${fk.constraint}`;
      const row = byConstraint.get(key);
      if (row === undefined) continue;
      const actual = [...(row.set_null_columns ?? [])].sort().join(",");
      const expected = [...fk.setNullColumns].sort().join(",");
      if (actual !== expected) drifted.push(`  ${key}\n    catalog: [${actual}]\n    declared: [${expected}]`);
    }

    if (drifted.length > 0) {
      console.error(
        `FAIL — ${drifted.length} SET NULL constraint(s) carry a column list that disagrees with the declaration's nullability:`,
      );
      for (const d of drifted) console.error(d);
      process.exit(1);
    }

    console.log("Catalog half OK — every SET NULL column list matches the declaration.");
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(`check-set-null-column-lists: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
