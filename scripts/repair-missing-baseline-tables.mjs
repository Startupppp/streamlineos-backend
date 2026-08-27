import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

// The baseline is recorded as applied but 47 of its 749 CREATE TABLEs never landed; no migration
// drops them. This replays only the statements for tables that are still absent.

const BASELINE = "migrations/0000_light_vance_astro.sql";
const dryRun = process.argv.includes("--dry-run");
const TOLERATE = new Set(["42P07", "42710", "42701", "42P06", "42723", "42P16"]);

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(2);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

try {
  const live = new Set(
    (
      await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    ).map((r) => r.table_name),
  );

  const body = readFileSync(BASELINE, "utf8");
  const statements = body
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const created = [...body.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? "([^"]+)"/g)].map((m) => m[1]);
  // Only tables the Drizzle schema still declares: the baseline also holds 115 retired ones, and
  // recreating those would resurrect structures later work deliberately left behind.
  const declared = new Set(JSON.parse(readFileSync("/tmp/declared.json", "utf8")));
  const missing = created.filter((t) => !live.has(t) && declared.has(t));
  const missingSet = new Set(missing);

  process.stdout.write(`baseline declares ${created.length} tables; ${missing.length} absent\n`);
  if (missing.length === 0) process.exit(0);

  const relevant = statements.filter((s) => [...missingSet].some((t) => s.includes(`"${t}"`)));
  process.stdout.write(`statements mentioning an absent table: ${relevant.length}\n`);

  if (dryRun) {
    process.stdout.write(missing.sort().join("\n") + "\n");
    process.exit(0);
  }

  // Enum types are missing too -- the baseline's CREATE TYPE statements did not all land either.
  const typeStatements = statements.filter((s) => /^CREATE TYPE /m.test(s));
  let typesMade = 0;
  for (const statement of typeStatements) {
    try {
      await sql.unsafe(statement);
      typesMade += 1;
    } catch (err) {
      if (!TOLERATE.has(err.code)) process.stdout.write(`  type failed: ${err.code} ${err.message}
`);
    }
  }
  process.stdout.write(`enum types created: ${typesMade} of ${typeStatements.length}
`);

  let queue = relevant;
  let pass = 0;
  const failures = new Map();

  while (queue.length > 0 && pass < 6) {
    pass += 1;
    const next = [];
    let applied = 0;
    for (const statement of queue) {
      try {
        await sql.unsafe(statement);
        applied += 1;
      } catch (err) {
        if (TOLERATE.has(err.code)) {
          applied += 1;
          continue;
        }
        next.push(statement);
        failures.set(statement, err);
      }
    }
    process.stdout.write(`pass ${pass}: applied ${applied}, deferred ${next.length}\n`);
    if (next.length === queue.length) break;
    queue = next;
  }

  const stillMissing = (
    await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  ).map((r) => r.table_name);
  const liveNow = new Set(stillMissing);
  const absent = missing.filter((t) => !liveNow.has(t));

  process.stdout.write(`\ntables still absent: ${absent.length}\n`);
  for (const t of absent) process.stdout.write(`  ${t}\n`);
  if (queue.length > 0) {
    const err = failures.get(queue[0]);
    process.stdout.write(`\nfirst unresolved: code=${err?.code} ${err?.message}\n`);
    process.stdout.write(`${queue[0].slice(0, 400)}\n`);
  }
} finally {
  await sql.end();
}
