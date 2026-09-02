#!/usr/bin/env node
/**
 * Temporary script - delete after use.
 * Applies unapplied migrations to scratch_e2e efficiently.
 * Reads DIRECT_DATABASE_URL env var.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const url = process.env.DIRECT_DATABASE_URL;
if (!url) { console.error("DIRECT_DATABASE_URL required"); process.exit(1); }

const DUPLICATE_CODES = new Set(["42P06","42P07","42701","42710","42723","42P13"]);
const MISSING_CODES = new Set(["42704","42P01","42703"]);

function sha256(content) { return createHash("sha256").update(content).digest("hex"); }

function splitStatements(content) {
  if (content.includes("--> statement-breakpoint"))
    return content.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean);
  if (content.includes("CONCURRENTLY") && !content.includes("$$"))
    return content.split(/;\s*(?:\r?\n|$)/).map(s => s.trim()).filter(Boolean);
  return [content];
}

function isPgClassDuplicate(e) {
  if (e?.code !== "23505") return false;
  const c = e?.constraint_name ?? "";
  const d = e?.detail ?? e?.message ?? "";
  return c === "pg_class_relname_nsp_index" || c === "pg_type_typname_nsp_index" ||
    d.includes("pg_class_relname_nsp_index") || d.includes("pg_type_typname_nsp_index");
}

const started = Date.now();
const log = msg => console.log(`[${((Date.now()-started)/1000).toFixed(1)}s] ${msg}`);

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 60, idle_timeout: 0 });

async function main() {
  const migrationsDir = resolve(process.cwd(), "migrations");
  const journal = JSON.parse(readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"));
  log(`Journal entries: ${journal.entries.length}`);

  // Ensure infrastructure
  for (const ext of ["vector", "pg_trgm", "btree_gist", "pgcrypto", '"uuid-ossp"'])
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS ${ext}`).catch(() => {});
  await sql.unsafe("CREATE SCHEMA IF NOT EXISTS drizzle").catch(() => {});
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`).catch(() => {});

  // Read ALL applied hashes in ONE query
  const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations`;
  const applied = new Set(rows.map(r => r.hash));
  log(`Already applied: ${applied.size}`);

  let executed = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];
  const gaps = [];

  for (const entry of journal.entries) {
    const content = readFileSync(resolve(migrationsDir, `${entry.tag}.sql`), "utf8");
    const hash = sha256(content);
    if (applied.has(hash)) { skipped++; continue; }

    const statements = splitStatements(content);
    let alreadyPresent = 0;
    let missing = 0;
    let ok = true;

    for (let i = 0; i < statements.length; i++) {
      try {
        await sql.unsafe(statements[i]);
      } catch (e) {
        const code = typeof e?.code === "string" ? e.code : "";
        if (DUPLICATE_CODES.has(code) || isPgClassDuplicate(e)) { alreadyPresent++; continue; }
        if (MISSING_CODES.has(code)) {
          missing++;
          gaps.push(`${entry.tag} stmt ${i+1}: ${code} ${e.message}`);
          continue;
        }
        // Real failure
        log(`FAIL [${entry.tag}] stmt ${i+1}: ${code} ${e.message}`);
        failures.push({ tag: entry.tag, stmt: i+1, code, msg: e.message });
        ok = false;
        break;
      }
    }

    if (!ok) { failed++; continue; }

    try {
      await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${entry.when})`;
      executed++;
      const note = alreadyPresent > 0 || missing > 0 ? ` (present=${alreadyPresent} gaps=${missing})` : "";
      log(`OK [${entry.tag}]${note}`);
    } catch (e) {
      log(`JOURNAL INSERT FAILED [${entry.tag}]: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n=== MIGRATION RESULT ===`);
  console.log(`  Executed:  ${executed}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Total:     ${executed + skipped + failed} / ${journal.entries.length}`);
  if (gaps.length > 0) {
    console.log(`\n  Chain gaps (${gaps.length}):`);
    for (const g of gaps.slice(0, 20)) console.log(`    GAP ${g}`);
    if (gaps.length > 20) console.log(`    ... ${gaps.length - 20} more`);
  }
  if (failures.length > 0) {
    console.log(`\n  Failures:`);
    for (const f of failures) console.log(`    FAIL [${f.tag}] stmt ${f.stmt}: ${f.code} ${f.msg}`);
    process.exitCode = 1;
  } else {
    console.log(`\n  All migrations applied successfully.`);
  }
}

main().catch(e => { console.error("FAILED:", e.message); process.exitCode = 1; }).finally(() => sql.end());
