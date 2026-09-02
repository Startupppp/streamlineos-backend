/**
 * compare-bootstraps.mjs
 *
 * Compare two cold-bootstrap databases against each other on every catalog class
 * required by PRD §4 — tables, columns, constraints, indexes, policies, functions,
 * triggers, extensions — plus enums, RLS state, sequences and views.
 *
 * Every category compares the object's DEFINITION, not just its name: a constraint
 * carries pg_get_constraintdef, an index its indexdef, a policy its cmd/roles/qual/
 * with_check, a function its identity arguments, result type and body digest, a
 * trigger its pg_get_triggerdef. Name-only equality is not catalog equality — two
 * chains can produce the same index name over different columns.
 *
 * Connection strings are never printed. Each side is identified by the server-reported
 * host/port/database/role, so the output is safe to paste into a report.
 *
 * Usage:
 *   node src/scripts/compare-bootstraps.mjs \
 *     --a=<url to a scratch database> \
 *     --b=<url to a scratch database> \
 *     [--show=20] [--self-test]
 *
 * Exit codes:
 *   0  All catalog categories identical
 *   1  Differences found, or a side could not be read
 *   2  Missing arguments
 */
import postgres from "postgres";

const argv = process.argv.slice(2);
const SELF_TEST = argv.includes("--self-test");
const SHOW = Number(
  (argv.find((a) => a.startsWith("--show=")) ?? "--show=20").slice("--show=".length),
);

export function diff(left, right) {
  const l = new Set(left);
  const r = new Set(right);
  return {
    missing: [...l].filter((k) => !r.has(k)).sort(),
    extra: [...r].filter((k) => !l.has(k)).sort(),
  };
}

/**
 * The URL is the one thing that must never reach a log: it carries the password.
 * Identity is taken from the server instead, and this is only the fallback label
 * used when a connection could not be opened at all.
 */
export function safeLabel(url) {
  try {
    const u = new URL(url);
    const database = u.pathname.replace(/^\//, "").split("?")[0] || "?";
    return `${u.hostname || "?"}:${u.port || "5432"}/${database}`;
  } catch {
    return "<unparseable url>";
  }
}

const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast", "drizzle"];

const QUERIES = {
  tables: (sql) => sql`
    SELECT schemaname || '.' || tablename AS k FROM pg_tables
    WHERE schemaname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,

  columns: (sql) => sql`
    SELECT n.nspname || '.' || c.relname || '.' || a.attname
           || ' type=' || format_type(a.atttypid, a.atttypmod)
           || ' notnull=' || a.attnotnull
           || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
           || ' identity=' || coalesce(nullif(a.attidentity::text, ''), '-')
           || ' generated=' || coalesce(nullif(a.attgenerated::text, ''), '-')
           || ' collation=' || coalesce(co.collname, '-') AS k
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0
    WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND n.nspname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,

  constraints: (sql) => sql`
    SELECT n.nspname || '.' || c.relname || '.' || k.conname
           || ' :: ' || pg_get_constraintdef(k.oid)
           || ' deferrable=' || k.condeferrable || ' deferred=' || k.condeferred
           || ' validated=' || k.convalidated AS k
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,

  indexes: (sql) => sql`
    SELECT schemaname || '.' || indexname || ' :: ' || indexdef AS k FROM pg_indexes
    WHERE schemaname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,

  policies: (sql) => sql`
    SELECT schemaname || '.' || tablename || '.' || policyname
           || ' cmd=' || cmd
           || ' permissive=' || permissive
           || ' roles=' || coalesce(array_to_string(roles, ','), '-')
           || ' using=' || coalesce(qual, '-')
           || ' check=' || coalesce(with_check, '-') AS k
    FROM pg_policies
    WHERE schemaname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,

  functions: (sql) => sql`
    SELECT n.nspname || '.' || p.proname
           || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           || ' kind=' || p.prokind::text
           || ' volatile=' || p.provolatile::text
           || ' security_definer=' || p.prosecdef
           || ' returns=' || pg_get_function_result(p.oid)
           || ' lang=' || l.lanname
           || ' body=' || md5(coalesce(p.prosrc, '')) AS k
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,

  triggers: (sql) => sql`
    SELECT n.nspname || '.' || c.relname || '.' || t.tgname
           || ' :: ' || pg_get_triggerdef(t.oid)
           || ' enabled=' || t.tgenabled::text AS k
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,

  extensions: (sql) => sql`
    SELECT e.extname || ' version=' || e.extversion
           || ' schema=' || coalesce(n.nspname, '-') AS k
    FROM pg_extension e
    LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname NOT IN ('plpgsql') ORDER BY k`,

  enums: (sql) => sql`
    SELECT n.nspname || '.' || t.typname || ' #' || e.enumsortorder || ' = ' || e.enumlabel AS k
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace ORDER BY k`,

  rlsState: (sql) => sql`
    SELECT n.nspname || '.' || c.relname
           || ' rowsecurity=' || c.relrowsecurity
           || ' forced=' || c.relforcerowsecurity AS k
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity
      AND n.nspname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,

  sequences: (sql) => sql`
    SELECT s.schemaname || '.' || s.sequencename
           || ' type=' || s.data_type::text
           || ' increment=' || s.increment_by
           || ' min=' || s.min_value || ' max=' || s.max_value
           || ' cycle=' || s.cycle AS k
    FROM pg_sequences s
    WHERE s.schemaname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,

  views: (sql) => sql`
    SELECT n.nspname || '.' || c.relname || ' kind=' || c.relkind::text
           || ' def=' || md5(pg_get_viewdef(c.oid)) AS k
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('v', 'm') AND n.nspname <> ALL(${SYSTEM_SCHEMAS}) ORDER BY k`,
};

function connect(url) {
  return postgres(url, { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 60 });
}

async function collect(url, label) {
  const sql = connect(url);
  try {
    const [ident] = await sql`
      SELECT current_database() AS db,
             current_user AS role,
             coalesce(host(inet_server_addr()), 'unix-socket') AS host,
             coalesce(inet_server_port(), 0) AS port`;
    const out = {
      label,
      identity: `${ident.host}:${ident.port}/${ident.db} as ${ident.role}`,
    };
    for (const [name, query] of Object.entries(QUERIES))
      out[name] = (await query(sql)).map((row) => row.k);
    out.ledgerRows = (
      await sql`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`.catch(() => [{ n: -1 }])
    )[0].n;
    out.ledgerWatermark = (
      await sql`SELECT coalesce(max(created_at), -1)::text n FROM drizzle.__drizzle_migrations`.catch(
        () => [{ n: "-1" }],
      )
    )[0].n;
    return out;
  } finally {
    await sql.end();
  }
}

function selfTest() {
  const cases = [];
  const d = diff(["a", "b"], ["a", "c"]);
  cases.push([
    "diff reports one missing and one extra",
    d.missing.length === 1 && d.missing[0] === "b" && d.extra.length === 1 && d.extra[0] === "c",
  ]);
  cases.push(["diff of identical inputs is empty", (() => {
    const e = diff(["x", "y"], ["y", "x"]);
    return e.missing.length === 0 && e.extra.length === 0;
  })()]);
  cases.push([
    "safeLabel drops user and password",
    (() => {
      const l = safeLabel("postgresql://someuser:hunter2@db.example.com:5433/scratch_x?sslmode=require");
      return l === "db.example.com:5433/scratch_x" && !l.includes("hunter2") && !l.includes("someuser");
    })(),
  ]);
  cases.push([
    "safeLabel survives an unparseable url",
    safeLabel("not a url") === "<unparseable url>",
  ]);
  cases.push([
    "every PRD-required catalog class is queried",
    ["tables", "columns", "constraints", "indexes", "policies", "functions", "triggers",
      "extensions", "enums", "rlsState"].every((k) => k in QUERIES),
  ]);
  cases.push([
    "definitions are compared, not only names",
    QUERIES.constraints.toString().includes("pg_get_constraintdef") &&
      QUERIES.indexes.toString().includes("indexdef") &&
      QUERIES.triggers.toString().includes("pg_get_triggerdef") &&
      QUERIES.policies.toString().includes("with_check"),
  ]);

  let failed = 0;
  for (const [label, ok] of cases) {
    if (ok) console.log(`  PASS  ${label}`);
    else {
      console.error(`  FAIL  ${label}`);
      failed++;
    }
  }
  console.log(`\nSELF-TEST ${failed === 0 ? "PASSED" : "FAILED"}: ${cases.length - failed}/${cases.length}`);
  return failed === 0;
}

if (SELF_TEST) {
  process.exit(selfTest() ? 0 : 1);
}

const argA = argv.find((a) => a.startsWith("--a="))?.slice("--a=".length);
const argB = argv.find((a) => a.startsWith("--b="))?.slice("--b=".length);

if (!argA || !argB) {
  process.stderr.write("Usage: compare-bootstraps.mjs --a=<url> --b=<url> [--show=20] [--self-test]\n");
  process.exit(2);
}

let a;
let b;
try {
  [a, b] = await Promise.all([collect(argA, "A"), collect(argB, "B")]);
} catch (error) {
  console.error(
    `COMPARISON FAILED: could not read one or both targets (A=${safeLabel(argA)} B=${safeLabel(argB)}): ` +
      (error instanceof Error ? error.message : String(error)),
  );
  process.exit(1);
}

console.log(`\nBootstrap parity comparison`);
console.log(`  A: ${a.identity}`);
console.log(`  B: ${b.identity}`);
console.log(`  A ledger rows: ${a.ledgerRows}  watermark: ${a.ledgerWatermark}`);
console.log(`  B ledger rows: ${b.ledgerRows}  watermark: ${b.ledgerWatermark}\n`);

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

const ledgerOk = a.ledgerRows === b.ledgerRows && a.ledgerWatermark === b.ledgerWatermark;
if (!ledgerOk) totalDifferences++;
console.log(
  `${ledgerOk ? "PASS" : "FAIL"}  ${"migrationLedger".padEnd(16)}` +
  `  A=${String(a.ledgerRows).padStart(6)}  B=${String(b.ledgerRows).padStart(6)}`,
);

console.log(
  `\nRESULT: ${totalDifferences === 0 ? "SCHEMAS IDENTICAL" : "SCHEMAS DIFFER"}  differences=${totalDifferences}`,
);
process.exit(totalDifferences === 0 ? 0 : 1);
