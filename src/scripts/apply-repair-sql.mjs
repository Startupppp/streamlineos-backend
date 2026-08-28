import { readFileSync } from "node:fs";
import { connect } from "./chain-repair/catalog-read.mjs";
import { loadEnv, parseCellArgs, redact } from "./cell-topology.mjs";

const env = loadEnv();
const argv = process.argv.slice(2);

if (argv.includes("--help")) {
  console.log(`
Apply a repair file statement by statement, reporting the first failure with its statement.

  node src/scripts/apply-repair-sql.mjs --file=migrations/0619_x.sql --target=cell
  node src/scripts/apply-repair-sql.mjs --file=migrations/0620_x.sql --target=control --commit

Without --commit the whole file runs inside a transaction that is rolled back, so a syntax
or dependency error is found without changing anything.
`);
  process.exit(0);
}

const topology = parseCellArgs(argv, env);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const FILE = flag("file", null);
const TARGET = flag("target", "cell");
const COMMIT = argv.includes("--commit");
const STOP_AFTER = Number(flag("stop-after", "10"));

if (!FILE) {
  console.error("--file=<path> is required");
  process.exit(1);
}

const url =
  TARGET === "control" ? topology.controlPlane.ownerDirect : topology.cell.ownerDirect;

function statementsOf(content) {
  return content
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)+$/.test(s));
}

async function main() {
  const statements = statementsOf(readFileSync(FILE, "utf8"));
  console.log(`file    : ${FILE}`);
  console.log(`target  : ${TARGET} ${redact(url)}`);
  console.log(`mode    : ${COMMIT ? "COMMIT" : "dry run, rolled back"}`);
  console.log(`statements: ${statements.length}\n`);

  const sql = connect(url);
  const failures = [];
  let applied = 0;

  try {
    await sql.unsafe("BEGIN");
    await sql.unsafe("SET LOCAL statement_timeout = '120s'");
    for (const [i, statement] of statements.entries()) {
      await sql.unsafe("SAVEPOINT repair_step");
      try {
        await sql.unsafe(statement);
        await sql.unsafe("RELEASE SAVEPOINT repair_step");
        applied += 1;
      } catch (e) {
        await sql.unsafe("ROLLBACK TO SAVEPOINT repair_step");
        const code = typeof e === "object" && e !== null && "code" in e ? String(e.code) : "?";
        const message = e instanceof Error ? e.message : String(e);
        failures.push({ index: i, code, message, statement: statement.slice(0, 200) });
        if (failures.length >= STOP_AFTER) break;
      }
    }
    await sql.unsafe(COMMIT && failures.length === 0 ? "COMMIT" : "ROLLBACK");
  } finally {
    await sql.end();
  }

  for (const f of failures)
    console.log(`FAIL  stmt ${f.index}  ${f.code}  ${f.message}\n      ${f.statement}\n`);

  console.log(
    `RESULT: ${failures.length === 0 ? "ALL STATEMENTS RAN" : "FAILURES"}` +
      ` file=${FILE} target=${TARGET} statements=${statements.length}` +
      ` failed=${failures.length} committed=${COMMIT && failures.length === 0}`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("APPLY FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
