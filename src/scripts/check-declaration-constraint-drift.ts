#!/usr/bin/env node
/**
 * Gate: every unique constraint, unique index, plain index, foreign key and check
 * constraint the Drizzle schema DECLARES must actually exist on a database
 * bootstrapped to journal head.
 *
 * The defect class this exists for is `uniq_hr_people_org_person_link`. It is
 * declared at `db/schema/hr/core-people.ts:85` and the only SQL that creates it
 * is `migrations/pending/hrms-phase1/0000_hrms_profiles_workforce.sql`, which is
 * NOT listed in `migrations/meta/_journal.json`. `drizzle-kit migrate` skips a
 * file the journal does not list and still prints success, so the constraint has
 * never existed. Two consequences, and the second is the one that hides:
 *
 *   1. Nothing stopped two `hr_people` rows pointing at the same directory person
 *      in one organisation.
 *   2. Five sites branch on `code === "23505" && constraint ===
 *      "uniq_hr_people_org_person_link"` (hr-people.service.ts:172,
 *      recruitment-handoff.service.ts:141/164/179,
 *      hr-import-commit.service.ts:142). Every one was unreachable: the
 *      constraint they name did not exist, so Postgres never raised 23505 under
 *      that name. Code that LOOKS like it handles a duplicate handled nothing.
 *
 * `check:declaration-column-drift` is the sibling gate and covers COLUMNS. A
 * missing constraint is invisible to it: `hr_people.organization_person_id` is
 * present and correctly typed on both sides. Nothing else in the repo compares
 * declared constraints against the catalog.
 *
 * FOUR FALSE-POSITIVE CONTROLS, all bite-proved in --self-test. The sibling
 * gate's first real run reported 23 findings of which 22 were false positives;
 * the same lesson applies here and the controls are what make the count usable.
 *
 *   A. Constraint/index equivalence. Postgres implements a UNIQUE CONSTRAINT
 *      with a unique index of the same name; a bare CREATE UNIQUE INDEX makes an
 *      index and no `pg_constraint` row. `unique("n")` and `uniqueIndex("n")`
 *      are therefore the same population and are matched against BOTH catalogs.
 *      Comparing only `pg_constraint` reports every `uniqueIndex` as missing.
 *
 *   B. Name reuse across an expand. `idx_ai_chat_messages_org_user_id` is
 *      declared on (org_id, user_membership_id, id) while the live index of that
 *      NAME is still on the legacy (org_id, user_id, id) and the declared
 *      columns are indexed under a different name
 *      (`idx_ai_chat_messages_org_user_membership_id`). Matching by name alone
 *      calls that missing; it is name drift and the index is present. Three
 *      tables sit in exactly this state.
 *
 *   C. Tenant-anchored composite foreign keys. Migrations 1006/1024/1025
 *      replaced single-column foreign keys with the organisation-scoped
 *      composite `(org_id, child_id) -> parent (org_id, id)`, which the
 *      declaration still writes as an inline `.references()` on the child column
 *      alone. A declared foreign key is satisfied by any live foreign key to the
 *      same parent whose column list CONTAINS it: the composite is strictly
 *      stronger. 19 of 124 raw findings are this.
 *
 *   D. Prefix coverage. A declared index on (org_id) is answered by a live btree
 *      on (org_id, status) by definition of a btree, so a declared index whose
 *      column list is a leading prefix of a live one is coverage, not absence.
 *      Migration 0999 dropped 337 indexes on exactly that reasoning.
 *
 * Two verdict classes, because they fail differently:
 *
 *   INTEGRITY   a declared unique with no live unique object over the same
 *               columns, a declared foreign key no live foreign key covers, or a
 *               declared CHECK with no live constraint of that name. Duplicate
 *               and orphan rows become insertable, and any 23505/23503 handler
 *               naming the constraint is dead code.
 *   PERFORMANCE a declared non-unique index with no live index on those columns
 *               and none covering them as a prefix. Reads that assume it walk
 *               more of the table than the author believed.
 *
 * Name drift, partial-predicate mismatches and live objects the ORM does not
 * declare are REPORTED, never failed. Undeclared is how a later `drop` surprises
 * someone; it does not break a write today.
 *
 * Ratchet: today's accepted findings live in
 * `baselines/declaration-constraint-drift.json`. The gate fails only on findings
 * that are NOT in it, which is the case that matters — a constraint added to the
 * schema in this change with no migration behind it. The baseline can only
 * shrink; `--emit-baseline` rewrites it.
 *
 * Usage:
 *   node -r ts-node/register/transpile-only src/scripts/check-declaration-constraint-drift.ts
 *   node -r ts-node/register/transpile-only src/scripts/check-declaration-constraint-drift.ts --self-test
 *   CONSTRAINT_DRIFT_GATE_DATABASE_URL=postgresql://… node -r ts-node/register/transpile-only \
 *     src/scripts/check-declaration-constraint-drift.ts [--emit-baseline]
 *
 * The URL is a dedicated variable rather than DATABASE_URL so a local run cannot
 * reach the shared instance by inheriting it. The gate only ever SELECTs from
 * pg_catalog.
 *
 * Exit codes:
 *   0  clean, or every finding is baselined, or accepted as PARTIAL via
 *      STREAMLINE_ALLOW_PARTIAL_GATES=1
 *   1  an un-baselined integrity or performance finding (or a self-test failure)
 *   2  INCONCLUSIVE — no database, or the scan is vacuous
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import postgres from "postgres";

import * as schema from "../db/schema";
import type { Finding, LiveConstraint, LiveIndex } from "./declaration-constraint-drift/catalog";
import { LIVE_CONSTRAINTS_QUERY, LIVE_INDEXES_QUERY } from "./declaration-constraint-drift/catalog";
import { compare, unbaselined } from "./declaration-constraint-drift/compare";
import { countDeclaredObjects, declaredTablesOf } from "./declaration-constraint-drift/declared";
import {
  MIN_DECLARED_OBJECTS,
  MIN_DECLARED_TABLES,
  MIN_LIVE_CONSTRAINTS,
  MIN_LIVE_INDEXES,
  runSelfTest,
} from "./declaration-constraint-drift/self-test";

const SELF_TEST = process.argv.includes("--self-test");
const EMIT_BASELINE = process.argv.includes("--emit-baseline");
const GATE_URL = process.env.CONSTRAINT_DRIFT_GATE_DATABASE_URL;
const ALLOW_PARTIAL = process.env.STREAMLINE_ALLOW_PARTIAL_GATES === "1";
const BASELINE_PATH = resolve(__dirname, "baselines/declaration-constraint-drift.json");

function readBaseline(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    if (parsed === null || typeof parsed !== "object" || !("accepted" in parsed)) return new Set();
    const accepted = parsed.accepted;
    if (!Array.isArray(accepted)) return new Set();
    return new Set(accepted.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function printFindings(label: string, findings: readonly Finding[], limit: number): void {
  for (const finding of findings.slice(0, limit)) console.error(`  ${label} ${finding.table}.${finding.name} — ${finding.detail}`);
  if (findings.length > limit) console.error(`  … and ${String(findings.length - limit)} more`);
}

async function main(): Promise<void> {
  if (SELF_TEST) runSelfTest();

  const declared = declaredTablesOf({ ...schema });
  const objects = countDeclaredObjects(declared);
  console.log(`Declared tables ${String(declared.length)}  ·  declared constraints/indexes ${String(objects)}`);
  if (declared.length < MIN_DECLARED_TABLES || objects < MIN_DECLARED_OBJECTS) {
    console.error(
      `INCONCLUSIVE — the declaration scan found ${String(declared.length)} tables (floor ${String(MIN_DECLARED_TABLES)}) and ${String(objects)} objects (floor ${String(MIN_DECLARED_OBJECTS)}). A clean result over an empty scan proves nothing.`,
    );
    process.exit(2);
  }

  if (GATE_URL === undefined || GATE_URL === "") {
    const stream = ALLOW_PARTIAL ? console.warn : console.error;
    stream(
      `${ALLOW_PARTIAL ? "PARTIAL" : "INCONCLUSIVE"} — the catalog half did not run. Whether a declared constraint exists is only in pg_constraint/pg_index; nothing static can see it, so all ${String(objects)} declared objects are UNVERIFIED.`,
    );
    stream("  Set CONSTRAINT_DRIFT_GATE_DATABASE_URL to a database bootstrapped to journal head to run it.");
    if (!ALLOW_PARTIAL) {
      console.error("  Or set STREAMLINE_ALLOW_PARTIAL_GATES=1 to accept a declaration-only run.");
      process.exit(2);
    }
    console.warn("  STREAMLINE_ALLOW_PARTIAL_GATES=1 — this run proves nothing about the catalog.");
    return;
  }

  const sql = postgres(GATE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const liveIndexes = await sql.unsafe<LiveIndex[]>(LIVE_INDEXES_QUERY);
    const liveConstraints = await sql.unsafe<LiveConstraint[]>(LIVE_CONSTRAINTS_QUERY);
    if (liveIndexes.length < MIN_LIVE_INDEXES || liveConstraints.length < MIN_LIVE_CONSTRAINTS) {
      console.error(
        `INCONCLUSIVE — the catalog reports ${String(liveIndexes.length)} indexes (floor ${String(MIN_LIVE_INDEXES)}) and ${String(liveConstraints.length)} constraints (floor ${String(MIN_LIVE_CONSTRAINTS)}). This database is not bootstrapped to head.`,
      );
      process.exit(2);
    }

    const report = compare(declared, liveIndexes, liveConstraints);
    console.log(
      `Live indexes ${String(liveIndexes.length)}  ·  live constraints ${String(liveConstraints.length)}  ·  tables compared ${String(report.comparedTables)}  ·  declared-but-absent tables ${String(report.missingTables.length)}`,
    );
    console.log(
      `Reported, never failed — name drift ${String(report.nameDrift.length)}  ·  partial-predicate mismatch ${String(report.partialMismatch.length)}  ·  live-but-undeclared ${String(report.undeclared.length)}`,
    );

    if (EMIT_BASELINE) {
      const accepted = [...report.integrity, ...report.performance].map((finding) => finding.id).sort();
      writeFileSync(
        BASELINE_PATH,
        `${JSON.stringify(
          {
            note: "Findings accepted at the time of writing. The gate fails only on findings NOT listed here. This list can only shrink — every entry is a declared constraint or index that does not exist at journal head.",
            generated: new Date().toISOString().slice(0, 10),
            accepted,
          },
          null,
          2,
        )}\n`,
      );
      console.log(`Wrote ${String(accepted.length)} accepted findings to ${BASELINE_PATH}`);
      return;
    }

    const baseline = readBaseline();
    const newIntegrity = unbaselined(report.integrity, baseline);
    const newPerformance = unbaselined(report.performance, baseline);
    console.log(
      `Integrity findings ${String(report.integrity.length)} (${String(newIntegrity.length)} new)  ·  performance findings ${String(report.performance.length)} (${String(newPerformance.length)} new)  ·  baseline ${String(baseline.size)}`,
    );

    if (newIntegrity.length > 0) {
      console.error(
        `\nFAIL — ${String(newIntegrity.length)} declared constraint(s) do not exist at journal head. Duplicates or orphans are insertable and any 23505/23503 handler naming them is unreachable:`,
      );
      printFindings("INTEGRITY", newIntegrity, 40);
    }
    if (newPerformance.length > 0) {
      console.error(`\nFAIL — ${String(newPerformance.length)} declared index(es) do not exist at journal head:`);
      printFindings("PERFORMANCE", newPerformance, 40);
    }
    if (newIntegrity.length > 0 || newPerformance.length > 0) {
      console.error(
        "\nFix: write the migration and register it in migrations/meta/_journal.json. A .sql under migrations/pending/ never runs — that is the whole defect class this gate exists for.",
      );
      process.exit(1);
    }
    console.log("Catalog half OK — every declared constraint and index either exists at head or is baselined.");
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(`check-declaration-constraint-drift: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});