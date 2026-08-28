import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

// drizzle-kit hides the failing statement behind its spinner and exits 1; this prints it.

const DIR = "migrations";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const only = args.find((a) => a.startsWith("--only="))?.slice(7);
const stopOnError = !args.includes("--continue");
// Only for a stranded entry: objects exist, the record does not. Never a default.
const tolerateExists = args.includes("--tolerate-exists");
const ALREADY_EXISTS = new Set(["42P07", "42710", "42701", "42P06", "42723", "42P16"]);

// Linear. The regex this replaces, /^(--[^\n]*\n?)+$/, backtracks catastrophically
// on a chunk of many comment lines followed by SQL and hung the runner outright.
function isOnlyComments(chunk) {
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("--")) return false;
  }
  return true;
}

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(2);
}

const journal = JSON.parse(readFileSync(join(DIR, "meta", "_journal.json"), "utf8"));
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

try {
  const appliedRows = await sql`SELECT created_at FROM drizzle.__drizzle_migrations`;
  const applied = new Set(appliedRows.map((r) => Number(r.created_at)));

  let pending = journal.entries.filter((e) => !applied.has(e.when));
  if (only) pending = pending.filter((e) => e.tag === only);

  process.stdout.write(`pending=${pending.length}${only ? ` (filtered to ${only})` : ""}\n`);
  if (dryRun) {
    for (const e of pending) process.stdout.write(`  would apply idx=${e.idx} ${e.tag}\n`);
    process.exit(0);
  }

  let ok = 0;
  for (const entry of pending) {
    const path = join(DIR, `${entry.tag}.sql`);
    const body = readFileSync(path, "utf8");
    const hash = createHash("sha256").update(body).digest("hex");
    const statements = body
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !isOnlyComments(s));

    process.stdout.write(`\n[${entry.idx}] ${entry.tag}  (${statements.length} statements)\n`);
    let failed = null;
    let skipped = 0;
    for (let i = 0; i < statements.length; i += 1) {
      try {
        await sql.unsafe(statements[i]);
      } catch (err) {
        if (tolerateExists && ALREADY_EXISTS.has(err.code)) {
          skipped += 1;
          continue;
        }
        failed = { i, err };
        break;
      }
    }
    if (skipped > 0) process.stdout.write(`  ${skipped} statement(s) already present\n`);

    if (failed) {
      const { i, err } = failed;
      process.stdout.write(`  FAILED at statement ${i + 1}/${statements.length}\n`);
      process.stdout.write(`  code=${err.code ?? "?"} ${err.message}\n`);
      process.stdout.write(`  --- statement ---\n${statements[i].slice(0, 600)}\n`);
      if (stopOnError) {
        process.stdout.write(`\nstopped. applied=${ok}\n`);
        process.exit(1);
      }
      continue;
    }

    await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${entry.when})`;
    ok += 1;
    process.stdout.write(`  applied\n`);
  }

  process.stdout.write(`\napplied=${ok} of ${pending.length}\n`);
} finally {
  await sql.end();
}
