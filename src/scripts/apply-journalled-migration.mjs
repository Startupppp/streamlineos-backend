/**
 * Applies one journalled migration by tag and reports the real error.
 *
 * `drizzle-kit migrate` prints NOTICEs, hides the failing statement behind its
 * spinner and exits 1, so a failure in any pending migration blocks every other
 * pending migration with no way to see which statement died. This applies a
 * single named entry, statement by statement, and names the statement that fails.
 *
 *   node src/scripts/apply-journalled-migration.mjs --tag=0636_... [--dry-run]
 *
 * `--skip-existing` reconciles a database whose SCHEMA is ahead of its
 * BOOKKEEPING: the object a statement creates is already there, but no row
 * records the migration, so it is proposed forever and fails forever. Only
 * "already exists" errors are skipped (42P07 duplicate_table, 42710
 * duplicate_object, 42701 duplicate_column, 42P16 invalid_table_definition);
 * every other error still rolls the whole migration back. Each skip is printed,
 * because a skip is an ASSERTION that the existing object matches the one this
 * migration declares -- it is reconciliation, not application, and the output is
 * the only place that distinction survives.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

/** Errors that mean "the object this statement creates is already there". */
const ALREADY_EXISTS = new Set(["42P07", "42710", "42701", "42P16"]);

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

  const sql = postgres(ownerUrl(), { prepare: false, max: 1, ssl: "require", onnotice: () => {} });

  const [already] = await sql`
    SELECT 1 AS present FROM drizzle.__drizzle_migrations WHERE hash = ${hash} LIMIT 1
  `;
  if (already) {
    console.log(`ALREADY APPLIED ${tag}`);
    await sql.end();
    return;
  }

  const skipExisting = flag("skip-existing") === true;
  const skipped = [];
  console.log(
    `applying ${tag}: ${statements.length} statement(s)` +
      (skipExisting ? " (--skip-existing: reconciling schema-ahead-of-bookkeeping)" : ""),
  );
  if (flag("dry-run")) {
    statements.forEach((s, i) => console.log(`  [${i + 1}] ${s.split("\n")[0]}`));
    await sql.end();
    return;
  }

  try {
    await sql.begin(async (tx) => {
      for (const [i, statement] of statements.entries()) {
        // A failed statement aborts the whole transaction in PostgreSQL, so
        // skipping one means unwinding to a savepoint first: without this,
        // statement 2 onwards dies with 25P02 and the skip is worthless.
        // It has to be the driver's own savepoint() -- postgres.js tracks
        // transaction state itself, and a raw "SAVEPOINT" string leaves that
        // state marked failed, so the commit still rolls back.
        try {
          if (skipExisting) await tx.savepoint(async (sp) => sp.unsafe(statement));
          else await tx.unsafe(statement);
          console.log(
            `  OK   [${i + 1}/${statements.length}] ${statement.split("\n")[0].slice(0, 90)}`,
          );
        } catch (error) {
          if (skipExisting && ALREADY_EXISTS.has(error.code)) {
            skipped.push(`[${i + 1}] ${error.code} ${error.message}`);
            console.log(
              `  SKIP [${i + 1}/${statements.length}] ${error.code} ${error.message} ` +
                `— already present, not re-created`,
            );
            continue;
          }
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
  } catch (error) {
    // Never swallow this. A rollback with no reason is how a broken apply reads
    // as "just didn't work" instead of naming the statement that killed it.
    console.error(
      `ROLLED BACK ${tag} — nothing was applied and no migration row was recorded` +
        `\n  cause: ${error.code ?? "?"} ${error.message ?? String(error)}`,
    );
    await sql.end();
    process.exitCode = 1;
    return;
  }

  if (skipped.length > 0) {
    console.log(
      `RECONCILED ${tag} at created_at=${entry.when} — ${skipped.length} statement(s) skipped ` +
        `as already present:`,
    );
    for (const s of skipped) console.log(`    ${s}`);
  } else {
    console.log(`RECORDED ${tag} at created_at=${entry.when}`);
  }
  await sql.end();
}

main().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exitCode = 1;
});
