import postgres from "postgres";
import { fileURLToPath } from "url";
import { unlink } from "fs/promises";

const url = process.env.DATABASE_URL ?? process.env.DB;
if (!url) throw new Error("DATABASE_URL or DB env var required");

const sql = postgres(url);

const STATEMENTS = [
  `ALTER TABLE "kb_pages" ADD COLUMN IF NOT EXISTS "source_article_id" integer`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_pages_org_source_article" ON "kb_pages" ("org_id","source_article_id") WHERE "source_article_id" IS NOT NULL`,
];

async function verify() {
  const rows = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'kb_pages' AND column_name = 'source_article_id'
  `;
  return rows.length > 0;
}

async function apply() {
  await sql.begin(async (tx) => {
    for (const stmt of STATEMENTS) {
      await tx.unsafe(stmt);
    }
  });
}

let lastErr;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    await apply();
    const ok = await verify();
    if (!ok) throw new Error("Column source_article_id not found after migration");
    console.log("Migration 0146 applied successfully");
    lastErr = null;
    break;
  } catch (err) {
    lastErr = err;
    console.error(`Attempt ${attempt} failed:`, err.message);
  }
}

await sql.end();

if (lastErr) throw lastErr;

const self = fileURLToPath(import.meta.url);
await unlink(self).catch(() => {});
