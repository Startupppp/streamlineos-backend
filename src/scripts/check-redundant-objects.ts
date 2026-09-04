#!/usr/bin/env node
/**
 * Gate: detect redundant or overlapping foreign keys, unique constraints, checks
 * and indexes from FOUR inputs, and refuse to call an overlap redundant.
 *
 * PRD-C059 names the four inputs and this gate reads all four:
 *
 *   1. SCHEMA DECLARATIONS — the Drizzle barrel, so every finding says whether
 *      the fix is a schema edit or a migration against a live-only object.
 *   2. pg_catalog — REDUNDANT_OBJECTS_GATE_DATABASE_URL, bootstrapped to journal
 *      head. Nothing static can see a live-only index.
 *   3. EXPLAIN (ANALYZE, BUFFERS) — `--capture-plans` measures each overlapping
 *      pair on a seeded database by dropping the narrow member inside a
 *      transaction that rolls back, so the plan with and without it are measured
 *      on the same rows. That evidence file is what a drop has to argue against.
 *   4. WORKLOAD/INDEX STATISTICS — pg_stat_user_indexes.idx_scan and
 *      pg_stat_user_tables.n_live_tup, carried on every finding.
 *
 * The criterion's second sentence is the one that needs enforcing, because it is
 * the one that is easy to violate while looking rigorous: "Statistics alone never
 * justify deletion." No verdict branch in detect.ts reads a scan count, and every
 * run re-derives the whole report with the statistics replaced by extremes and
 * fails if a single verdict moved. That is `statisticsAreInert`.
 *
 * What this gate would have caught: the ticket-02 triage reported three
 * "exact-duplicate index pairs" — build.projects, crm_commission_assignments and
 * crm_commission_plan_versions — from a query that compared `indkey`. All three
 * pairs differ in `indoption`: the second member trails a DESC column. They are
 * distinct ordering paths, which is the first thing the criterion's own sentence
 * says to preserve. Comparing the key vector WITH its per-column options takes
 * this repo's exact-duplicate index count from 3 to 0.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import postgres from "postgres";

import * as schema from "../db/schema";
import { declaredTablesOf } from "./declaration-constraint-drift/declared";
import type { LiveConstraint, LiveIndex, Overlap } from "./redundant-objects/catalog";
import { LIVE_CONSTRAINTS_QUERY, LIVE_INDEXES_QUERY } from "./redundant-objects/catalog";
import {
  detectConstraintDuplicates,
  detectForeignKeySubsumption,
  detectIndexOverlaps,
  detectUniqueSubsumption,
  preserved,
  redundant,
  statisticsAreInert,
} from "./redundant-objects/detect";
import { isPlanEvidence, type PlanEvidence } from "./redundant-objects/plan-evidence-guard";
import { runSelfTest } from "./redundant-objects/self-test";

const SELF_TEST = process.argv.includes("--self-test");
const REPORT_PATH = process.argv.find((argument) => argument.startsWith("--report="))?.slice("--report=".length);
const CAPTURE_PLANS = process.argv.includes("--capture-plans");
const GATE_URL = process.env.REDUNDANT_OBJECTS_GATE_DATABASE_URL;
const PLANS_URL = process.env.REDUNDANT_OBJECTS_PLANS_DATABASE_URL;
const PLAN_EVIDENCE_PATH = resolve(__dirname, "redundant-objects/plan-evidence.json");

const MIN_LIVE_INDEXES = 3_000;
const MIN_LIVE_CONSTRAINTS = 3_000;
const MIN_DECLARED_TABLES = 700;

function readPlanEvidence(): Map<string, PlanEvidence> {
  if (!existsSync(PLAN_EVIDENCE_PATH)) return new Map();
  try {
    const parsed: unknown = JSON.parse(readFileSync(PLAN_EVIDENCE_PATH, "utf8"));
    if (parsed === null || typeof parsed !== "object" || !("plans" in parsed)) return new Map();
    const plans = parsed.plans;
    if (!Array.isArray(plans)) return new Map();
    const out = new Map<string, PlanEvidence>();
    for (const entry of plans) {
      if (isPlanEvidence(entry)) out.set(entry.id, entry);
    }
    return out;
  } catch {
    return new Map();
  }
}

function leadingColumns(keydef: string): string[] {
  return keydef
    .split(",")
    .map((key) => key.split(":")[0] ?? "")
    .filter((column) => /^[a-z_][a-z0-9_]*$/.test(column));
}

async function capturePlans(overlaps: readonly Overlap[]): Promise<void> {
  if (PLANS_URL === undefined || PLANS_URL === "") {
    console.error("INCONCLUSIVE — --capture-plans needs REDUNDANT_OBJECTS_PLANS_DATABASE_URL pointing at a SEEDED database. A plan over zero rows measures nothing.");
    process.exit(2);
  }
  const sql = postgres(PLANS_URL, { max: 1, prepare: false, onnotice: () => {} });
  const plans: PlanEvidence[] = [];
  const captured = new Set<string>();
  try {
    for (const overlap of overlaps) {
      if (overlap.kind !== "index") continue;
      if (captured.has(overlap.id)) continue;
      const rows = await sql.unsafe<{ n: number }[]>(
        `select coalesce(n_live_tup, 0)::int as n from pg_stat_user_tables where schemaname = '${overlap.schema}' and relname = '${overlap.tbl}'`,
      );
      if ((rows[0]?.n ?? 0) < 1_000) continue;
      const columns = leadingColumns(overlap.candidateKeys);
      const first = columns[0];
      if (first === undefined) continue;
      const probe = `select count(*) from ${overlap.schema}.${overlap.tbl} where ${first} = (select ${first} from ${overlap.schema}.${overlap.tbl} where ${first} is not null limit 1)`;
      const withCandidate = await sql.unsafe<Record<string, string>[]>(`explain (analyze, buffers) ${probe}`);
      const withoutCandidate = await sql.begin(async (tx) => {
        await tx.unsafe(`drop index ${overlap.schema}.${overlap.candidate}`);
        const measured = await tx.unsafe<Record<string, string>[]>(`explain (analyze, buffers) ${probe}`);
        const rendered = measured.map((row) => Object.values(row)[0] ?? "").join("\n");
        await tx.unsafe("rollback");
        return rendered;
      }).catch((error: unknown) => `not measurable: ${error instanceof Error ? error.message : String(error)}`);
      captured.add(overlap.id);
      plans.push({
        id: overlap.id,
        probe,
        withCandidate: withCandidate.map((row) => Object.values(row)[0] ?? "").join("\n"),
        withoutCandidate: typeof withoutCandidate === "string" ? withoutCandidate : String(withoutCandidate),
      });
    }
    writeFileSync(
      PLAN_EVIDENCE_PATH,
      `${JSON.stringify(
        {
          note: "EXPLAIN (ANALYZE, BUFFERS) measured on a seeded database, each overlapping pair once with the narrow member present and once with it dropped inside a rolled-back transaction. Evidence for PRD-C059. Statistics and plans may only ADD a KEEP; no deletion in this release rests on them.",
          generated: new Date().toISOString().slice(0, 10),
          database: PLANS_URL.replace(/:\/\/[^@]*@/, "://"),
          plans,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Captured ${String(plans.length)} plan pair(s) to ${PLAN_EVIDENCE_PATH}`);
  } finally {
    await sql.end();
  }
}

function report(overlaps: readonly Overlap[], planEvidence: ReadonlyMap<string, PlanEvidence>): void {
  const keep = preserved(overlaps);
  const byReason = new Map<string, number>();
  for (const overlap of keep) {
    const reason = overlap.preserveReason ?? "unclassified";
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  console.log(`Preserved overlaps ${String(keep.length)} — ${[...byReason.entries()].map(([reason, count]) => `${reason} ${String(count)}`).join(" · ")}`);
  console.log(`Plan evidence on file for ${String([...planEvidence.keys()].filter((id) => overlaps.some((overlap) => overlap.id === id)).length)} of them`);
}

async function main(): Promise<void> {
  if (SELF_TEST) {
    runSelfTest();
    return;
  }

  const declared = declaredTablesOf({ ...schema });
  if (declared.length < MIN_DECLARED_TABLES) {
    console.error(`INCONCLUSIVE — the declaration scan found ${String(declared.length)} tables (floor ${String(MIN_DECLARED_TABLES)}). A clean result over an empty scan proves nothing.`);
    process.exit(2);
  }
  const declaredNames = new Set<string>();
  for (const table of declared) {
    for (const index of [...table.indexes, ...table.uniques]) declaredNames.add(index.name);
    for (const foreignKey of table.foreignKeys) declaredNames.add(foreignKey.name);
  }

  if (GATE_URL === undefined || GATE_URL === "") {
    console.error("INCONCLUSIVE — redundancy lives in pg_catalog and nothing static can see a live-only index. Set REDUNDANT_OBJECTS_GATE_DATABASE_URL to a database bootstrapped to journal head.");
    process.exit(2);
  }

  const sql = postgres(GATE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const indexes = await sql.unsafe<LiveIndex[]>(LIVE_INDEXES_QUERY);
    const constraints = await sql.unsafe<LiveConstraint[]>(LIVE_CONSTRAINTS_QUERY);
    if (indexes.length < MIN_LIVE_INDEXES || constraints.length < MIN_LIVE_CONSTRAINTS) {
      console.error(`INCONCLUSIVE — the catalog reports ${String(indexes.length)} indexes (floor ${String(MIN_LIVE_INDEXES)}) and ${String(constraints.length)} constraints (floor ${String(MIN_LIVE_CONSTRAINTS)}). This database is not bootstrapped to head.`);
      process.exit(2);
    }

    const overlaps = [
      ...detectIndexOverlaps(indexes),
      ...detectUniqueSubsumption(indexes),
      ...detectConstraintDuplicates(constraints),
      ...detectForeignKeySubsumption(constraints),
    ];
    console.log(
      `Declared tables ${String(declared.length)}  ·  live indexes ${String(indexes.length)}  ·  live FK/unique/check constraints ${String(constraints.length)}  ·  overlapping pairs ${String(overlaps.length)}`,
    );

    if (!statisticsAreInert(indexes, constraints)) {
      console.error("FAIL — a verdict moved when the scan counts were replaced. Statistics alone must never justify a deletion; this gate is no longer honest about that.");
      process.exit(1);
    }
    console.log("Statistics are inert — every verdict is unchanged when idx_scan and n_live_tup are replaced by extremes.");

    if (CAPTURE_PLANS) {
      await capturePlans(overlaps);
      return;
    }

    const planEvidence = readPlanEvidence();
    report(overlaps, planEvidence);

    if (REPORT_PATH !== undefined && REPORT_PATH !== "") {
      writeFileSync(
        REPORT_PATH,
        `${JSON.stringify(
          {
            note: "PRD-C059 detection report. Four inputs: Drizzle declarations, pg_catalog, EXPLAIN (ANALYZE, BUFFERS) plan evidence, and pg_stat_user_indexes/pg_stat_user_tables statistics. Statistics are carried per row and read by no verdict — see src/scripts/redundant-objects/detect.ts.",
            generated: new Date().toISOString().slice(0, 10),
            database: GATE_URL.replace(/:\/\/[^@]*@/, "://"),
            liveIndexes: indexes.length,
            liveConstraints: constraints.length,
            declaredTables: declared.length,
            redundant: redundant(overlaps).length,
            preserved: preserved(overlaps).length,
            rows: overlaps.map((overlap) => ({
              ...overlap,
              declared: declaredNames.has(overlap.candidate),
              planEvidence: planEvidence.has(overlap.id),
            })),
          },
          null,
          2,
        )}\n`,
      );
      console.log(`Wrote ${String(overlaps.length)} classified overlap(s) to ${REPORT_PATH}`);
    }

    const findings = redundant(overlaps);
    if (findings.length > 0) {
      console.error(`\nFAIL — ${String(findings.length)} structurally redundant object(s). Each carries no guarantee its survivor does not already carry:`);
      for (const finding of findings.slice(0, 40)) {
        const where = declaredNames.has(finding.candidate) ? "declared in src/db/schema" : "live-only";
        console.error(`  ${finding.kind.toUpperCase()} ${finding.schema}.${finding.tbl}.${finding.candidate} — duplicate of ${finding.survivor} (${where}) — ${finding.detail}`);
      }
      console.error("\nFix: drop the candidate in a migration and, when it is declared, in src/db/schema in the same change. Never drop the survivor.");
      process.exit(1);
    }
    console.log("OK — no duplicate foreign key, unique constraint, check or index. Every overlap is a preserved distinct guarantee.");
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(`check-redundant-objects: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
