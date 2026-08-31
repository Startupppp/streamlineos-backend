import postgres from "postgres";
import { loadEnv, parseCellArgs, redact } from "./cell-topology.mjs";

const env = loadEnv();
const argv = process.argv.slice(2);

if (argv.includes("--help")) {
  console.log(`
Prove a cell reached the same schema as the control plane, from pg_catalog.
Also compares migration watermarks (drizzle.__drizzle_migrations hash set).

  node src/scripts/compare-cell-schema.mjs [--region=cell-2] [--show=20]
  node src/scripts/compare-cell-schema.mjs --self-test

The runner's exit code is not evidence that a migration chain landed. This is.
A cell with 0 migration entries exits 1 regardless of schema differences — the
migration chain has not run and the schema comparison is vacuously true.
`);
  process.exit(0);
}

const topology = parseCellArgs(argv, env);
const SELF_TEST = argv.includes("--self-test");
const SHOW = Number(
  (argv.find((a) => a.startsWith("--show=")) ?? "--show=15").slice("--show=".length),
);

const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast", "drizzle"];

const QUERIES = {
  tables: (sql) => sql`
    SELECT schemaname || '.' || tablename AS k FROM pg_tables
    WHERE schemaname <> ALL(${SYSTEM_SCHEMAS})`,

  columns: (sql) => sql`
    SELECT n.nspname || '.' || c.relname || '.' || a.attname || ':' ||
           format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull AS k
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      AND n.nspname <> ALL(${SYSTEM_SCHEMAS})`,

  indexes: (sql) => sql`
    SELECT schemaname || '.' || indexname AS k FROM pg_indexes
    WHERE schemaname <> ALL(${SYSTEM_SCHEMAS})`,

  constraints: (sql) => sql`
    SELECT n.nspname || '.' || c.relname || '.' || k.conname || ':' || k.contype::text AS k
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> ALL(${SYSTEM_SCHEMAS})`,

  enums: (sql) => sql`
    SELECT t.typname || ':' || e.enumlabel AS k
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid`,

  functions: (sql) => sql`
    SELECT n.nspname || '.' || p.proname AS k
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname <> ALL(${SYSTEM_SCHEMAS})`,

  policies: (sql) => sql`
    SELECT schemaname || '.' || tablename || '.' || policyname AS k FROM pg_policies`,

  rlsEnabled: (sql) => sql`
    SELECT n.nspname || '.' || c.relname AS k
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relrowsecurity AND n.nspname <> ALL(${SYSTEM_SCHEMAS})`,

  triggers: (sql) => sql`
    SELECT n.nspname || '.' || c.relname || '.' || t.tgname AS k
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname <> ALL(${SYSTEM_SCHEMAS})`,

  migrationHashes: (sql) => sql`
    SELECT hash AS k
    FROM drizzle.__drizzle_migrations
    ORDER BY created_at`,
};

export function diff(left, right) {
  const l = new Set(left);
  const r = new Set(right);
  return {
    missing: [...l].filter((k) => !r.has(k)).sort(),
    extra: [...r].filter((k) => !l.has(k)).sort(),
  };
}

function connect(url) {
  return postgres(url, { max: 1, prepare: false, onnotice: () => {} });
}

async function collect(url) {
  const sql = connect(url);
  try {
    const out = {};
    for (const [name, query] of Object.entries(QUERIES))
      out[name] = (await query(sql)).map((row) => row.k);
    return out;
  } finally {
    await sql.end();
  }
}

function selfTest() {
  const d = diff(["a", "b", "c"], ["a", "c", "d"]);
  const diffOk =
    d.missing.length === 1 && d.missing[0] === "b" && d.extra.length === 1 && d.extra[0] === "d";
  if (!diffOk) {
    console.error(`SELF-TEST FAIL: diff returned ${JSON.stringify(d)}`);
    process.exitCode = 1;
    return;
  }

  const emptyMigrations = diff(["hash-1", "hash-2"], []);
  const vacuityOk = emptyMigrations.missing.length === 2;
  if (!vacuityOk) {
    console.error(`SELF-TEST FAIL: a cell with 0 migrations did not report missing hashes`);
    process.exitCode = 1;
    return;
  }

  console.log("SELF-TEST PASS: a missing object and an unexpected object are both reported; a zero-migration cell reports missing hashes");
}

async function main() {
  if (SELF_TEST) return selfTest();

  console.log(`control plane: ${redact(topology.controlPlane.ownerDirect)}`);
  console.log(`cell          : ${redact(topology.cell.ownerDirect)}\n`);

  const [control, cell] = await Promise.all([
    collect(topology.controlPlane.ownerDirect),
    collect(topology.cell.ownerDirect),
  ]);

  const cellMigrationCount = cell.migrationHashes ? cell.migrationHashes.length : 0;
  if (cellMigrationCount === 0) {
    console.error(
      `VACUITY FAIL: cell "${topology.cellId}" (database: ${topology.cell.database}) has 0 migration journal entries.\n` +
      `  The schema comparison is vacuously true against an empty database.\n` +
      `  Run: pnpm cell:bootstrap --region=${topology.regionKey} to apply the migration chain first.`,
    );
    process.exitCode = 1;
    return;
  }

  let differences = 0;

  for (const name of Object.keys(QUERIES)) {
    const d = diff(control[name], cell[name]);
    const ok = d.missing.length === 0 && d.extra.length === 0;
    differences += d.missing.length + d.extra.length;

    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name.padEnd(16)}` +
        ` control=${String(control[name].length).padStart(6)}` +
        ` cell=${String(cell[name].length).padStart(6)}` +
        `${ok ? "" : `  missing=${d.missing.length} extra=${d.extra.length}`}`,
    );

    for (const k of d.missing.slice(0, SHOW)) console.log(`        MISSING IN CELL  ${k}`);
    if (d.missing.length > SHOW) console.log(`        … ${d.missing.length - SHOW} more missing`);
    for (const k of d.extra.slice(0, SHOW)) console.log(`        ONLY IN CELL     ${k}`);
    if (d.extra.length > SHOW) console.log(`        … ${d.extra.length - SHOW} more extra`);
  }

  console.log(
    `\nRESULT: ${differences === 0 ? "SCHEMAS IDENTICAL" : "SCHEMAS DIFFER"}` +
      ` cell=${topology.cellId} differences=${differences} migrations=${cellMigrationCount}`,
  );
  if (differences > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("SCHEMA COMPARISON FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
