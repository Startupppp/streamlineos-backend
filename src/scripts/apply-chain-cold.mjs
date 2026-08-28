import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

const MISSING_CODES = new Set(["42704", "42P01", "42703"]);

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

const started = Date.now();
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

async function main() {
  const migrationsDir = resolve(process.cwd(), "migrations");
  const journal = JSON.parse(readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"));

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

  try {
    for (const extension of ["vector", "pg_trgm", "btree_gist", "pgcrypto", '"uuid-ossp"'])
      await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS ${extension}`);

    await sql.unsafe("CREATE SCHEMA IF NOT EXISTS drizzle");
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id serial primary key, hash text not null, created_at bigint)`,
    );

    const appliedRows = await sql`SELECT hash FROM drizzle.__drizzle_migrations`;
    const applied = new Set(appliedRows.map((r) => r.hash));

    let executed = 0;
    let skipped = 0;
    let alreadyPresent = 0;
    let neverCreated = 0;
    const reconciledMigrations = [];
    const chainGaps = [];

    for (const entry of journal.entries) {
      const content = readFileSync(resolve(migrationsDir, `${entry.tag}.sql`), "utf8");
      const hash = sha256(content);

      if (applied.has(hash)) {
        skipped++;
        continue;
      }

      const statements = splitStatements(content);
      let presentHere = 0;
      let missingHere = 0;

      for (let i = 0; i < statements.length; i++) {
        try {
          await sql.unsafe(statements[i]);
        } catch (error) {
          const code = typeof error?.code === "string" ? error.code : "";
          if (DUPLICATE_CODES.has(code)) {
            presentHere++;
            alreadyPresent++;
            if (VERBOSE)
              console.log(`      present   [${entry.tag}] stmt ${i + 1}: ${code} ${error.message}`);
            continue;
          }
          if (MISSING_CODES.has(code)) {
            missingHere++;
            neverCreated++;
            chainGaps.push(`${entry.tag} stmt ${i + 1}: ${code} ${error.message}`);
            if (VERBOSE)
              console.log(`      GAP       [${entry.tag}] stmt ${i + 1}: ${code} ${error.message}`);
            continue;
          }
          console.error(`FAIL  [${entry.tag}] statement ${i + 1}/${statements.length}`);
          console.error(`      ${code} ${error instanceof Error ? error.message : error}`);
          console.error(`\nRESULT: FAILED at ${entry.tag} (${executed} executed, ${skipped} skipped)`);
          process.exitCode = 1;
          return;
        }
      }

      await sql`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${entry.when})`;

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
    }

    log(`executed ${executed}, already recorded ${skipped}, of ${journal.entries.length}`);

    console.log(
      `\nRESULT: REACHED_HEAD ${executed + skipped}/${journal.entries.length}` +
        ` already_present=${alreadyPresent} chain_gaps=${neverCreated}`,
    );

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
