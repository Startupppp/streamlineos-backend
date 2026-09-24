/**
 * drill:rollback — executes each migration rollback against a live database inside a
 * transaction that is then rolled back, and reports which ones actually run.
 *
 * check:migration-rollback verifies that a .down.sql exists and that its type names line
 * up. It says so itself, and names this script as the thing that executes them. This script
 * did not exist. The 1174 rollback was green under that gate and could not run: it recreated
 * one of the eight tables it dropped and omitted the UNIQUE its own next statement's foreign
 * key referenced, so it aborted at statement 4 with two enum types already created.
 *
 * Nothing here commits. Every statement runs inside `BEGIN` and the transaction is rolled
 * back whether the drill passes or fails, so it is safe against production — which is where
 * DATABASE_URL points. The opt-in env var is required anyway, because "safe" is a claim
 * about this file and the operator should not have to take it on faith.
 */
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

const ROLLBACK_DIR = path.resolve(process.cwd(), "migrations/rollback");
const JOURNAL = path.resolve(process.cwd(), "migrations/meta/_journal.json");
const OPT_IN = "ALLOW_PRODUCTION_ROLLBACK_DRILL";
const SENTINEL = "DRILL_ROLLBACK_SENTINEL";

const NOT_APPLICABLE_CODES = new Set([
  "42P07",
  "42710",
  "42P06",
  "42723",
]);

export function parseStatements(source) {
  return source
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0 && !/^(--[^\n]*\n?)+$/.test(chunk));
}

export function strippedOfComments(source) {
  return source.replace(/--[^\n]*/g, "");
}

/**
 * Qualifies every name it returns. Build-module tables live in schema `build`, not `public`
 * — a pattern that only strips a `public.` prefix reads `build.pm_workspaces` as a table
 * called `build`, then reports the rollback broken for not creating it.
 */
export function objectsCreatedBy(source) {
  const bare = strippedOfComments(source);
  const qualify = (schema, name) => `${(schema ?? "public").replace(/"/g, "")}.${name}`;
  const tables = [
    ...bare.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[a-z0-9_]+"?)\s*\.\s*"?([a-z0-9_]+)"?/gi),
  ].map((m) => qualify(m[1], m[2]));
  const unqualifiedTables = [
    ...bare.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?\s*\(/gi),
  ].map((m) => qualify(null, m[1]));
  const types = [
    ...bare.matchAll(/CREATE\s+TYPE\s+(?:("?[a-z0-9_]+"?)\s*\.\s*)?"?([a-z0-9_]+)"?/gi),
  ].map((m) => m[2]);
  return {
    tables: [...new Set([...tables, ...unqualifiedTables])],
    types: [...new Set(types)],
  };
}

export function classifyFailure(code) {
  if (code === undefined || code === null) return "broken";
  return NOT_APPLICABLE_CODES.has(code) ? "not-applicable" : "broken";
}

export function verdictFor({ failureCode, missingTables, missingTypes, statementCount, declaredCount = 0 }) {
  if (failureCode !== undefined) {
    const kind = classifyFailure(failureCode);
    return kind === "not-applicable"
      ? { verdict: "skipped", detail: `state already holds the objects (${failureCode}) — its migration is not applied` }
      : { verdict: "broken", detail: `a statement raised ${failureCode}` };
  }
  const missing = [...missingTables, ...missingTypes];
  if (missing.length > 0) {
    return { verdict: "broken", detail: `ran, but did not recreate: ${missing.join(", ")}` };
  }
  return declaredCount === 0
    ? {
        verdict: "ran",
        detail: `${statementCount} statement(s) executed; it creates no table or type, so only execution is proven`,
      }
    : {
        verdict: "ran",
        detail: `${statementCount} statement(s), all ${declaredCount} declared object(s) recreated`,
      };
}

export function exitCodeFor(results) {
  return results.some((r) => r.verdict === "broken") ? 1 : 0;
}

function rollbackFiles() {
  if (!fs.existsSync(ROLLBACK_DIR)) return [];
  return fs
    .readdirSync(ROLLBACK_DIR)
    .filter((name) => name.endsWith(".down.sql"))
    .sort()
    .map((name) => ({ tag: name.replace(/\.down\.sql$/, ""), file: path.join(ROLLBACK_DIR, name) }));
}

function journalTags() {
  if (!fs.existsSync(JOURNAL)) return new Set();
  const journal = JSON.parse(fs.readFileSync(JOURNAL, "utf8"));
  return new Set(journal.entries.map((e) => e.tag));
}

async function drillOne(sql, { tag, file }) {
  const source = fs.readFileSync(file, "utf8");
  const statements = parseStatements(source);
  const declared = objectsCreatedBy(source);

  let failureCode;
  let failureMessage;
  const missingTables = [];
  const missingTypes = [];

  try {
    await sql.begin(async (tx) => {
      for (const statement of statements) {
        await tx.unsafe(statement);
      }

      for (const table of declared.tables) {
        const [row] = await tx`SELECT to_regclass(${table})::text AS t`;
        if (row.t === null) missingTables.push(table);
      }
      for (const type of declared.types) {
        const [row] = await tx`SELECT count(*)::int AS n FROM pg_type WHERE typname = ${type}`;
        if (row.n === 0) missingTypes.push(type);
      }

      throw new Error(SENTINEL);
    });
  } catch (err) {
    if (err.message !== SENTINEL) {
      failureCode = err.code ?? null;
      failureMessage = err.message;
    }
  }

  const { verdict, detail } = verdictFor({
    failureCode,
    missingTables,
    missingTypes,
    statementCount: statements.length,
    declaredCount: declared.tables.length + declared.types.length,
  });

  return {
    tag,
    verdict,
    detail,
    statements: statements.length,
    declaredTables: declared.tables.length,
    declaredTypes: declared.types.length,
    ...(failureMessage ? { failureMessage } : {}),
  };
}

async function verifyNothingPersisted(sql, results, filesByTag) {
  const leaked = [];
  for (const result of results) {
    if (result.verdict !== "ran") continue;
    const source = fs.readFileSync(filesByTag.get(result.tag), "utf8");
    for (const table of objectsCreatedBy(source).tables) {
      const [row] = await sql`SELECT to_regclass(${table})::text AS t`;
      if (row.t !== null) leaked.push(`${result.tag}:${table}`);
    }
  }
  return leaked;
}

function runSelfTest() {
  const out = (s) => process.stdout.write(s + "\n");
  out("self-test: fixture verification for drill-rollback\n");

  const cases = [
    {
      label: "statements drop comment-only chunks",
      actual: () => parseStatements("-- header\n--> statement-breakpoint\nSELECT 1;").length,
      expect: 1,
    },
    {
      label: "statements keep every real statement",
      actual: () => parseStatements("SELECT 1;\n--> statement-breakpoint\nSELECT 2;").length,
      expect: 2,
    },
    {
      label: "created tables are read off CREATE TABLE IF NOT EXISTS",
      actual: () => objectsCreatedBy('CREATE TABLE IF NOT EXISTS "public"."kb_articles" (id serial);').tables.join(),
      expect: "public.kb_articles",
    },
    {
      label: "a build-schema table keeps its schema, so build.pm_workspaces is not read as a table named build",
      actual: () => objectsCreatedBy('CREATE TABLE IF NOT EXISTS "build"."pm_workspaces" (id serial);').tables.join(),
      expect: "build.pm_workspaces",
    },
    {
      label: "an unqualified CREATE TABLE is assumed public, matching the runner's search_path",
      actual: () => objectsCreatedBy("CREATE TABLE kb_notes (id serial);").tables.join(),
      expect: "public.kb_notes",
    },
    {
      label: "a table named only inside a comment is not counted",
      actual: () => objectsCreatedBy('-- CREATE TABLE "public"."imaginary" (x int)\nSELECT 1;').tables.length,
      expect: 0,
    },
    {
      label: "created types are read off CREATE TYPE",
      actual: () => objectsCreatedBy(`CREATE TYPE "public"."kb_article_status" AS ENUM ('draft');`).types.join(),
      expect: "kb_article_status",
    },
    {
      label: "duplicate-object codes mean the migration is not applied, not a broken rollback",
      actual: () => classifyFailure("42P07"),
      expect: "not-applicable",
    },
    {
      label: "a missing-unique failure is a broken rollback",
      actual: () => classifyFailure("42830"),
      expect: "broken",
    },
    {
      label: "an error with no SQLSTATE is broken, never skipped",
      actual: () => classifyFailure(undefined),
      expect: "broken",
    },
    {
      label: "a rollback that runs and recreates everything passes",
      actual: () => verdictFor({ missingTables: [], missingTypes: [], statementCount: 43, declaredCount: 10 }).verdict,
      expect: "ran",
    },
    {
      label: "a rollback that creates nothing says only execution is proven, never that objects came back",
      actual: () =>
        /only execution is proven/.test(
          verdictFor({ missingTables: [], missingTypes: [], statementCount: 2, declaredCount: 0 }).detail,
        ),
      expect: true,
    },
    {
      label: "a rollback that does recreate objects reports the count instead",
      actual: () =>
        /all 10 declared object\(s\) recreated/.test(
          verdictFor({ missingTables: [], missingTypes: [], statementCount: 43, declaredCount: 10 }).detail,
        ),
      expect: true,
    },
    {
      label: "a rollback that runs but recreates one of eight tables is broken",
      actual: () =>
        verdictFor({
          missingTables: ["kb_article_tags", "kb_article_versions"],
          missingTypes: [],
          statementCount: 7,
        }).verdict,
      expect: "broken",
    },
    {
      label: "a duplicate-object failure is skipped rather than failed",
      actual: () => verdictFor({ failureCode: "42P07", missingTables: [], missingTypes: [] }).verdict,
      expect: "skipped",
    },
    {
      label: "one broken rollback fails the drill",
      actual: () => exitCodeFor([{ verdict: "ran" }, { verdict: "broken" }]),
      expect: 1,
    },
    {
      label: "skipped rollbacks alone do not fail the drill",
      actual: () => exitCodeFor([{ verdict: "ran" }, { verdict: "skipped" }]),
      expect: 0,
    },
  ];

  let errors = 0;
  for (const { label, actual, expect } of cases) {
    const got = actual();
    const ok = got === expect;
    if (!ok) errors += 1;
    out(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — expected ${expect}, got ${got}`}`);
  }

  out(`\n${cases.length - errors}/${cases.length} fixture(s) behaved as specified`);
  if (errors > 0) {
    out("drill:rollback self-test FAILED");
    process.exit(1);
  }
  out("drill:rollback self-test PASSED");
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return runSelfTest();

  const tagArg = argv.find((a) => a.startsWith("--tag="));
  const files = rollbackFiles();
  const known = journalTags();
  const selected = tagArg
    ? files.filter((f) => f.tag === tagArg.slice("--tag=".length))
    : files.filter((f) => known.has(f.tag));

  if (argv.includes("--list")) {
    for (const f of selected) process.stdout.write(`${f.tag}\n`);
    return;
  }

  if (selected.length === 0) {
    process.stdout.write("drill:rollback found no rollback file to run.\n");
    if (tagArg) process.exitCode = 1;
    return;
  }

  if (!process.env.DATABASE_URL) {
    process.stdout.write("drill:rollback needs DATABASE_URL. Nothing was run.\n");
    process.exitCode = 1;
    return;
  }

  if (process.env[OPT_IN] !== "1") {
    process.stdout.write(
      `drill:rollback executes SQL against DATABASE_URL, which points at production here.\n` +
        `Every statement runs inside a transaction that is rolled back and nothing is committed,\n` +
        `but set ${OPT_IN}=1 to acknowledge that deliberately. Nothing was run.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const sql = postgres(process.env.DATABASE_URL, {
    ssl: { rejectUnauthorized: false },
    prepare: false,
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
    connection: { search_path: '"$user", public, build_events, app' },
  });

  const results = [];
  const filesByTag = new Map(selected.map((f) => [f.tag, f.file]));
  try {
    for (const entry of selected) {
      results.push(await drillOne(sql, entry));
    }
    const leaked = await verifyNothingPersisted(sql, results, filesByTag);
    if (leaked.length > 0) {
      process.stdout.write(`\nFATAL — objects survived the drill: ${leaked.join(", ")}\n`);
      process.exitCode = 1;
      return;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  const ran = results.filter((r) => r.verdict === "ran");
  const skipped = results.filter((r) => r.verdict === "skipped");
  const broken = results.filter((r) => r.verdict === "broken");

  for (const r of results) {
    const mark = r.verdict === "ran" ? "  + " : r.verdict === "skipped" ? "  ~ " : "  ! ";
    process.stdout.write(`${mark}${r.tag} — ${r.detail}\n`);
    if (r.failureMessage) process.stdout.write(`      ${r.failureMessage.split("\n")[0]}\n`);
  }

  process.stdout.write(
    `\n${ran.length} executed, ${skipped.length} skipped (migration not applied), ${broken.length} broken.\n` +
      `Nothing was committed: every statement ran inside a rolled-back transaction, and the\n` +
      `objects each rollback declares were re-checked afterwards and are absent.\n`,
  );

  if (broken.length > 0) {
    process.stdout.write("drill:rollback FAILED\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("drill:rollback PASSED\n");
}

await main();
