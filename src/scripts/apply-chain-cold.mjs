import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

const PRODUCTION_HOST_PATTERNS = ["amazonaws.com", "neon.tech", "neon-db.net", "supabase.co", ".render.com"];

function assertBootstrapTarget(url, allowProduction) {
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
    [assertBootstrapTarget(undefined, undefined), false],
  ];
  let failed = 0;
  for (const [verdict, expected] of cases)
    if (verdict.allowed !== expected) { console.error(`FAIL: expected allowed=${expected}, got '${verdict.reason}'`); failed++; }
  if (failed) process.exit(1);
  console.log("PASS: apply-chain-cold target guard, 5 cases.");
  process.exit(0);
}

dotenv.config({ path: resolve(process.cwd(), ".env") });

const DUPLICATE_CODES = new Set([
  "42P06",
  "42P07",
  "42701",
  "42710",
  "42723",
  "42P13",
]);

function isPgClassDuplicate(error) {
  if (typeof error?.code !== "string" || error.code !== "23505") return false;
  const constraint = error?.constraint_name ?? error?.fields?.n ?? "";
  const detail = error?.detail ?? error?.message ?? "";
  return constraint === "pg_class_relname_nsp_index" ||
    constraint === "pg_type_typname_nsp_index" ||
    detail.includes("pg_class_relname_nsp_index") ||
    detail.includes("pg_type_typname_nsp_index");
}

function isAlreadyPresentSchemaError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string" ? error.message : "";
  return code === "42P16" && message.includes("multiple primary keys");
}

const MISSING_CODES = new Set(["42704", "42P01", "42703"]);

const CONNECTION_ERROR_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
]);

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required — this runs against the cell being built.");
  process.exit(1);
}

const _coldChainGuard = assertBootstrapTarget(url, process.env.ALLOW_PRODUCTION_MIGRATION);
if (!_coldChainGuard.allowed) {
  process.stderr.write(
    `apply-chain-cold BLOCKED — ${_coldChainGuard.reason}\n`,
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function splitStatements(content) {
  // A temporary table declared ON COMMIT DROP is a migration-local workspace.
  // Splitting such a file into separate autocommit queries drops the table after
  // its CREATE statement and makes the next statement fail. Send the complete
  // file as one PostgreSQL simple-query unit; PostgreSQL executes its statements
  // in one implicit transaction, while `unsafe` still avoids prepared statements.
  if (/\bCREATE\s+TEMP(?:ORARY)?\s+TABLE\b/i.test(content) && /\bON\s+COMMIT\s+DROP\b/i.test(content))
    return [content.replaceAll("--> statement-breakpoint", "")];
  if (content.includes("--> statement-breakpoint"))
    return content.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  if (content.includes("CONCURRENTLY") && !content.includes("$$"))
    return content.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean);
  return [content];
}

function isConnectionError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const msg = typeof error?.message === "string" ? error.message : "";
  return (
    CONNECTION_ERROR_CODES.has(code) ||
    msg.includes("CONNECTION_CLOSED") ||
    msg.includes("Connection terminated") ||
    msg.includes("write ECONNRESET") ||
    msg.includes("ECONNRESET")
  );
}

function isTransientDdlError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string" ? error.message : "";
  return code === "XX000" && /tuple concurrently updated|could not serialize/i.test(message);
}

function makeConnection() {
  return postgres(url, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    connect_timeout: 60,
    idle_timeout: 0,
  });
}

const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);
const MAX_TRANSIENT_DDL_RETRIES = 5;

async function readApplied(sql) {
  const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations`;
  return new Set(rows.map((r) => r.hash));
}

async function ensureInfrastructure(sql) {
  for (const extension of ["vector", "pg_trgm", "btree_gist", "pgcrypto", '"uuid-ossp"'])
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS ${extension}`);

  await sql.unsafe("CREATE SCHEMA IF NOT EXISTS drizzle");
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id serial primary key, hash text not null, created_at bigint)`,
  );
}

async function main() {
  const migrationsDir = resolve(process.cwd(), "migrations");
  const journal = JSON.parse(readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"));

  let sql = makeConnection();

  let executed = 0;
  let skipped = 0;
  let alreadyPresent = 0;
  let neverCreated = 0;
  const reconciledMigrations = [];
  const chainGaps = [];

  const MAX_RECONNECTS = 8;
  let totalReconnects = 0;

  try {
    await ensureInfrastructure(sql);

    let entryIndex = 0;
    // The ledger changes only through this process while a cold bootstrap runs.
    // Reading all applied hashes once avoids one remote round trip per migration
    // (hundreds of queries on resume) without weakening correctness.
    const applied = await readApplied(sql);

    while (entryIndex < journal.entries.length) {
      const entry = journal.entries[entryIndex];
      const content = readFileSync(resolve(migrationsDir, `${entry.tag}.sql`), "utf8");
      const hash = sha256(content);

      if (applied.has(hash)) {
        skipped++;
        entryIndex++;
        continue;
      }

      const statements = splitStatements(content);
      let presentHere = 0;
      let missingHere = 0;
      let statementIdx = 0;
      let migrationCompleted = false;

      while (!migrationCompleted) {
        try {
          for (; statementIdx < statements.length; statementIdx++) {
            let transientAttempts = 0;
            while (true) {
              try {
                await sql.unsafe(statements[statementIdx]);
                break;
              } catch (error) {
                if (isTransientDdlError(error) && transientAttempts < MAX_TRANSIENT_DDL_RETRIES) {
                  transientAttempts++;
                  log(
                    `TRANSIENT_DDL [${entry.tag}] stmt ${statementIdx + 1} ` +
                    `retry ${transientAttempts}/${MAX_TRANSIENT_DDL_RETRIES}`,
                  );
                  await new Promise((resolveAfterDelay) =>
                    setTimeout(resolveAfterDelay, 1000 * transientAttempts),
                  );
                  continue;
                }
              const code = typeof error?.code === "string" ? error.code : "";
              if (DUPLICATE_CODES.has(code) || isPgClassDuplicate(error) || isAlreadyPresentSchemaError(error)) {
                presentHere++;
                alreadyPresent++;
                if (VERBOSE)
                  console.log(`      present   [${entry.tag}] stmt ${statementIdx + 1}: ${code} ${error.message}`);
                break;
              }
              if (MISSING_CODES.has(code)) {
                missingHere++;
                neverCreated++;
                chainGaps.push(`${entry.tag} stmt ${statementIdx + 1}: ${code} ${error.message}`);
                if (VERBOSE)
                  console.log(`      GAP       [${entry.tag}] stmt ${statementIdx + 1}: ${code} ${error.message}`);
                break;
              }
              throw error;
              }
            }
          }

          await sql`
            INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
            VALUES (${hash}, ${entry.when})`;
          applied.add(hash);

          migrationCompleted = true;
        } catch (connError) {
          if (isConnectionError(connError) && totalReconnects < MAX_RECONNECTS) {
            totalReconnects++;
            log(
              `CONNECTION_CLOSED during [${entry.tag}] stmt ${statementIdx + 1} ` +
              `— reconnect #${totalReconnects}, restarting migration from stmt 1 ` +
              `(already-present objects handled by DUPLICATE_CODES)`,
            );
            try { await sql.end(); } catch (_) {}
            await new Promise((r) => setTimeout(r, 3000 * totalReconnects));
            sql = makeConnection();
            await ensureInfrastructure(sql);
            // Restart from stmt 0 — already-created objects produce DUPLICATE_CODES which are handled
            statementIdx = 0;
            presentHere = 0;
            missingHere = 0;
          } else {
            console.error(`FAIL  [${entry.tag}] statement ${statementIdx + 1}/${statements.length}`);
            const code = typeof connError?.code === "string" ? connError.code : "";
            console.error(`      ${code} ${connError instanceof Error ? connError.message : connError}`);
            if (totalReconnects >= MAX_RECONNECTS)
              console.error(`      Exhausted ${MAX_RECONNECTS} reconnect attempts.`);
            console.error(`\nRESULT: FAILED at ${entry.tag} (${executed} executed, ${skipped} skipped)`);
            process.exitCode = 1;
            return;
          }
        }
      }

      executed++;
      if (presentHere > 0 || missingHere > 0) {
        reconciledMigrations.push({ tag: entry.tag, presentHere, missingHere });
        log(
          `RECONCILED [${entry.tag}] ${presentHere} already present, ` +
            `${missingHere} referencing an object the chain never creates` +
            ` (of ${statements.length})`,
        );
      } else if (VERBOSE) {
        log(`OK    [${entry.tag}]`);
      }

      entryIndex++;
    }

    log(`executed ${executed}, already recorded ${skipped}, of ${journal.entries.length}`);

    console.log(
      `\nRESULT: REACHED_HEAD ${executed + skipped}/${journal.entries.length}` +
        ` already_present=${alreadyPresent} chain_gaps=${neverCreated}`,
    );

    writeFileSync(resolve(process.cwd(), ".chain-gaps"), String(neverCreated));

    if (neverCreated > 0) {
      console.log(
        `\n${neverCreated} statement(s) referenced an object this migration chain never creates.` +
          ` Each is a place where the committed chain cannot reproduce the running database.`,
      );
      for (const gap of chainGaps.slice(0, 25)) console.log(`  GAP  ${gap}`);
      if (chainGaps.length > 25) console.log(`  … ${chainGaps.length - 25} more`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error("COLD CHAIN FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
