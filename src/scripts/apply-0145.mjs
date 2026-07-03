import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.resolve(__dirname, "../../migrations/0145_kb_page_chunks.sql");

function normalizeDatabaseUrl(url) {
  if (!/\.neon\.tech/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("channel_binding");
    return parsed.toString();
  } catch {
    return url.replace(/[&?]channel_binding=[^&]*/g, "").replace(/\?&/, "?");
  }
}

async function verify(sql) {
  const rows = await sql`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'kb_article_chunks'
      AND column_name IN ('article_id', 'page_id')
    ORDER BY column_name
  `;
  const cols = Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable]));
  if (!("page_id" in cols)) throw new Error("Verification failed: page_id column not found");
  if (cols.article_id !== "YES") throw new Error("Verification failed: article_id is still NOT NULL");
  return cols;
}

async function applyMigration(sql) {
  const raw = readFileSync(MIGRATION_PATH, "utf8");
  const statements = raw
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));

  await sql.begin(async (tx) => {
    for (const stmt of statements) {
      try {
        await tx.unsafe(stmt);
        process.stdout.write(`[apply-0145] OK: ${stmt.slice(0, 80).replace(/\n/g, " ").trim()}...\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes("already exists") ||
          msg.includes("duplicate_object") ||
          msg.includes("42710") ||
          msg.includes("column") && msg.includes("already exists") ||
          msg.includes("42P07")
        ) {
          process.stdout.write(`[apply-0145] SKIP (already applied): ${stmt.slice(0, 60).trim()}\n`);
        } else {
          throw err;
        }
      }
    }
  });
}

async function main() {
  const connectionString = process.env.DATABASE_URL ?? process.env.DB;
  if (!connectionString) {
    process.stderr.write("[apply-0145] DATABASE_URL or DB env var is required\n");
    process.exit(1);
  }

  const normalized = normalizeDatabaseUrl(connectionString);
  const isNeon = /\.neon\.tech/i.test(normalized);

  let attempt = 0;
  while (attempt < 3) {
    attempt++;
    const sql = postgres(normalized, {
      prepare: false,
      max: 2,
      idle_timeout: 20,
      connect_timeout: isNeon ? 60 : 30,
      ...(isNeon ? { ssl: "require" } : {}),
    });
    try {
      await applyMigration(sql);
      const cols = await verify(sql);
      process.stdout.write(
        `[apply-0145] Migration complete. Verified columns: ${JSON.stringify(cols)}\n`,
      );
      await sql.end({ timeout: 5 });
      return;
    } catch (err) {
      await sql.end({ timeout: 3 }).catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      const isConnError =
        msg.includes("ECONNREFUSED") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("connect") ||
        msg.includes("connection");
      if (isConnError && attempt < 3) {
        process.stderr.write(`[apply-0145] Connection error (attempt ${attempt}/3), retrying...\n`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      process.stderr.write(`[apply-0145] Failed: ${msg}\n`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[apply-0145] Unhandled error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
