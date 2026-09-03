#!/usr/bin/env node
/**
 * Gate: every `ON CONFLICT (<columns>)` target must be inferable by Postgres.
 *
 * Postgres infers the arbiter index from the column list. Two shapes it cannot
 * infer, both of which raise SQLSTATE 42P10 at PLAN time — before any row is
 * touched, so no amount of data setup avoids it, and every call to the statement
 * fails 100% of the time:
 *
 *   PARTIAL — the only unique index over those columns carries a predicate.
 *   `uniq_chat_messages_client_key` is `... WHERE client_key IS NOT NULL`
 *   (migration 0980) and `chat-messages.service.ts` named the three columns with
 *   no predicate, so EVERY chat send 500'd at journal head. The insert builder
 *   emits the `on conflict` clause unconditionally, so sends that carried no
 *   client key died too.
 *
 *   ABSENT — no unique index, unique constraint or primary key covers the
 *   columns at all.
 *
 * A mocked-database unit test cannot see either: the error comes from Postgres's
 * own index inference, and a fake answers whatever it was told to answer.
 * `chat-send-idempotency.spec.ts` asserted the exact broken target and passed.
 *
 * Drizzle's two builders spell the arbiter predicate differently, which is its
 * own trap: `onConflictDoNothing` takes `{ target, where }` and
 * `onConflictDoUpdate` takes `{ target, targetWhere, setWhere }` (drizzle-orm
 * 0.45.2). A `targetWhere` handed to `onConflictDoNothing` through a shared
 * const is silently dropped and emits the broken SQL again.
 *
 * Usage:
 *   node -r ts-node/register/transpile-only src/scripts/check-conflict-target-inference.ts
 *   node -r ts-node/register/transpile-only src/scripts/check-conflict-target-inference.ts --self-test
 *
 * Exit codes:
 *   0  no violation outside the shrink-only KNOWN_OPEN ratchet below
 *   1  a new violation, a stale ratchet entry, or a self-test failure
 *   2  INCONCLUSIVE — the scan resolved too little to be meaningful
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import * as ts from "typescript";
import { getTableConfig, PgTable, pgTable, text, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const SELF_TEST = process.argv.includes("--self-test");
const REPO_ROOT = join(__dirname, "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const SCHEMA_ROOT = join(SRC_ROOT, "db", "schema");

/**
 * Floors, not targets. A rename of `onConflictDoNothing`, a move of the schema
 * folder or a broken table registry would otherwise leave this gate scanning
 * nothing and reporting clean.
 */
const MIN_TARGETED_SITES = 100;
const MIN_RESOLVED_SITES = 100;
const MIN_PARTIAL_INDEX_TARGETS = 5;

/**
 * Shrink-only ratchet. Each entry is a CONFIRMED 42P10 at journal head, verified
 * against the live catalog on 2026-09-03, that sits outside the chat territory
 * this gate shipped with. Removing a fix from the list is mandatory: an entry
 * that no longer violates fails the gate, so the list cannot rot.
 */
const KNOWN_OPEN: ReadonlyArray<{ file: string; signature: string; note: string }> = [
  {
    file: "src/modules/hr/time/rosters.service.ts",
    signature: "roster_entries(roster_id,user_membership_id,date)",
    note: "No unique index in the declaration OR the catalog. upsertRosterEntry 42P10s on every call. Needs a migration, not just a predicate. Owner: hr.",
  },
];

type SourceFile = { path: string; text: string };
type Site = {
  path: string;
  line: number;
  method: "onConflictDoNothing" | "onConflictDoUpdate";
  tableExpr: string | null;
  targetExprs: string[];
  hasPredicate: boolean;
  predicateKey: string | null;
};
type Violation = { site: string; kind: "partial" | "absent" | "wrong-key"; detail: string };

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/**
 * Drizzle keeps an index's name, uniqueness, columns and partial predicate on an
 * internal `config` object it does not type publicly. Read by narrowing from
 * `unknown` rather than asserting a shape: an assertion here would keep compiling
 * after Drizzle moved the field, and the gate would silently see no partial index
 * anywhere and report clean.
 */
function readProp(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Reflect.get(value, key);
}

function asName(value: unknown): string {
  return typeof value === "string" ? value : "";
}

type IndexShape = { name: string; unique: boolean; partial: boolean; columns: string[] };

function readIndexShape(index: unknown): IndexShape {
  const config = readProp(index, "config");
  const rawColumns = readProp(config, "columns");
  return {
    name: asName(readProp(config, "name")),
    unique: readProp(config, "unique") === true,
    partial: readProp(config, "where") !== undefined,
    columns: Array.isArray(rawColumns) ? rawColumns.map((column) => asName(readProp(column, "name"))) : [],
  };
}

/**
 * Every pgTable exported anywhere under db/schema, not just the root barrel.
 * `attendanceEventLocators` is a live table that the barrel deliberately does not
 * re-export, and a barrel-only registry silently skips its call site.
 */
function buildTableRegistry(): Map<string, PgTable> {
  const loadModule = createRequire(__filename);
  const registry = new Map<string, PgTable>();
  for (const file of walkTs(SCHEMA_ROOT)) {
    if (file.endsWith(".spec.ts")) continue;
    let mod: Array<[string, unknown]>;
    try {
      const loaded: unknown = loadModule(file);
      if (typeof loaded !== "object" || loaded === null) continue;
      mod = Object.entries(loaded);
    } catch {
      continue;
    }
    for (const [name, value] of mod)
      if (value instanceof PgTable && !registry.has(name)) registry.set(name, value);
  }
  return registry;
}

function readConflictConfig(
  obj: ts.ObjectLiteralExpression,
  src: ts.SourceFile,
): { targetExprs: string[] | null; hasPredicate: boolean; predicateKey: string | null } {
  let targetExprs: string[] | null = null;
  let hasPredicate = false;
  let predicateKey: string | null = null;
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) || !prop.name) continue;
    const key = prop.name.getText(src);
    if (key === "target") {
      const init = prop.initializer;
      targetExprs = ts.isArrayLiteralExpression(init)
        ? init.elements.map((e) => e.getText(src).replace(/\s+/g, ""))
        : [init.getText(src).replace(/\s+/g, "")];
    }
    if (key === "where" || key === "targetWhere") {
      hasPredicate = true;
      predicateKey = key;
    }
  }
  return { targetExprs, hasPredicate, predicateKey };
}

function insertedTableExpr(call: ts.CallExpression, src: ts.SourceFile): string | null {
  let cur: ts.Node = call.expression;
  for (let hop = 0; hop < 60; hop++) {
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isCallExpression(cur)) {
      if (ts.isPropertyAccessExpression(cur.expression) && cur.expression.name.text === "insert")
        return cur.arguments[0]?.getText(src).replace(/\s+/g, "") ?? null;
      cur = cur.expression;
      continue;
    }
    if (ts.isAwaitExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    return null;
  }
  return null;
}

export function collectSites(sources: SourceFile[]): { sites: Site[]; totalCalls: number } {
  const configConsts = new Map<string, { targetExprs: string[]; hasPredicate: boolean; predicateKey: string | null }>();
  const pending: Array<Site & { constName: string | null }> = [];
  let totalCalls = 0;

  for (const source of sources) {
    const src = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.ES2022, true);
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        let init: ts.Node = node.initializer;
        while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
        if (ts.isObjectLiteralExpression(init)) {
          const cfg = readConflictConfig(init, src);
          if (cfg.targetExprs) configConsts.set(node.name.text, { ...cfg, targetExprs: cfg.targetExprs });
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (method === "onConflictDoNothing" || method === "onConflictDoUpdate") {
          totalCalls += 1;
          const arg = node.arguments[0];
          let cfg: { targetExprs: string[] | null; hasPredicate: boolean; predicateKey: string | null } = {
            targetExprs: null,
            hasPredicate: false,
            predicateKey: null,
          };
          let constName: string | null = null;
          if (arg && ts.isObjectLiteralExpression(arg)) cfg = readConflictConfig(arg, src);
          else if (arg && ts.isIdentifier(arg)) constName = arg.text;
          if (cfg.targetExprs || constName) {
            const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
            pending.push({
              path: source.path,
              line: line + 1,
              method,
              tableExpr: insertedTableExpr(node, src),
              targetExprs: cfg.targetExprs ?? [],
              hasPredicate: cfg.hasPredicate,
              predicateKey: cfg.predicateKey,
              constName,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
  }

  const sites: Site[] = [];
  for (const p of pending) {
    if (p.constName) {
      const resolved = configConsts.get(p.constName);
      // Not dropped when it cannot be resolved: a silently skipped site is a hole the
      // gate cannot see. It surfaces as unresolved and counts against the floors.
      if (resolved) {
        p.targetExprs = resolved.targetExprs;
        p.hasPredicate = resolved.hasPredicate;
        p.predicateKey = resolved.predicateKey;
      } else {
        p.targetExprs = [`<unresolved const ${p.constName}>`];
      }
    }
    if (p.targetExprs.length > 0) {
      const { constName: _drop, ...site } = p;
      sites.push(site);
    }
  }
  return { sites, totalCalls };
}

type Analysis = {
  violations: Violation[];
  resolved: number;
  unresolved: string[];
  partialTargets: number;
};

export function analyse(sites: Site[], registry: Map<string, PgTable>): Analysis {
  const violations: Violation[] = [];
  const unresolved: string[] = [];
  let resolved = 0;
  let partialTargets = 0;

  for (const site of sites) {
    const where = `${site.path}:${site.line}`;
    const table = site.tableExpr ? registry.get(site.tableExpr) : undefined;
    if (!table) {
      unresolved.push(`${where} (table ${site.tableExpr ?? "?"})`);
      continue;
    }
    const cfg = getTableConfig(table);

    const columns: string[] = [];
    let columnsResolved = true;
    for (const expr of site.targetExprs) {
      const dot = expr.indexOf(".");
      const owner = dot > 0 ? registry.get(expr.slice(0, dot)) : undefined;
      const columnName = asName(readProp(owner ? readProp(owner, expr.slice(dot + 1)) : undefined, "name"));
      if (columnName === "") {
        columnsResolved = false;
        break;
      }
      columns.push(columnName);
    }
    if (!columnsResolved) {
      unresolved.push(`${where} (columns ${site.targetExprs.join(",")})`);
      continue;
    }
    resolved += 1;

    const key = columns.join(",");
    const uniqueIndexes = cfg.indexes
      .map(readIndexShape)
      .filter((index) => index.unique && index.columns.join(",") === key);
    const partial = uniqueIndexes.filter((index) => index.partial);
    const hasFullIndex = uniqueIndexes.length > partial.length;
    const hasUniqueConstraint = cfg.uniqueConstraints.some((u) => u.columns.map((c) => c.name).join(",") === key);
    const compositePk = cfg.primaryKeys.flatMap((p) => p.columns.map((c) => c.name)).join(",");
    const singlePk = cfg.columns.filter((c) => c.primary).map((c) => c.name).join(",");
    const isPk = key.length > 0 && (key === compositePk || key === singlePk);
    const isColumnUnique =
      columns.length === 1 &&
      cfg.columns.some((column) => column.name === columns[0] && readProp(column, "isUnique") === true);

    if (partial.length > 0) partialTargets += 1;

    const inferableWithoutPredicate = hasFullIndex || hasUniqueConstraint || isPk || isColumnUnique;

    if (!inferableWithoutPredicate && partial.length === 0) {
      violations.push({
        site: where,
        kind: "absent",
        detail: `${cfg.name}(${key}) matches no unique index, unique constraint or primary key — 42P10 on every call`,
      });
      continue;
    }

    if (partial.length > 0 && !hasFullIndex && !hasUniqueConstraint && !isPk && !isColumnUnique) {
      const names = partial.map((index) => index.name).join(", ");
      if (!site.hasPredicate) {
        violations.push({
          site: where,
          kind: "partial",
          detail: `${cfg.name}(${key}) can only be arbitrated by PARTIAL index ${names}; the conflict target carries no predicate — 42P10 on every call`,
        });
        continue;
      }
      const expected = site.method === "onConflictDoNothing" ? "where" : "targetWhere";
      if (site.predicateKey !== expected) {
        violations.push({
          site: where,
          kind: "wrong-key",
          detail: `${cfg.name}(${key}) targets PARTIAL index ${names} but spells the arbiter predicate "${site.predicateKey}"; ${site.method} reads "${expected}" and drops the rest — 42P10 on every call`,
        });
      }
    }
  }

  return { violations, resolved, unresolved, partialTargets };
}

function selfTest(): number {
  const parent = pgTable("gate_conflict_parent", {
    orgId: text("org_id").notNull(),
    key: text("key"),
    other: integer("other"),
  }, (t) => [uniqueIndex("uq_gate_partial").on(t.orgId, t.key).where(sql`key is not null`)]);
  const solid = pgTable("gate_conflict_solid", {
    orgId: text("org_id").notNull(),
    key: text("key"),
  }, (t) => [uniqueIndex("uq_gate_full").on(t.orgId, t.key)]);
  const registry = new Map<string, PgTable>([["parent", parent], ["solid", solid]]);

  const fixture: SourceFile[] = [
    {
      path: "fixture.ts",
      text: `
        const BAD_DO_NOTHING = db.insert(parent).values(v)
          .onConflictDoNothing({ target: [parent.orgId, parent.key] });
        const BAD_DO_UPDATE = db.insert(parent).values(v)
          .onConflictDoUpdate({ target: [parent.orgId, parent.key], set: {} });
        const WRONG_KEY = db.insert(parent).values(v)
          .onConflictDoNothing({ target: [parent.orgId, parent.key], targetWhere: sql\`key is not null\` });
        const GOOD = db.insert(parent).values(v)
          .onConflictDoNothing({ target: [parent.orgId, parent.key], where: sql\`key is not null\` });
        const GOOD_UPDATE = db.insert(parent).values(v)
          .onConflictDoUpdate({ target: [parent.orgId, parent.key], targetWhere: sql\`key is not null\`, set: {} });
        const FULL_INDEX_OK = db.insert(solid).values(v)
          .onConflictDoNothing({ target: [solid.orgId, solid.key] });
        const ABSENT = db.insert(solid).values(v)
          .onConflictDoNothing({ target: [solid.orgId, solid.orgId] });
        const SHARED = { target: [parent.orgId, parent.key] };
        const VIA_CONST = db.insert(parent).values(v).onConflictDoNothing(SHARED);
      `,
    },
  ];

  const { sites } = collectSites(fixture);
  const { violations } = analyse(sites, registry);
  const kinds = violations.map((v) => `${v.site}:${v.kind}`).sort();
  const expected = [
    "fixture.ts:2:partial",
    "fixture.ts:4:partial",
    "fixture.ts:6:wrong-key",
    "fixture.ts:14:absent",
    "fixture.ts:17:partial",
  ].sort();

  const failures: string[] = [];
  if (sites.length !== 8) failures.push(`expected 8 targeted sites in the fixture, saw ${sites.length}`);
  if (JSON.stringify(kinds) !== JSON.stringify(expected))
    failures.push(`violations mismatch:\n  got      ${JSON.stringify(kinds)}\n  expected ${JSON.stringify(expected)}`);

  if (failures.length > 0) {
    console.error("SELF-TEST FAILED");
    for (const f of failures) console.error(`  ${f}`);
    return 1;
  }
  console.log("SELF-TEST PASSED — the known-bad fixture is flagged and the correct forms are not.");
  console.log(`  partial-without-predicate: 3   wrong-predicate-key: 1   absent-index: 1   clean: 3`);
  return 0;
}

function main(): number {
  if (SELF_TEST) return selfTest();

  const registry = buildTableRegistry();
  const sources = walkTs(SRC_ROOT).map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const { sites, totalCalls } = collectSites(sources);
  const normalised = sites.map((s) => ({ ...s, path: relative(REPO_ROOT, s.path) }));
  const { violations, resolved, unresolved, partialTargets } = analyse(normalised, registry);

  console.log(`onConflict calls scanned      : ${totalCalls}`);
  console.log(`  with an explicit target     : ${sites.length}`);
  console.log(`  table + columns resolved    : ${resolved}`);
  console.log(`  targeting a PARTIAL index   : ${partialTargets}`);
  console.log(`  unresolved (not judged)     : ${unresolved.length}`);
  for (const u of unresolved) console.log(`      ${u}`);

  if (sites.length < MIN_TARGETED_SITES || resolved < MIN_RESOLVED_SITES || partialTargets < MIN_PARTIAL_INDEX_TARGETS) {
    console.error(
      `\nINCONCLUSIVE — the scan is below its anti-vacuity floors ` +
        `(targeted ${sites.length}/${MIN_TARGETED_SITES}, resolved ${resolved}/${MIN_RESOLVED_SITES}, ` +
        `partial ${partialTargets}/${MIN_PARTIAL_INDEX_TARGETS}). It is not reporting clean; it is not reporting.`,
    );
    return 2;
  }

  // Keyed by file + table(columns), never by line: a line shift elsewhere in the file
  // would otherwise read as "fixed" and fail the gate for the wrong reason.
  const knownFor = (v: Violation) =>
    KNOWN_OPEN.find((k) => v.site.startsWith(`${k.file}:`) && v.detail.startsWith(k.signature));
  // Specs deliberately hold the broken form as a negative fixture — the chat regression
  // spec executes it to prove 42P10 still fires. A spec that gets this wrong fails
  // loudly when it runs, so it is reported but not fatal; production code is fatal.
  const inTests = (site: string) => /\.spec\.ts:/.test(site) || site.includes("__tests__/");
  const testSites = violations.filter((v) => inTests(v.site) && !knownFor(v));
  const fresh = violations.filter((v) => !knownFor(v) && !inTests(v.site));
  const stillOpen = violations.filter((v) => knownFor(v) !== undefined);
  const stale = KNOWN_OPEN.filter((k) => !violations.some((v) => knownFor(v) === k)).map(
    (k) => `${k.file} — ${k.signature}`,
  );

  if (testSites.length > 0) {
    console.log(`\nIN TEST CODE (${testSites.length}) — negative fixtures, reported not enforced:`);
    for (const v of testSites) console.log(`  [${v.kind}] ${v.site}`);
  }

  if (stillOpen.length > 0) {
    console.log(`\nKNOWN OPEN DEFECTS (${stillOpen.length}) — each 42P10s on every call, ratcheted not accepted:`);
    for (const v of stillOpen) console.log(`  ${v.site}\n    ${v.detail}\n    ${knownFor(v)?.note ?? ""}`);
  }

  if (stale.length > 0) {
    console.error(`\nSTALE RATCHET ENTRIES (${stale.length}) — fixed, so delete them from KNOWN_OPEN:`);
    for (const s of stale) console.error(`  ${s}`);
  }

  if (fresh.length > 0) {
    console.error(`\nNEW VIOLATIONS (${fresh.length}) — ON CONFLICT targets Postgres cannot infer:`);
    for (const v of fresh) console.error(`  [${v.kind}] ${v.site}\n    ${v.detail}`);
  }

  if (fresh.length > 0 || stale.length > 0) return 1;
  console.log(`\nPASS — no new uninferable ON CONFLICT target (${stillOpen.length} ratcheted, shrink-only).`);
  return 0;
}

if (require.main === module) process.exit(main());
