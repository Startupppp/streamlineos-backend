import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const poolerUrl = process.env.DATABASE_URL;
if (!poolerUrl) {
  console.error("DATABASE_URL is required in .env");
  process.exit(1);
}

// Migrations need a direct (session-mode) connection. Neon encodes that in the host;
// every other provider needs DIRECT_DATABASE_URL set explicitly.
const directUrl =
  process.env.DIRECT_DATABASE_URL ||
  (/-pooler\..*\.neon\.tech/i.test(poolerUrl) ? poolerUrl.replace("-pooler.", ".") : poolerUrl);

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

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

async function applyMigrationStatements(url, statements) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    for (const stmt of statements) {
      await sql.unsafe(stmt);
    }
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

const applied = new Set();
{
  const sql = postgres(directUrl, { max: 1 });
  try {
    const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations`;
    for (const row of rows) applied.add(row.hash);
  } finally {
    await sql.end();
  }
}

let succeeded = 0;

for (const entry of journal.entries) {
  const filePath = resolve(migrationsDir, `${entry.tag}.sql`);
  const content = readFileSync(filePath, "utf8");
  const hash = sha256(content);

  if (applied.has(hash)) {
    console.log(`SKIP  [${entry.tag}]`);
    succeeded++;
    continue;
  }

  const statements = splitStatements(content);

  try {
    await withRetry(() => applyMigrationStatements(directUrl, statements), 4);

    const sql = postgres(directUrl, { max: 1 });
    try {
      await sql`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${entry.when})
      `;
    } finally {
      await sql.end();
    }

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

console.log(`\nRESULT: REACHED_HEAD ${succeeded}/${total}`);
