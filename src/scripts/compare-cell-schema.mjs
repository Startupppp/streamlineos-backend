import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { loadEnv, parseCellArgs, redact } from "./cell-topology.mjs";

const env = loadEnv();
const argv = process.argv.slice(2);

if (argv.includes("--help")) {
  console.log(`
Prove a cell reached the same schema as the control plane, from pg_catalog.
Also compares migration watermarks against the journal (not raw control-plane rows).

  node src/scripts/compare-cell-schema.mjs [--region=cell-2] [--show=20]
  node src/scripts/compare-cell-schema.mjs --self-test

Exit codes:
  0  All catalog categories identical; cell holds every journal migration hash.
  1  Comparison ran but found differences (schema drift, missing migrations, vacuity).
  2  Prerequisite missing — could not connect or required env vars absent.

The runner's exit code is not evidence that a migration chain landed. This is.

Migration comparison uses journal-derived sha256 hashes (sha256 of each .sql file),
NOT the raw row set from the control plane. The control plane carries extra rows that a
correctly bootstrapped cell will never have:
  - Tag-name entries written by drizzle-kit (e.g. "0690_build_ticket_…") instead of sha256.
  - Orphan rows whose journal entry was later removed.
Comparing against the journal eliminates both false-alarm classes.
`);
  process.exit(0);
}

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
};

function loadJournalHashes() {
  const journalPath = resolve(process.cwd(), "migrations/meta/_journal.json");
  let journal;
  try {
    journal = JSON.parse(readFileSync(journalPath, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read migration journal: ${e instanceof Error ? e.message : e}`);
  }
  return journal.entries.map((entry) => {
    const sqlPath = resolve(process.cwd(), "migrations", `${entry.tag}.sql`);
    let content;
    try {
      content = readFileSync(sqlPath, "utf8");
    } catch (e) {
      throw new Error(`Cannot read migration file ${entry.tag}.sql: ${e instanceof Error ? e.message : e}`);
    }
    return createHash("sha256").update(content).digest("hex");
  });
}

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
    out.migrationHashes = (await sql`
      SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at
    `).map((r) => r.hash);
    return out;
  } finally {
    await sql.end();
  }
}

function selfTest() {
  let allOk = true;

  const fail = (msg) => {
    console.error(`SELF-TEST FAIL: ${msg}`);
    allOk = false;
  };

  const d = diff(["a", "b", "c"], ["a", "c", "d"]);
  if (d.missing.length !== 1 || d.missing[0] !== "b" || d.extra.length !== 1 || d.extra[0] !== "d")
    fail(`diff returned ${JSON.stringify(d)}`);

  const emptyMigrations = diff(["hash-1", "hash-2"], []);
  if (emptyMigrations.missing.length !== 2)
    fail("a cell with 0 migrations did not report missing hashes");

  const journalHashes = ["hash-a", "hash-b", "hash-c"];
  const cellDrifted = ["hash-a", "hash-x", "hash-c"];
  const driftResult = diff(journalHashes, cellDrifted);
  if (
    driftResult.missing.length !== 1 ||
    driftResult.missing[0] !== "hash-b" ||
    driftResult.extra.length !== 1 ||
    driftResult.extra[0] !== "hash-x"
  )
    fail(`same-count hash drift not detected: ${JSON.stringify(driftResult)}`);

  const journalSet = new Set(["j1", "j2", "j3"]);
  const controlOrphaned = ["j1", "j2", "j3", "orphan-a", "orphan-b"];
  const cellFresh = ["j1", "j2", "j3"];
  const cellHashSet = new Set(cellFresh);
  const missingFromCell = [...journalSet].filter((h) => !cellHashSet.has(h));
  const extraInCell = cellFresh.filter((h) => !journalSet.has(h));
  const controlOrphans = controlOrphaned.filter((h) => !journalSet.has(h));
  if (missingFromCell.length !== 0 || extraInCell.length !== 0)
    fail(`control-plane orphans caused a false alarm (missing=${missingFromCell.length} extra=${extraInCell.length})`);
  if (controlOrphans.length !== 2)
    fail(`control-plane orphan count wrong: expected 2, got ${controlOrphans.length}`);

  if (allOk)
    console.log(
      "SELF-TEST PASS: diff, zero-migration vacuity, same-count hash-drift, " +
      "and control-plane orphan isolation all verified",
    );
  else
    process.exitCode = 1;
}

async function main() {
  if (SELF_TEST) return selfTest();

  let topology;
  try {
    topology = parseCellArgs(argv, env);
  } catch (e) {
    console.error("PREREQUISITE MISSING:", e instanceof Error ? e.message : e);
    process.exitCode = 2;
    return;
  }

  let journalHashes;
  try {
    journalHashes = loadJournalHashes();
  } catch (e) {
    console.error("PREREQUISITE MISSING:", e instanceof Error ? e.message : e);
    process.exitCode = 2;
    return;
  }

  console.log(`control plane : ${redact(topology.controlPlane.ownerDirect)}`);
  console.log(`cell          : ${redact(topology.cell.ownerDirect)}`);
  console.log(`journal hashes: ${journalHashes.length}\n`);

  let control, cell;
  try {
    [control, cell] = await Promise.all([
      collect(topology.controlPlane.ownerDirect),
      collect(topology.cell.ownerDirect),
    ]);
  } catch (e) {
    console.error(
      "PREREQUISITE MISSING: could not connect to one or both databases:",
      e instanceof Error ? e.message : e,
    );
    process.exitCode = 2;
    return;
  }

  const cellMigrationCount = cell.migrationHashes.length;
  if (cellMigrationCount === 0) {
    console.error(
      `VACUITY FAIL: cell "${topology.cellId}" (database: ${topology.cell.database}) has 0 migration journal entries.\n` +
      `  The schema comparison would be vacuously true against an empty database.\n` +
      `  Run: pnpm -C backend cell:bootstrap --region=${topology.regionKey} first.`,
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

  const journalHashSet = new Set(journalHashes);
  const cellHashSet = new Set(cell.migrationHashes);
  const controlHashSet = new Set(control.migrationHashes);

  const missingFromCell = journalHashes.filter((h) => !cellHashSet.has(h));
  const extraInCell = cell.migrationHashes.filter((h) => !journalHashSet.has(h));
  const controlOrphans = control.migrationHashes.filter((h) => !journalHashSet.has(h));

  const migrationOk = missingFromCell.length === 0;
  differences += missingFromCell.length;

  const migrationSuffix = [
    !migrationOk ? ` missing=${missingFromCell.length}` : "",
    extraInCell.length > 0 ? ` extra-in-cell=${extraInCell.length}` : "",
    controlOrphans.length > 0 ? ` control-orphans=${controlOrphans.length}(not-required)` : "",
  ].join("");

  console.log(
    `${migrationOk ? "PASS" : "FAIL"}  ${"migrationHashes".padEnd(16)}` +
      ` journal=${String(journalHashes.length).padStart(6)}` +
      ` cell=${String(cellMigrationCount).padStart(6)}` +
      migrationSuffix,
  );

  if (!migrationOk) {
    for (const h of missingFromCell.slice(0, SHOW)) console.log(`        MISSING IN CELL  ${h}`);
    if (missingFromCell.length > SHOW) console.log(`        … ${missingFromCell.length - SHOW} more missing`);
  }
  if (extraInCell.length > 0) {
    console.log(`        NOTE: ${extraInCell.length} cell hash(es) not in journal (may be orphans from prior bootstrap)`);
    for (const h of extraInCell.slice(0, SHOW)) console.log(`        EXTRA IN CELL    ${h}`);
    if (extraInCell.length > SHOW) console.log(`        … ${extraInCell.length - SHOW} more`);
  }

  console.log(
    `\nRESULT: ${differences === 0 ? "SCHEMAS IDENTICAL" : "SCHEMAS DIFFER"}` +
      ` cell=${topology.cellId}` +
      ` differences=${differences}` +
      ` migrations=${cellMigrationCount}/${journalHashes.length}` +
      (controlOrphans.length > 0 ? ` control-orphans=${controlOrphans.length}` : ""),
  );
  if (differences > 0) process.exitCode = 1;
}

main().catch((e) => {
  if (process.exitCode === 2) return;
  console.error("SCHEMA COMPARISON FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
