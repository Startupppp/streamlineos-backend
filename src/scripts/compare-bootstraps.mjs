/**
 * compare-bootstraps.mjs
 *
 * Compare two cold-bootstrap databases against each other on all eight catalog
 * classes required by PRD §4: tables, columns, constraints, indexes, policies,
 * functions, triggers, extensions. Also reports enums and RLS-enabled tables
 * for completeness.
 *
 * Usage:
 *   node src/scripts/compare-bootstraps.mjs \
 *     --a=postgresql://.../scratch_boot_b?sslmode=require \
 *     --b=postgresql://.../scratch_boot_c?sslmode=require \
 *     [--show=20] [--self-test]
 *
 * Exit codes:
 *   0  All catalog categories identical
 *   1  Differences found or comparison failed
 *   2  Missing arguments
 */
import postgres from "postgres";
import { diff } from "./compare-cell-schema.mjs";

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes("--self-test");
const SHOW = Number(
  (argv.find((a) => a.startsWith("--show=")) ?? "--show=20").slice("--show=".length),
);

if (SELF_TEST) {
  const d = diff(["a", "b"], ["a", "c"]);
  const ok = d.missing.length === 1 && d.missing[0] === "b" && d.extra.length === 1 && d.extra[0] === "c";
  process.stdout.write(JSON.stringify({ selfTest: true, pass: ok }) + "\n");
  process.exit(ok ? 0 : 1);
}

const argA = argv.find((a) => a.startsWith("--a="))?.slice("--a=".length);
const argB = argv.find((a) => a.startsWith("--b="))?.slice("--b=".length);

if (!argA || !argB) {
  process.stderr.write("Usage: compare-bootstraps.mjs --a=<url> --b=<url>\n");
  process.exit(2);
}

const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast", "drizzle"];

const QUERIES = {
  tables: (sql) => sql`
    SELECT schemaname || '.' || tablename AS k FROM pg_tables
    WHERE schemaname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,

  columns: (sql) => sql`
    SELECT n.nspname || '.' || c.relname || '.' || a.attname || ':'
           || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull AS k
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND n.nspname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,

  constraints: (sql) => sql`
    SELECT n.nspname || '.' || c.relname || '.' || k.conname || ':' || k.contype::text AS k
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,

  indexes: (sql) => sql`
    SELECT schemaname || '.' || indexname AS k FROM pg_indexes
    WHERE schemaname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,

  policies: (sql) => sql`
    SELECT schemaname || '.' || tablename || '.' || policyname AS k
    FROM pg_policies ORDER BY k`,

  functions: (sql) => sql`
    SELECT n.nspname || '.' || p.proname AS k
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,

  triggers: (sql) => sql`
    SELECT n.nspname || '.' || c.relname || '.' || t.tgname AS k
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,

  extensions: (sql) => sql`
    SELECT extname AS k FROM pg_extension
    WHERE extname NOT IN ('plpgsql') ORDER BY k`,

  enums: (sql) => sql`
    SELECT t.typname || ':' || e.enumlabel AS k
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid ORDER BY k`,

  rlsEnabled: (sql) => sql`
    SELECT n.nspname || '.' || c.relname AS k
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relrowsecurity AND n.nspname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,
};

function connect(url) {
  return postgres(url, { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 60 });
}

async function collect(url, label) {
  const sql = connect(url);
  try {
    const out = { label };
    for (const [name, query] of Object.entries(QUERIES))
      out[name] = (await query(sql)).map((row) => row.k);
    out.replayRows = (await sql`
      SELECT count(*)::int n FROM drizzle.__replay
    `.catch(() => [{ n: -1 }]))[0].n;
    return out;
  } finally {
    await sql.end();
  }
}

const [a, b] = await Promise.all([collect(argA, "A"), collect(argB, "B")]);

console.log(`\nBootstrap parity comparison`);
console.log(`  A: ${argA}`);
console.log(`  B: ${argB}`);
console.log(`  A replay rows: ${a.replayRows}`);
console.log(`  B replay rows: ${b.replayRows}\n`);

let totalDifferences = 0;

for (const name of Object.keys(QUERIES)) {
  const d = diff(a[name], b[name]);
  const ok = d.missing.length === 0 && d.extra.length === 0;
  totalDifferences += d.missing.length + d.extra.length;

  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name.padEnd(16)}` +
    `  A=${String(a[name].length).padStart(6)}` +
    `  B=${String(b[name].length).padStart(6)}` +
    `${ok ? "" : `  missing-in-B=${d.missing.length} extra-in-B=${d.extra.length}`}`,
  );

  for (const k of d.missing.slice(0, SHOW)) console.log(`        MISSING IN B  ${k}`);
  if (d.missing.length > SHOW) console.log(`        … ${d.missing.length - SHOW} more missing`);
  for (const k of d.extra.slice(0, SHOW)) console.log(`        ONLY IN B     ${k}`);
  if (d.extra.length > SHOW) console.log(`        … ${d.extra.length - SHOW} more extra`);
}

console.log(
  `\nRESULT: ${totalDifferences === 0 ? "SCHEMAS IDENTICAL" : "SCHEMAS DIFFER"}  differences=${totalDifferences}`,
);
if (totalDifferences > 0) process.exitCode = 1;
