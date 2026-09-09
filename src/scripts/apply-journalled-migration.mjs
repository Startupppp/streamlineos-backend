/**
 * Applies one journalled migration by tag and reports the real error.
 *
 * `drizzle-kit migrate` prints NOTICEs, hides the failing statement behind its
 * spinner and exits 1, so a failure in any pending migration blocks every other
 * pending migration with no way to see which statement died. This applies a
 * single named entry, statement by statement, and names the statement that fails.
 *
 *   node src/scripts/apply-journalled-migration.mjs --tag=0636_... [--dry-run]
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sslForConnectionString } from "./lib/repo-roots.mjs";
import postgres from "postgres";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

function flag(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return process.argv.includes(`--${name}`) ? true : fallback;
}

function ownerUrl() {
  const direct = process.env.DIRECT_DATABASE_URL;
  if (direct) return direct;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url.replace("-pooler.", ".");
}

async function main() {
  const tag = flag("tag");
  if (typeof tag !== "string") throw new Error("--tag=<journal tag> is required");

  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  );
  const entry = journal.entries.find((e) => e.tag === tag);
  if (!entry) throw new Error(`tag not in journal: ${tag}`);

  const sqlText = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
  const hash = createHash("sha256").update(sqlText).digest("hex");
  const statements = sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const sql = postgres(ownerUrl(), { prepare: false, max: 1, ssl: sslForConnectionString(ownerUrl()), onnotice: () => {} });

  const [already] = await sql`
    SELECT 1 AS present FROM drizzle.__drizzle_migrations WHERE hash = ${hash} LIMIT 1
  `;
  if (already) {
    console.log(`ALREADY APPLIED ${tag}`);
    await sql.end();
    return;
  }

  console.log(`applying ${tag}: ${statements.length} statement(s)`);
  if (flag("dry-run")) {
    statements.forEach((s, i) => console.log(`  [${i + 1}] ${s.split("\n")[0]}`));
    await sql.end();
    return;
  }

  try {
    await sql.begin(async (tx) => {
      for (const [i, statement] of statements.entries()) {
        try {
          await tx.unsafe(statement);
          console.log(
            `  OK   [${i + 1}/${statements.length}] ${statement.split("\n")[0].slice(0, 90)}`,
          );
        } catch (error) {
          console.error(
            `  FAIL [${i + 1}/${statements.length}] ${error.code ?? "?"} ${error.message}`,
          );
          console.error(`  statement: ${statement.slice(0, 400)}`);
          throw error;
        }
      }
      await tx`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${entry.when})
      `;
    });
  } catch {
    console.error(
      `ROLLED BACK ${tag} — nothing was applied and no migration row was recorded`,
    );
    await sql.end();
    process.exitCode = 1;
    return;
  }

  console.log(`RECORDED ${tag} at created_at=${entry.when}`);
  await sql.end();
}

main().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exitCode = 1;
});
