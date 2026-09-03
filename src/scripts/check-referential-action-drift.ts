#!/usr/bin/env node
/**
 * Gate: a foreign key's ON DELETE action in the Drizzle declaration must equal the
 * action in the live catalog.
 *
 * NOTHING IN THIS REPO CHECKED THIS. Three gates sit next to the question and each
 * asks something strictly weaker:
 *
 *   check:restrict-fks                  source-only. It never opens a database. It
 *                                       finds FKs DECLARED restrict/no-action and
 *                                       asserts the table appears somewhere in
 *                                       MEMBERSHIP_ARTIFACTS — with ANY onRemoval
 *                                       value. An entry declaring the exact opposite
 *                                       action satisfies it.
 *   check:set-null-column-lists         catalog-only. For FKs that are SET NULL in
 *                                       the catalog it asks whether the column list
 *                                       is present. It never looks at what was
 *                                       declared.
 *   check:declaration-constraint-drift  declaration vs catalog, but EXISTENCE only.
 *                                       Its control C deliberately accepts any live
 *                                       FK to the same parent whose column list
 *                                       CONTAINS the declared one — which is exactly
 *                                       the composite-FK rewrite (1006/1024/1025,
 *                                       ar02_*) — and compares no action at all.
 *
 * So a migration could replace `ON DELETE SET NULL` with `ON DELETE CASCADE` under a
 * declaration that still says `set null`, and every gate stayed green. Removing a
 * member then DELETES their notifications, support history and audit trail instead of
 * orphaning them safely, and the type system cannot see it.
 *
 * VERDICT CLASSES, because they fail differently:
 *
 *   DESTRUCTIVE  declared anything-but-cascade, live CASCADE.
 *                Rows the declaration says survive a parent delete are destroyed.
 *   PERMISSIVE   declared RESTRICT or NO ACTION, live SET NULL / SET DEFAULT.
 *                The parent delete the declaration says is REFUSED actually succeeds
 *                and quietly nulls the child's pointer. Every caller that leans on
 *                the declared protection — "this cannot be deleted while referenced" —
 *                is leaning on nothing.
 *   BLOCKING     declared cascade / set null, live RESTRICT or NO ACTION.
 *                A parent delete the declaration says succeeds raises 23503.
 *   ORPHANING    declared cascade, live SET NULL / SET DEFAULT.
 *                Rows survive holding a null pointer the reader never expects.
 *   WEAK         no action <-> restrict. They differ only in when the check fires
 *                (RESTRICT cannot be deferred); no row is created or destroyed
 *                either way. Reported, never failed.
 *
 * Each hard finding also records whether the declaration was EXPLICIT. An
 * `.onDelete("restrict")` the catalog contradicts is a lie; a bare `.references()`
 * the catalog answers with SET NULL is silence. Both fail, but they are fixed
 * differently, and the split is in the summary line and the --json output.
 *
 * FALSE-POSITIVE CONTROLS, all bite-proved in --self-test:
 *
 *   A. Implicit NO ACTION. Drizzle leaves `onDelete` undefined for a bare
 *      `.references()`, and Postgres stores 'a'. Those agree; treating undefined as
 *      "unknown" would report every undecorated foreign key.
 *   B. Composite coverage. The tenant-anchoring migrations replaced
 *      `(child_id) -> parent(id)` with `(org_id, child_id) -> parent(org_id, id)`
 *      while the declaration still writes the single-column form. The live composite
 *      IS the declared key; it is matched by column-superset to the same parent, and
 *      only then are the actions compared.
 *   C. Unmatched declarations are REPORTED, never failed. "This declared FK does not
 *      exist" is check:declaration-constraint-drift's question, and duplicating its
 *      verdict here would double-count its baseline.
 *
 * Ratchet: today's accepted mismatches live in
 * `baselines/referential-action-drift.json`. The gate fails only on a mismatch that
 * is NOT in it — the case that matters, a referential action changed in this change
 * on one side only. The baseline can only shrink; `--emit-baseline` rewrites it.
 *
 * Usage:
 *   node -r ts-node/register/transpile-only src/scripts/check-referential-action-drift.ts
 *   node -r ts-node/register/transpile-only src/scripts/check-referential-action-drift.ts --self-test
 *   REFERENTIAL_ACTION_GATE_DATABASE_URL=postgresql://… node -r ts-node/register/transpile-only \
 *     src/scripts/check-referential-action-drift.ts [--emit-baseline] [--json=<path>]
 *
 * The URL is a dedicated variable rather than DATABASE_URL so a local run cannot
 * reach the shared instance by inheriting it. The gate only ever SELECTs from
 * pg_catalog, and never prints the connection string.
 *
 * Exit codes:
 *   0  clean, every mismatch baselined, or accepted as PARTIAL via
 *      STREAMLINE_ALLOW_PARTIAL_GATES=1
 *   1  an un-baselined DESTRUCTIVE / PERMISSIVE / BLOCKING / ORPHANING mismatch, or a
 *      self-test failure
 *   2  INCONCLUSIVE — no database, or the scan is vacuous
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";

import * as schema from "../db/schema";

const SELF_TEST = process.argv.includes("--self-test");
const EMIT_BASELINE = process.argv.includes("--emit-baseline");
const JSON_OUT = process.argv
  .find((a) => a.startsWith("--json="))
  ?.slice("--json=".length);
const GATE_URL = process.env.REFERENTIAL_ACTION_GATE_DATABASE_URL;
const ALLOW_PARTIAL = process.env.STREAMLINE_ALLOW_PARTIAL_GATES === "1";
const BASELINE_PATH = resolve(__dirname, "baselines/referential-action-drift.json");

/**
 * Floors, not targets. A barrel rename or a schema move would otherwise leave this
 * gate comparing nothing and reporting clean — the failure mode this repo has hit
 * more than once.
 */
export const MIN_DECLARED_FKS = 1500;
export const MIN_LIVE_FKS = 2000;

export type Action = "cascade" | "restrict" | "no action" | "set null" | "set default";

export type DeclaredFk = {
  readonly table: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly foreignTable: string;
  readonly onDelete: Action;
  readonly stated: Stated;
};

export type LiveFk = {
  readonly table: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly foreignTable: string;
  readonly onDelete: Action;
};

/**
 * Whether the schema SOURCE actually wrote an action.
 *
 * This cannot be read off the Drizzle object model: `foreignKey({...})` with no
 * `.onDelete()` normalises to the string "no action", identical to an explicit
 * `.onDelete("no action")`. Measured, not assumed — a first cut of this gate carried
 * a `declaredExplicit` boolean derived from the object and it was true for 100% of
 * findings, i.e. it measured nothing. The distinction is real and it only lives in
 * the text: an explicit `.onDelete("restrict")` the catalog contradicts is a lie,
 * while a bare `foreignKey({...})` the catalog answers with CASCADE is silence.
 *
 * "unknown" is for inline `.references()` foreign keys, which Drizzle auto-names, so
 * there is no name to find in the source.
 */
export type Stated = "explicit" | "implicit" | "unknown";

export type Verdict = "DESTRUCTIVE" | "PERMISSIVE" | "BLOCKING" | "ORPHANING" | "WEAK";

export type Mismatch = {
  readonly id: string;
  readonly verdict: Verdict;
  readonly table: string;
  readonly declaredName: string;
  readonly liveName: string;
  readonly foreignTable: string;
  readonly declared: Action;
  readonly live: Action;
  readonly matchedBy: "name" | "columns";
  readonly stated: Stated;
  readonly blastRadius: string;
};

/**
 * Control A. Drizzle leaves `onDelete` undefined for a bare `.references()`, and
 * Postgres stores 'a' (NO ACTION) for exactly that declaration. They agree.
 */
export function normalizeDeclared(raw: string | undefined): Action {
  if (raw === undefined || raw === "") return "no action";
  const lowered = raw.toLowerCase().replace(/[-_]/g, " ").trim();
  if (lowered === "cascade") return "cascade";
  if (lowered === "restrict") return "restrict";
  if (lowered === "set null") return "set null";
  if (lowered === "set default") return "set default";
  return "no action";
}

export function normalizeCatalog(code: string): Action {
  if (code === "c") return "cascade";
  if (code === "r") return "restrict";
  if (code === "n") return "set null";
  if (code === "d") return "set default";
  return "no action";
}

export function classify(declared: Action, live: Action): Verdict | null {
  if (declared === live) return null;
  const weakPair =
    (declared === "no action" && live === "restrict") ||
    (declared === "restrict" && live === "no action");
  if (weakPair) return "WEAK";
  if (live === "cascade") return "DESTRUCTIVE";
  if (live === "restrict" || live === "no action") return "BLOCKING";
  if (declared === "cascade") return "ORPHANING";
  return "PERMISSIVE";
}

export function blastRadiusOf(verdict: Verdict, table: string, foreignTable: string): string {
  if (verdict === "DESTRUCTIVE")
    return `deleting a ${foreignTable} row DESTROYS its ${table} rows; the declaration says they survive`;
  if (verdict === "PERMISSIVE")
    return `deleting a ${foreignTable} row SUCCEEDS and NULLs ${table}; the declaration says the delete is refused`;
  if (verdict === "BLOCKING")
    return `deleting a ${foreignTable} row raises 23503 while ${table} rows exist; the declaration says it succeeds`;
  if (verdict === "ORPHANING")
    return `${table} rows survive a ${foreignTable} delete holding NULL; the declaration says they are removed`;
  return `${table} -> ${foreignTable}: NO ACTION vs RESTRICT differ only in deferrability`;
}

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkTs(full);
    else if (entry.endsWith(".ts")) yield full;
  }
}

/**
 * Named foreign keys whose declaration carries an explicit `.onDelete(...)`, and the
 * full set of named foreign keys, read from the schema source text.
 */
export function statedActionsFrom(sources: readonly string[]): {
  explicit: Set<string>;
  named: Set<string>;
} {
  const explicit = new Set<string>();
  const named = new Set<string>();
  for (const text of sources) {
    const flat = text.replace(/\s+/g, " ");
    for (const m of flat.matchAll(/name:\s*"([A-Za-z0-9_]+)"\s*,?\s*\}\s*\)/g)) named.add(m[1] ?? "");
    for (const m of flat.matchAll(/name:\s*"([A-Za-z0-9_]+)"\s*,?\s*\}\s*\)\s*\.onDelete\(/g))
      explicit.add(m[1] ?? "");
  }
  return { explicit, named };
}

export function statedOf(
  name: string,
  sets: { explicit: ReadonlySet<string>; named: ReadonlySet<string> },
): Stated {
  if (sets.explicit.has(name)) return "explicit";
  if (sets.named.has(name)) return "implicit";
  return "unknown";
}

export function declaredFksOf(
  barrel: Readonly<Record<string, unknown>>,
  sets: { explicit: ReadonlySet<string>; named: ReadonlySet<string> },
): DeclaredFk[] {
  const out: DeclaredFk[] = [];
  const seen = new Set<string>();
  for (const exported of Object.values(barrel)) {
    if (!(exported instanceof PgTable)) continue;
    const config = getTableConfig(exported);
    const tableKey = `${config.schema ?? "public"}.${config.name}`;
    if (seen.has(tableKey)) continue;
    seen.add(tableKey);
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      const target = getTableConfig(reference.foreignTable);
      /**
       * Drizzle DECLARES the action: `ForeignKey.onDelete` is
       * `UpdateDeleteAction | undefined` and the constructor assigns it from the
       * builder. The `as unknown as { onDelete?: unknown }` this replaces re-derived
       * a shape the library already publishes, and paid for it twice: the cast made
       * the property invisible to the compiler, so a Drizzle rename would have
       * arrived as every foreign key reading "no action" — a silent all-clear from
       * the gate whose whole job is to notice a changed action — where a plain
       * property read fails the build. Control A is unchanged: `undefined` is the
       * bare `.references()` and normalises to "no action".
       */
      out.push({
        table: config.name,
        name: foreignKey.getName(),
        columns: reference.columns.map((column) => column.name),
        foreignTable: target.name,
        onDelete: normalizeDeclared(foreignKey.onDelete),
        stated: statedOf(foreignKey.getName(), sets),
      });
    }
  }
  return out;
}

export const LIVE_FK_QUERY = `
  SELECT
    cl.relname AS table,
    c.conname AS name,
    tgt.relname AS foreign_table,
    c.confdeltype AS delete_code,
    (SELECT array_agg(a.attname ORDER BY k.ord)
       FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns
  FROM pg_constraint c
  JOIN pg_class cl ON cl.oid = c.conrelid
  JOIN pg_class tgt ON tgt.oid = c.confrelid
  JOIN pg_namespace n ON n.oid = cl.relnamespace
  WHERE c.contype = 'f'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'drizzle')
`;

type LiveRow = {
  table: string;
  name: string;
  foreign_table: string;
  delete_code: string;
  columns: string[] | null;
};

export function liveFksOf(rows: readonly LiveRow[]): LiveFk[] {
  return rows.map((row) => ({
    table: row.table,
    name: row.name,
    columns: row.columns ?? [],
    foreignTable: row.foreign_table,
    onDelete: normalizeCatalog(row.delete_code),
  }));
}

/**
 * Control B. The declared single-column key and the live tenant-anchored composite
 * are the same relationship; the composite's column list is a superset. Prefer an
 * exact name match, then the narrowest superset to the same parent.
 */
export function matchLive(
  declared: DeclaredFk,
  live: readonly LiveFk[],
): { fk: LiveFk; matchedBy: "name" | "columns" } | null {
  const sameTable = live.filter((l) => l.table === declared.table);
  const byName = sameTable.find((l) => l.name === declared.name);
  if (byName !== undefined) return { fk: byName, matchedBy: "name" };

  const declaredCols = new Set(declared.columns);
  const covering = sameTable
    .filter((l) => l.foreignTable === declared.foreignTable)
    .filter((l) => [...declaredCols].every((c) => l.columns.includes(c)))
    .sort((a, b) => a.columns.length - b.columns.length);
  const best = covering[0];
  return best === undefined ? null : { fk: best, matchedBy: "columns" };
}

export function compare(
  declared: readonly DeclaredFk[],
  live: readonly LiveFk[],
): { mismatches: Mismatch[]; matched: number; unmatched: DeclaredFk[] } {
  const mismatches: Mismatch[] = [];
  const unmatched: DeclaredFk[] = [];
  let matched = 0;
  for (const d of declared) {
    const hit = matchLive(d, live);
    if (hit === null) {
      unmatched.push(d);
      continue;
    }
    matched++;
    const verdict = classify(d.onDelete, hit.fk.onDelete);
    if (verdict === null) continue;
    mismatches.push({
      id: `${d.table}.${hit.fk.name}:${d.onDelete}->${hit.fk.onDelete}`,
      verdict,
      table: d.table,
      declaredName: d.name,
      liveName: hit.fk.name,
      foreignTable: d.foreignTable,
      declared: d.onDelete,
      live: hit.fk.onDelete,
      matchedBy: hit.matchedBy,
      stated: d.stated,
      blastRadius: blastRadiusOf(verdict, d.table, d.foreignTable),
    });
  }
  return {
    mismatches: mismatches.sort((a, b) => a.id.localeCompare(b.id)),
    matched,
    unmatched,
  };
}

export function unbaselined(
  mismatches: readonly Mismatch[],
  baseline: ReadonlySet<string>,
): Mismatch[] {
  return mismatches.filter((m) => m.verdict !== "WEAK" && !baseline.has(m.id));
}

function readBaseline(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    if (parsed === null || typeof parsed !== "object" || !("accepted" in parsed)) return new Set();
    const accepted = parsed.accepted;
    if (!Array.isArray(accepted)) return new Set();
    return new Set(accepted.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

function runSelfTest(): void {
  let passed = 0;
  let failed = 0;
  const assert = (name: string, got: unknown, want: unknown): void => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) passed++;
    else failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  };

  assert("control A: undefined declaration is NO ACTION", normalizeDeclared(undefined), "no action");
  assert("declared 'set null' normalises", normalizeDeclared("set null"), "set null");
  assert("declared 'SET NULL' normalises", normalizeDeclared("SET NULL"), "set null");
  assert("declared 'no-action' normalises", normalizeDeclared("no-action"), "no action");
  assert("catalog 'a' is NO ACTION", normalizeCatalog("a"), "no action");
  assert("catalog 'c' is cascade", normalizeCatalog("c"), "cascade");
  assert("catalog 'n' is set null", normalizeCatalog("n"), "set null");
  assert("catalog 'r' is restrict", normalizeCatalog("r"), "restrict");

  assert("control A bites: undefined vs 'a' is agreement", classify(normalizeDeclared(undefined), normalizeCatalog("a")), null);
  assert("set null vs cascade is DESTRUCTIVE", classify("set null", "cascade"), "DESTRUCTIVE");
  assert("set null vs restrict is BLOCKING", classify("set null", "restrict"), "BLOCKING");
  assert("set null vs no action is BLOCKING", classify("set null", "no action"), "BLOCKING");
  assert("restrict vs set null is PERMISSIVE", classify("restrict", "set null"), "PERMISSIVE");
  assert("no action vs set null is PERMISSIVE", classify("no action", "set null"), "PERMISSIVE");
  assert("no action vs cascade is DESTRUCTIVE", classify("no action", "cascade"), "DESTRUCTIVE");
  assert("cascade vs set null is ORPHANING", classify("cascade", "set null"), "ORPHANING");
  assert("no action vs restrict is WEAK", classify("no action", "restrict"), "WEAK");
  assert("restrict vs no action is WEAK", classify("restrict", "no action"), "WEAK");
  assert("identical actions agree", classify("cascade", "cascade"), null);

  const live: LiveFk[] = [
    { table: "kb_space_members", name: "fk_kb_space_members_org_membership", columns: ["org_id", "membership_id"], foreignTable: "organization_members", onDelete: "cascade" },
    { table: "widgets", name: "fk_widgets_owner", columns: ["owner_id"], foreignTable: "users", onDelete: "set null" },
  ];

  const declaredSingleColumn: DeclaredFk = {
    table: "kb_space_members",
    name: "kb_space_members_membership_id_fk",
    columns: ["membership_id"],
    foreignTable: "organization_members",
    onDelete: "set null",
    stated: "explicit",
  };
  const matchedByColumns = matchLive(declaredSingleColumn, live);
  assert("control B: composite covers the declared single column", matchedByColumns?.matchedBy, "columns");
  assert("control B: it matched the composite", matchedByColumns?.fk.name, "fk_kb_space_members_org_membership");

  const report = compare([declaredSingleColumn], live);
  assert("the covered composite is still compared on action", report.mismatches.length, 1);
  assert("and classified DESTRUCTIVE", report.mismatches[0]?.verdict, "DESTRUCTIVE");
  assert("explicitness is carried onto the finding", report.mismatches[0]?.stated, "explicit");
  {
    const sets = statedActionsFrom([
      'foreignKey({ columns: [t.a], foreignColumns: [p.a], name: "fk_stated" }).onDelete("set null"),',
      'foreignKey({\n  columns: [t.b],\n  name: "fk_silent",\n}),',
    ]);
    assert("source scan finds an explicit onDelete", statedOf("fk_stated", sets), "explicit");
    assert("source scan finds a silent named FK", statedOf("fk_silent", sets), "implicit");
    assert("an auto-named inline reference is unknown", statedOf("t_a_p_a_fk", sets), "unknown");
  }
  assert(
    "with a blast radius naming both sides",
    report.mismatches[0]?.blastRadius,
    "deleting a organization_members row DESTROYS its kb_space_members rows; the declaration says they survive",
  );

  const agreeing = compare(
    [{ table: "widgets", name: "fk_widgets_owner", columns: ["owner_id"], foreignTable: "users", onDelete: "set null", stated: "explicit" }],
    live,
  );
  assert("an agreeing pair produces no finding", agreeing.mismatches.length, 0);
  assert("and counts as matched", agreeing.matched, 1);

  const absent = compare(
    [{ table: "nowhere", name: "fk_nowhere", columns: ["x"], foreignTable: "users", onDelete: "cascade", stated: "explicit" }],
    live,
  );
  assert("control C: an unmatched declaration is reported, not failed", absent.mismatches.length, 0);
  assert("control C: and is counted as unmatched", absent.unmatched.length, 1);

  assert(
    "WEAK never fails the gate",
    unbaselined(
      [{ id: "t.fk:no action->restrict", verdict: "WEAK", table: "t", declaredName: "fk", liveName: "fk", foreignTable: "p", declared: "no action", live: "restrict", matchedBy: "name", stated: "implicit", blastRadius: "-" }],
      new Set(),
    ).length,
    0,
  );
  assert(
    "a baselined mismatch never fails the gate",
    unbaselined(report.mismatches, new Set(report.mismatches.map((m) => m.id))).length,
    0,
  );
  assert("an un-baselined mismatch DOES fail the gate", unbaselined(report.mismatches, new Set()).length, 1);

  console.log(`\nSelf-test: ${String(passed)} passed, ${String(failed)} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  if (SELF_TEST) runSelfTest();

  const schemaRoot = resolve(__dirname, "../db/schema");
  const sets = statedActionsFrom([...walkTs(schemaRoot)].map((f) => readFileSync(f, "utf8")));
  console.log(
    `Schema source: ${String(sets.named.size)} named foreign keys, ${String(sets.explicit.size)} of them carrying an explicit .onDelete()`,
  );
  const declared = declaredFksOf({ ...schema }, sets);
  console.log(`Declared foreign keys ${String(declared.length)}`);
  if (declared.length < MIN_DECLARED_FKS) {
    console.error(
      `INCONCLUSIVE — the declaration scan found ${String(declared.length)} foreign keys (floor ${String(MIN_DECLARED_FKS)}). A clean result over an empty scan proves nothing.`,
    );
    process.exit(2);
  }

  if (GATE_URL === undefined || GATE_URL === "") {
    const stream = ALLOW_PARTIAL ? console.warn : console.error;
    stream(
      `${ALLOW_PARTIAL ? "PARTIAL" : "INCONCLUSIVE"} — the catalog half did not run. A foreign key's ON DELETE action lives only in pg_constraint.confdeltype; nothing static can see it, so all ${String(declared.length)} declared foreign keys are UNVERIFIED.`,
    );
    stream("  Set REFERENTIAL_ACTION_GATE_DATABASE_URL to a database bootstrapped to journal head to run it.");
    if (!ALLOW_PARTIAL) {
      console.error("  Or set STREAMLINE_ALLOW_PARTIAL_GATES=1 to accept a declaration-only run.");
      process.exit(2);
    }
    console.warn("  STREAMLINE_ALLOW_PARTIAL_GATES=1 — this run proves nothing about the catalog.");
    return;
  }

  const sql = postgres(GATE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const rows = await sql.unsafe<LiveRow[]>(LIVE_FK_QUERY);
    if (rows.length < MIN_LIVE_FKS) {
      console.error(
        `INCONCLUSIVE — the catalog reports ${String(rows.length)} foreign keys (floor ${String(MIN_LIVE_FKS)}). This database is not bootstrapped to head.`,
      );
      process.exit(2);
    }
    const live = liveFksOf(rows);
    const report = compare(declared, live);
    const weak = report.mismatches.filter((m) => m.verdict === "WEAK");
    const hard = report.mismatches.filter((m) => m.verdict !== "WEAK");

    console.log(
      `Live foreign keys ${String(live.length)}  ·  matched ${String(report.matched)}  ·  unmatched declarations ${String(report.unmatched.length)} (reported, never failed)`,
    );
    console.log(
      `Mismatches ${String(hard.length)} hard + ${String(weak.length)} weak  —  DESTRUCTIVE ${String(hard.filter((m) => m.verdict === "DESTRUCTIVE").length)}  ·  PERMISSIVE ${String(hard.filter((m) => m.verdict === "PERMISSIVE").length)}  ·  BLOCKING ${String(hard.filter((m) => m.verdict === "BLOCKING").length)}  ·  ORPHANING ${String(hard.filter((m) => m.verdict === "ORPHANING").length)}`,
    );
    console.log(
      `Of the ${String(hard.length)} hard findings, ${String(hard.filter((m) => m.stated === "explicit").length)} CONTRADICT an explicit .onDelete() in the schema source, ${String(hard.filter((m) => m.stated === "implicit").length)} sit under a foreignKey() that stated nothing, and ${String(hard.filter((m) => m.stated === "unknown").length)} are auto-named inline references.`,
    );

    if (JSON_OUT !== undefined)
      writeFileSync(JSON_OUT, `${JSON.stringify({ declared: declared.length, live: live.length, matched: report.matched, unmatched: report.unmatched.length, mismatches: report.mismatches }, null, 2)}\n`);

    if (EMIT_BASELINE) {
      writeFileSync(
        BASELINE_PATH,
        `${JSON.stringify(
          {
            note: "ON DELETE actions that disagree between the Drizzle declaration and the catalog at journal head, accepted at the time of writing. The gate fails only on a mismatch NOT listed here. This list can only shrink — every entry is a foreign key whose declared referential action is a lie about what the database does.",
            generated: new Date().toISOString().slice(0, 10),
            accepted: hard.map((m) => m.id).sort(),
          },
          null,
          2,
        )}\n`,
      );
      console.log(`Wrote ${String(hard.length)} accepted mismatches to ${BASELINE_PATH}`);
      return;
    }

    const baseline = readBaseline();
    const fresh = unbaselined(report.mismatches, baseline);
    console.log(`Baseline ${String(baseline.size)}  ·  new ${String(fresh.length)}`);

    for (const m of hard.slice(0, 60))
      console.log(`  ${m.verdict.padEnd(11)} ${m.table}.${m.liveName}  declared=${m.declared}${m.stated === "explicit" ? "" : ` (${m.stated})`} live=${m.live}  (matched by ${m.matchedBy}) — ${m.blastRadius}`);
    if (hard.length > 60) console.log(`  … and ${String(hard.length - 60)} more`);
    for (const m of weak.slice(0, 10))
      console.log(`  WEAK        ${m.table}.${m.liveName}  declared=${m.declared} live=${m.live}`);
    if (weak.length > 10) console.log(`  … and ${String(weak.length - 10)} more weak`);

    if (fresh.length > 0) {
      console.error(
        `\nFAIL — ${String(fresh.length)} foreign key(s) act differently from what the schema declares, and are not baselined:`,
      );
      for (const m of fresh.slice(0, 40))
        console.error(`  ${m.verdict} ${m.table}.${m.liveName} — ${m.blastRadius}`);
      console.error(
        "\nFix: change one side to match the other, deliberately. If the catalog is right, update the Drizzle declaration and MEMBERSHIP_ARTIFACTS. If the declaration is right, write a migration that alters the constraint — and register it in migrations/meta/_journal.json.",
      );
      process.exit(1);
    }
    console.log("Catalog half OK — every declared ON DELETE action matches the catalog, or is baselined.");
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(`check-referential-action-drift: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
