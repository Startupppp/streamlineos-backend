import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

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
    detail.includes("pg_class_relname_nsp_index");
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

const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function splitStatements(content) {
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

    while (entryIndex < journal.entries.length) {
      const entry = journal.entries[entryIndex];
      const content = readFileSync(resolve(migrationsDir, `${entry.tag}.sql`), "utf8");
      const hash = sha256(content);

      let applied = await readApplied(sql);
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
            try {
              await sql.unsafe(statements[statementIdx]);
            } catch (error) {
              const code = typeof error?.code === "string" ? error.code : "";
              if (DUPLICATE_CODES.has(code) || isPgClassDuplicate(error)) {
                presentHere++;
                alreadyPresent++;
                if (VERBOSE)
                  console.log(`      present   [${entry.tag}] stmt ${statementIdx + 1}: ${code} ${error.message}`);
                continue;
              }
              if (MISSING_CODES.has(code)) {
                missingHere++;
                neverCreated++;
                chainGaps.push(`${entry.tag} stmt ${statementIdx + 1}: ${code} ${error.message}`);
                if (VERBOSE)
                  console.log(`      GAP       [${entry.tag}] stmt ${statementIdx + 1}: ${code} ${error.message}`);
                continue;
              }
              throw error;
            }
          }

          await sql`
            INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
            VALUES (${hash}, ${entry.when})`;

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
