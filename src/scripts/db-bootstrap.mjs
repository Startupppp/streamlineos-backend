import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";
import { driftedEntries, planMigrations, sha256 } from "./migration-plan.mjs";

const PRODUCTION_HOST_PATTERNS = ["amazonaws.com", "neon.tech", "neon-db.net", "supabase.co", ".render.com"];

export function assertBootstrapTarget(url, allowProduction) {
  if (!url) return { allowed: false, reason: "DATABASE_URL is not set" };
  const matched = PRODUCTION_HOST_PATTERNS.find((p) => url.includes(p));
  if (!matched) return { allowed: true, reason: "not a known production host" };
  if (allowProduction === "1") return { allowed: true, reason: `production host '${matched}' — ALLOW_PRODUCTION_MIGRATION=1 acknowledged` };
  return { allowed: false, reason: `DATABASE_URL names production host '${matched}'; set ALLOW_PRODUCTION_MIGRATION=1 to proceed deliberately` };
}

if (process.argv.includes("--self-test")) {
  const cases = [
    [assertBootstrapTarget("postgresql://u:p@127.0.0.1:5432/app", undefined), true],
    [assertBootstrapTarget("postgresql://u:p@prod.cluster.amazonaws.com/app", undefined), false],
    [assertBootstrapTarget("postgresql://u:p@prod.cluster.amazonaws.com/app", "1"), true],
    [assertBootstrapTarget("postgresql://u:p@db.neon.tech/neondb", undefined), false],
    [assertBootstrapTarget("postgresql://u:p@db.neon.tech/neondb", "1"), true],
    [assertBootstrapTarget(undefined, undefined), false],
  ];
  let failed = 0;
  for (const [verdict, expected] of cases)
    if (verdict.allowed !== expected) { console.error(`FAIL: expected allowed=${expected}, got '${verdict.reason}'`); failed++; }
  if (failed) process.exit(1);
  console.log("PASS: db-bootstrap target guard, 6 cases.");
  process.exit(0);
}

dotenv.config({ path: resolve(process.cwd(), ".env") });

const poolerUrl = process.env.DATABASE_URL;
if (!poolerUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const _bootstrapGuard = assertBootstrapTarget(poolerUrl, process.env.ALLOW_PRODUCTION_MIGRATION);
if (!_bootstrapGuard.allowed) {
  console.error(`db-bootstrap BLOCKED — ${_bootstrapGuard.reason}`);
  process.exit(2);
}

// Migrations need a direct (session-mode) connection. Neon encodes that in the host;
// every other provider needs DIRECT_DATABASE_URL set explicitly.
const directUrl =
  process.env.DIRECT_DATABASE_URL ||
  (/-pooler\..*\.neon\.tech/i.test(poolerUrl) ? poolerUrl.replace("-pooler.", ".") : poolerUrl);

// 0431 pins this on the role `neondb_owner`, so the chain used to resolve the 152
// unqualified `current_org_id()` references in 0619/0620/0655/0666/0677/0678/0701/0988
// only for a connection whose role happened to carry that name. Setting it per session
// makes the cold build reproduce the same resolution (`app.current_org_id`) under any
// role, without editing an applied migration or shadowing the function in `public`.
const MIGRATION_SEARCH_PATH = '"$user", public, build_events, app';

function isRetryable(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|timeout|Connection/i.test(msg);
}

function splitStatements(content) {
  if (content.includes("--> statement-breakpoint")) {
    return content
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (content.includes("CONCURRENTLY") && !content.includes("$$")) {
    return content
      .split(/;\s*(?:\r?\n|$)/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [content];
}

// CREATE INDEX CONCURRENTLY is rejected inside a transaction block, and two historical
// migrations issue their own BEGIN/COMMIT. Everything else is applied atomically so a
// transaction-scoped temp table (`ON COMMIT DROP`, migrations 0921/0924/0927) survives
// across statement-breakpoints and an interrupted run leaves no half-applied migration.
function requiresAutocommit(content) {
  if (/\bCONCURRENTLY\b/i.test(content)) return true;
  return /^[ \t]*(BEGIN|START[ \t]+TRANSACTION|COMMIT|ROLLBACK)[ \t]*;/im.test(content);
}

async function applyMigrationStatements(url, statements, autocommit, ledger) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`SET search_path = ${MIGRATION_SEARCH_PATH}`);
    if (autocommit) {
      for (const stmt of statements) {
        await sql.unsafe(stmt);
      }
      await sql`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${ledger.hash}, ${ledger.when})
      `;
      return;
    }
    await sql.begin(async (tx) => {
      for (const stmt of statements) {
        await tx.unsafe(stmt);
      }
      await tx`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${ledger.hash}, ${ledger.when})
      `;
    });
  } finally {
    await sql.end();
  }
}

async function withRetry(fn, maxAttempts) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < maxAttempts && isRetryable(err)) {
        console.log(`  Retrying (attempt ${attempt + 1}/${maxAttempts})...`);
        continue;
      }
      throw err;
    }
  }
}

const migrationsDir = resolve(process.cwd(), "migrations");
const journal = JSON.parse(
  readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8")
);
const total = journal.entries.length;

{
  const sql = postgres(directUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
    await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await sql.unsafe("CREATE EXTENSION IF NOT EXISTS btree_gist");
    await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await sql.unsafe("CREATE SCHEMA IF NOT EXISTS drizzle");
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )`
    );
  } finally {
    await sql.end();
  }
}

// created_at, NOT hash. Drizzle, run-pending-migrations.mjs:66 and
// check-migration-ledger.mjs all join the ledger on the journal's `when`; this
// runner used to join on sha256(file), so editing an applied migration made the
// two runners build different databases from one journal — the edited file was
// skipped by the timestamp runner and RE-EXECUTED by this one. Measured against a
// real Postgres before the fix: a comment-only edit to an applied migration
// aborted this script with `relation "probe_b" already exists` on a database
// already at head, and where the DDL is IF NOT EXISTS-guarded it instead wrote a
// second ledger row for one journal entry and still printed REACHED_HEAD.
// See migration-plan.mjs for why set membership rather than the watermark.
const ledgerRows = [];
{
  const sql = postgres(directUrl, { max: 1 });
  try {
    const rows = await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations`;
    for (const row of rows) ledgerRows.push({ hash: row.hash, created_at: row.created_at });
  } finally {
    await sql.end();
  }
}

const readMigration = (tag) => readFileSync(resolve(migrationsDir, `${tag}.sql`), "utf8");
const { apply: pending, skip: alreadyApplied } = planMigrations(journal.entries, ledgerRows);
const pendingTags = new Set(pending.map((entry) => entry.tag));

// The ledger keeps only the raw sha256, so this can say THAT a skipped migration's
// file changed after it was applied, never whether the change was inert. That
// second question is check:migration-immutability's, which keeps a comment-stripped
// hash beside the raw one for exactly this reason.
const drifted = new Map(
  driftedEntries(alreadyApplied, ledgerRows, readMigration).map((d) => [d.tag, d]),
);

let succeeded = 0;

for (const entry of journal.entries) {
  if (!pendingTags.has(entry.tag)) {
    const drift = drifted.get(entry.tag);
    console.log(
      drift
        ? `SKIP  [${entry.tag}]  DRIFT: file sha256 ${drift.fileHash.slice(0, 12)} != ledger ${drift.ledgerHash.slice(0, 12)} — this database holds the migration as it was when applied, not as the repository now shows it`
        : `SKIP  [${entry.tag}]`,
    );
    succeeded++;
    continue;
  }

  const filePath = resolve(migrationsDir, `${entry.tag}.sql`);
  const content = readFileSync(filePath, "utf8");
  const hash = sha256(content);

  const statements = splitStatements(content);
  const autocommit = requiresAutocommit(content);

  try {
    await withRetry(
      () =>
        applyMigrationStatements(directUrl, statements, autocommit, {
          hash,
          when: entry.when,
        }),
      4
    );

    console.log(`OK    [${entry.tag}]`);
    succeeded++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FAIL  [${entry.tag}] ${msg}`);
    console.log(
      `\nRESULT: FAILED at ${entry.tag} (${succeeded}/${total} ok before failure)`
    );
    process.exit(1);
  }
}

if (drifted.size > 0) {
  console.warn(
    `\nDRIFT: ${drifted.size} already-applied migration file(s) no longer hash to what this database recorded.`,
  );
  for (const d of drifted.values()) console.warn(`  ${d.tag}`);
  console.warn(
    "  Neither runner will re-apply them — that is the correct behaviour and it is also silent,\n" +
      "  so a cold build from this journal and this warm database will not be the same database if\n" +
      "  any of the edits changed a statement. `pnpm check:migration-immutability` says which did.",
  );
}

console.log(`\nRESULT: REACHED_HEAD ${succeeded}/${total}`);
