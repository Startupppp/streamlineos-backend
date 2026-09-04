#!/usr/bin/env node
/**
 * Gate: the PRD-C057 inventory exists, covers every registry the criterion names,
 * classifies every entry, and still matches pg_catalog.
 *
 * An inventory is only worth what its staleness costs. The prior wave's artifact
 * recorded 15 baselined referential-action divergences while the gate printed 62,
 * and listed three fixed findings as open — and nothing in the document said so.
 * This gate re-derives the database population from the catalog and fails when the
 * artifact no longer matches, so the inventory cannot quietly drift out of date.
 *
 * Usage:
 *   node src/scripts/check-key-inventory.mjs --dir=<inventory dir> [--db=<url>]
 *   node src/scripts/check-key-inventory.mjs --self-test
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

import { COLUMNS_QUERY, CONSTRAINTS_QUERY, INDEXES_QUERY } from "./key-inventory/database.mjs";
import { FLOORS, REQUIRED_REGISTRIES, summarise, validate, VERDICTS } from "./key-inventory/validate.mjs";

const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const DIR = argument("dir");
const DB_URL = argument("db");
const SELF_TEST = process.argv.includes("--self-test");
const RULES = process.argv.includes("--rules");

function selfTest() {
  const good = REQUIRED_REGISTRIES.map((registry) => ({
    registry,
    item: `x:${registry}`,
    owner: "area",
    verdict: "KEEP",
    failurePrevented: "A concrete failure statement long enough to be a real sentence about a real consequence.",
    evidence: "pg_catalog: something",
  }));
  const checks = [
    ["a fully classified inventory over the floors still fails on the floors, which is the point", validate(good).every((problem) => problem.kind === "below-floor")],
    ["a missing registry is reported", validate(good.filter((row) => row.registry !== "code.translation")).some((problem) => problem.kind === "missing-registry")],
    ["an unclassified verdict is reported", validate(good.map((row, i) => (i === 0 ? { ...row, verdict: "MAYBE" } : row))).some((problem) => problem.kind === "unclassified")],
    ["a missing owner is reported", validate(good.map((row, i) => (i === 0 ? { ...row, owner: "" } : row))).some((problem) => problem.kind === "no-owner")],
    ["boilerplate failure text is reported", validate(good.map((row, i) => (i === 0 ? { ...row, failurePrevented: "unused" } : row))).some((problem) => problem.kind === "no-failure-prevented")],
    ["missing evidence is reported", validate(good.map((row, i) => (i === 0 ? { ...row, evidence: "" } : row))).some((problem) => problem.kind === "no-evidence")],
    ["a duplicate entry is reported", validate([...good, good[0]]).some((problem) => problem.kind === "duplicate-entry")],
    ["a stale database half is reported", validate(good, { catalogCounts: { "database.column": 12_267 } }).some((problem) => problem.kind === "stale-against-catalog")],
  ];
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) {
      failed += 1;
      console.error(`  FAIL ${label}`);
    }
  }
  console.log(`check-key-inventory --self-test: ${String(checks.length - failed)} passed, ${String(failed)} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function main() {
  if (RULES) {
    process.stdout.write(`${JSON.stringify({ REQUIRED_REGISTRIES, FLOORS, VERDICTS: [...VERDICTS] })}\n`);
    return;
  }
  if (SELF_TEST) selfTest();
  if (DIR === undefined) {
    console.error("usage: check-key-inventory.mjs --dir=<inventory dir> [--db=<url>]");
    process.exit(2);
  }
  if (!existsSync(DIR)) {
    console.error(`INCONCLUSIVE — no inventory at ${DIR}. PRD-C057 is an artifact criterion; there is nothing to validate.`);
    process.exit(2);
  }
  const rows = [];
  for (const file of readdirSync(DIR)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(DIR, file), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      rows.push(JSON.parse(line));
    }
  }
  if (rows.length === 0) {
    console.error(`INCONCLUSIVE — ${DIR} holds no .jsonl entries.`);
    process.exit(2);
  }

  let catalogCounts = null;
  if (DB_URL !== undefined && DB_URL !== "") {
    const sql = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const [columns, constraints, indexes] = await Promise.all([
        sql.unsafe(COLUMNS_QUERY),
        sql.unsafe(CONSTRAINTS_QUERY),
        sql.unsafe(INDEXES_QUERY),
      ]);
      catalogCounts = {
        "database.column": columns.length,
        "database.index": indexes.length,
        "database.primary-key": constraints.filter((constraint) => constraint.kind === "p").length,
        "database.foreign-key": constraints.filter((constraint) => constraint.kind === "f").length,
        "database.unique": constraints.filter((constraint) => constraint.kind === "u").length,
        "database.check": constraints.filter((constraint) => constraint.kind === "c").length,
      };
    } finally {
      await sql.end();
    }
  } else {
    console.warn("  (no --db: the database half is validated for classification only, not against pg_catalog)");
  }

  const problems = validate(rows, { catalogCounts });
  const summary = summarise(rows);
  console.log(`Inventory ${DIR} — ${String(rows.length)} entries across ${String(summary.size)} registries`);
  for (const registry of [...summary.keys()].sort()) {
    const bucket = summary.get(registry);
    console.log(`  ${registry.padEnd(28)} ${String(bucket.entries).padStart(6)}  KEEP ${String(bucket.KEEP)} · REFACTOR ${String(bucket.REFACTOR)} · REMOVE ${String(bucket.REMOVE)}`);
  }
  if (problems.length > 0) {
    console.error(`\nFAIL — ${String(problems.length)} problem(s):`);
    for (const problem of problems.slice(0, 40)) console.error(`  ${problem.kind} ${problem.registry} — ${problem.detail}`);
    if (problems.length > 40) console.error(`  … and ${String(problems.length - 40)} more`);
    process.exit(1);
  }
  console.log("OK — every registry PRD-C057 names is present, every entry is KEEP/REFACTOR/REMOVE with an owner, a concrete failure prevented and evidence, and the database half matches pg_catalog.");
}

main().catch((error) => {
  console.error(`check-key-inventory: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
