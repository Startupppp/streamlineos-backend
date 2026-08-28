import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import {
  CELL_ENV_TEMPLATE,
  loadEnv,
  parseCellArgs,
  redact,
} from "./cell-topology.mjs";

const env = loadEnv();
const argv = process.argv.slice(2);

if (argv.includes("--help")) {
  console.log(`
Build a cell from nothing, through the migration chain, with no manual step.

  node src/scripts/bootstrap-cell.mjs [--region=cell-2] [--cell=cell-2] [--database=cell2]
                                      [--drop --i-mean-it] [--print-env]

  --drop --i-mean-it   Drop the cell database first, so the bootstrap really is cold.
  --print-env          Print the .env block for this cell and exit.

Every step is idempotent; re-running reaches the same head.
`);
  process.exit(0);
}

const topology = parseCellArgs(argv, env);
const DROP = argv.includes("--drop");
const CONFIRMED = argv.includes("--i-mean-it");

if (argv.includes("--print-env")) {
  console.log(CELL_ENV_TEMPLATE(topology).join("\n"));
  process.exit(0);
}

if (env.NODE_ENV === "production") {
  console.error("Refusing to bootstrap a cell against NODE_ENV=production.");
  process.exit(1);
}

if (topology.cell.database === topology.controlPlane.database) {
  console.error(
    `Refusing: the cell database "${topology.cell.database}" is the control plane's own database.`,
  );
  process.exit(1);
}

const journal = JSON.parse(
  readFileSync(resolve(process.cwd(), "migrations/meta/_journal.json"), "utf8"),
);

const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

function connect(url) {
  return postgres(url, { max: 1, prepare: false, onnotice: () => {} });
}

async function dropDatabase() {
  if (!DROP) return false;
  if (!CONFIRMED) {
    console.error("--drop needs --i-mean-it. Refusing to destroy a database on a bare flag.");
    process.exit(1);
  }
  const sql = connect(topology.controlPlane.ownerDirect);
  try {
    await sql.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${topology.cell.database}' AND pid <> pg_backend_pid()`,
    );
    await sql.unsafe(`DROP DATABASE IF EXISTS "${topology.cell.database}"`);
    log(`dropped database ${topology.cell.database}`);
    return true;
  } finally {
    await sql.end();
  }
}

async function createDatabase() {
  const sql = connect(topology.controlPlane.ownerDirect);
  try {
    const existing = await sql`SELECT 1 FROM pg_database WHERE datname = ${topology.cell.database}`;
    if (existing.length > 0) {
      log(`database ${topology.cell.database} already exists`);
      return false;
    }
    await sql.unsafe(`CREATE DATABASE "${topology.cell.database}"`);
    log(`created database ${topology.cell.database}`);
    return true;
  } finally {
    await sql.end();
  }
}

function runStep(label, script, extraEnv) {
  log(`${label} …`);
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    console.error(`\nRESULT: FAILED at ${label} (exit ${result.status})`);
    process.exit(1);
  }
}

async function verify() {
  const owner = connect(topology.cell.ownerDirect);
  try {
    const [{ count: tables }] = await owner`
      SELECT count(*)::int FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'drizzle')`;

    const [{ count: migrations }] = await owner`
      SELECT count(*)::int FROM drizzle.__drizzle_migrations`;

    const [{ count: rlsTables }] = await owner`
      SELECT count(*)::int FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relrowsecurity AND n.nspname NOT IN ('pg_catalog', 'information_schema')`;

    const [{ count: policies }] = await owner`SELECT count(*)::int FROM pg_policies`;

    return {
      tables: Number(tables),
      migrations: Number(migrations),
      journalEntries: journal.entries.length,
      rlsTables: Number(rlsTables),
      policies: Number(policies),
    };
  } finally {
    await owner.end();
  }
}

async function main() {
  console.log(`cell      : ${topology.cellId}`);
  console.log(`region key: ${topology.regionKey}`);
  console.log(`database  : ${topology.cell.database}`);
  console.log(`owner url : ${redact(topology.cell.ownerDirect)}`);
  console.log(`app url   : ${redact(topology.cell.app)}\n`);

  const dropped = await dropDatabase();
  const created = await createDatabase();

  const cellEnv = {
    DATABASE_URL: topology.cell.owner,
    DIRECT_DATABASE_URL: topology.cell.ownerDirect,
    APP_DATABASE_URL: topology.cell.app,
  };

  runStep("migrate", "src/scripts/db-bootstrap.mjs", cellEnv);
  runStep("app-role", "src/scripts/db-bootstrap-app-role.mjs", cellEnv);
  runStep("verify-rls", "src/scripts/db-verify-rls.mjs", cellEnv);

  const facts = await verify();

  console.log("");
  log(`tables      ${facts.tables}`);
  log(`migrations  ${facts.migrations}/${facts.journalEntries}`);
  log(`rls tables  ${facts.rlsTables} (${facts.policies} policies)`);

  const complete = facts.migrations === facts.journalEntries && facts.tables > 0;

  console.log(
    `\nRESULT: ${complete ? "CELL READY" : "CELL INCOMPLETE"}` +
      ` cell=${topology.cellId} db=${topology.cell.database}` +
      ` tables=${facts.tables} migrations=${facts.migrations}/${facts.journalEntries}` +
      ` rls=${facts.rlsTables} cold=${dropped || created}`,
  );

  if (!complete) process.exitCode = 1;
  if (!topology.configured) {
    console.log("\nAdd this to .env so the application serves the cell:\n");
    console.log(CELL_ENV_TEMPLATE(topology).join("\n"));
  }
}

main().catch((e) => {
  console.error("BOOTSTRAP FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
