/**
 * backfill-public-object-urls.mjs
 *
 * Rewrites every stored permanent public object-storage URL back to the opaque
 * tenant-private object key it points at, across every table in the application
 * schemas rather than one table at a time.
 *
 * Background: `StorageService` used to return `<public base>/<key>` for any
 * folder that was not on a hard-coded private list, and callers persisted that
 * value. Ticket 33 removed the minting; this removes what was already written.
 * `chat_attachments.file_url` is NOT handled here — it has its own script,
 * `backfill-chat-attachment-file-url.mjs`, which must still be run.
 *
 * Discovery is catalog-driven, so a column added after this was written is
 * still swept: every text/varchar column in `public`, `build` and
 * `build_events` is examined, and a row is a candidate only when its value
 * literally starts with one of the configured public base URLs. A URL pointing
 * anywhere else (a customer's website, a webhook target, an external job
 * posting) never matches and is never touched.
 *
 * Operator action still required after this runs:
 *   Make the object-storage bucket private. Rewriting the database does not
 *   invalidate a URL somebody already copied — the object stays fetchable at
 *   its public address until the bucket policy changes. That is an action in
 *   the R2 / Cloudflare console and cannot be done from here.
 *
 * Safety:
 *   - Dry-run by default. `--apply` writes.
 *   - Idempotent: the WHERE clause only matches values that still start with a
 *     public base, so a re-run after an interruption skips finished rows.
 *   - Resumable: keyset pagination on each table's single-column primary key,
 *     never OFFSET. Tables without one are reported, not silently skipped.
 *   - Refuses to apply as a role that RLS would filter, because a policy the
 *     role does not bypass turns "nothing to do" and "cannot see it" into the
 *     same output.
 *
 * Usage:
 *   node scripts/backfill-public-object-urls.mjs [--apply] [--url <DSN>]
 *                                                [--base <https://…>]...
 *
 * Environment:
 *   DATABASE_URL / APP_DATABASE_URL — connection
 *   NEXT_PUBLIC_R2_PUBLIC_URL, R2_KB_PUBLIC_URL — public bases to strip
 */

import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config();

const APP_SCHEMAS = ["public", "build", "build_events"];
const BATCH_SIZE = 500;

const args = process.argv.slice(2);
let apply = false;
let dsnOverride;
const extraBases = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--apply") { apply = true; continue; }
  if (args[i] === "--url") { dsnOverride = args[++i]; continue; }
  if (args[i] === "--base") { extraBases.push(args[++i]); continue; }
}

const bases = [
  ...extraBases,
  process.env.NEXT_PUBLIC_R2_PUBLIC_URL,
  process.env.R2_KB_PUBLIC_URL,
]
  .filter((value) => typeof value === "string" && value.trim().length > 0)
  .map((value) => value.trim().replace(/\/+$/, ""));

const uniqueBases = [...new Set(bases)];

if (uniqueBases.length === 0) {
  console.error(
    "No public base URL to strip. Set NEXT_PUBLIC_R2_PUBLIC_URL / R2_KB_PUBLIC_URL, or pass --base <url>.",
  );
  process.exit(1);
}

const dsn = dsnOverride ?? process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
if (!dsn) {
  console.error("No DSN: set DATABASE_URL or APP_DATABASE_URL, or pass --url <DSN>");
  process.exit(1);
}

if (!apply) console.log("DRY-RUN — pass --apply to write changes\n");

try {
  const target = new URL(dsn);
  console.log(`Target: ${target.hostname}${target.pathname}`);
} catch {
  console.log("Target: <unparseable DSN>");
}
console.log(`Public bases treated as leaked: ${uniqueBases.join(", ")}\n`);

const sql = postgres(dsn, { prepare: false, max: 1 });

function keyFromUrl(value) {
  for (const base of uniqueBases) {
    if (!value.startsWith(`${base}/`)) continue;
    const tail = value.slice(base.length + 1).split(/[?#]/, 1)[0] ?? "";
    try {
      return decodeURIComponent(tail);
    } catch {
      return tail;
    }
  }
  return null;
}

async function candidateColumns() {
  return sql`
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           a.attname AS column_name
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    JOIN   pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN   pg_type t ON t.oid = a.atttypid
    WHERE  n.nspname = ANY(${APP_SCHEMAS})
      AND  c.relkind = 'r'
      AND  t.typname IN ('text', 'varchar', 'bpchar')
    ORDER  BY n.nspname, c.relname, a.attname
  `;
}

async function singleColumnPrimaryKeys() {
  const rows = await sql`
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           a.attname AS pk_column
    FROM   pg_constraint k
    JOIN   pg_class c ON c.oid = k.conrelid
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    JOIN   LATERAL unnest(k.conkey) ck(attnum) ON true
    JOIN   pg_attribute a ON a.attrelid = c.oid AND a.attnum = ck.attnum
    WHERE  k.contype = 'p'
      AND  n.nspname = ANY(${APP_SCHEMAS})
      AND  array_length(k.conkey, 1) = 1
  `;
  const map = new Map();
  for (const row of rows)
    map.set(`${row.schema_name}.${row.table_name}`, row.pk_column);
  return map;
}

async function rlsBlockedTables() {
  const rows = await sql`
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = ANY(${APP_SCHEMAS}) AND c.relrowsecurity
  `;
  return new Set(rows.map((r) => `${r.schema_name}.${r.table_name}`));
}

async function roleBypassesRls() {
  const rows = await sql`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`;
  const row = rows[0];
  return Boolean(row && (row.rolbypassrls || row.rolsuper));
}

function likePatterns() {
  return uniqueBases.map((base) => `${base}/%`);
}

async function countMatches(schema, table, column) {
  const rows = await sql`
    SELECT count(*)::bigint AS n
    FROM   ${sql(schema)}.${sql(table)}
    WHERE  ${sql(column)} LIKE ANY(${likePatterns()})
  `;
  return Number(rows[0]?.n ?? 0);
}

async function rewriteColumn(schema, table, column, pkColumn) {
  let after;
  let rewritten = 0;

  for (;;) {
    const page = after === undefined
      ? await sql`
          SELECT ${sql(pkColumn)} AS pk, ${sql(column)} AS value
          FROM   ${sql(schema)}.${sql(table)}
          WHERE  ${sql(column)} LIKE ANY(${likePatterns()})
          ORDER  BY ${sql(pkColumn)} ASC
          LIMIT  ${BATCH_SIZE}
        `
      : await sql`
          SELECT ${sql(pkColumn)} AS pk, ${sql(column)} AS value
          FROM   ${sql(schema)}.${sql(table)}
          WHERE  ${sql(column)} LIKE ANY(${likePatterns()})
            AND  ${sql(pkColumn)} > ${after}
          ORDER  BY ${sql(pkColumn)} ASC
          LIMIT  ${BATCH_SIZE}
        `;

    if (page.length === 0) return rewritten;

    for (const row of page) {
      const key = keyFromUrl(String(row.value));
      if (key === null || key.length === 0) continue;
      await sql`
        UPDATE ${sql(schema)}.${sql(table)}
        SET    ${sql(column)} = ${key}
        WHERE  ${sql(pkColumn)} = ${row.pk}
      `;
      rewritten++;
    }

    after = page[page.length - 1].pk;
    if (page.length < BATCH_SIZE) return rewritten;
  }
}

async function main() {
  const bypassesRls = await roleBypassesRls();
  const rlsTables = await rlsBlockedTables();
  const pkByTable = await singleColumnPrimaryKeys();
  const columns = await candidateColumns();

  const findings = [];
  const unscannable = [];

  for (const { schema_name: schema, table_name: table, column_name: column } of columns) {
    let matches;
    try {
      matches = await countMatches(schema, table, column);
    } catch (error) {
      unscannable.push({
        target: `${schema}.${table}.${column}`,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (matches === 0) continue;
    findings.push({ schema, table, column, matches });
  }

  if (findings.length === 0) {
    console.log("No stored public object URLs found in any application schema.");
  }

  let totalRewritten = 0;
  for (const finding of findings) {
    const qualified = `${finding.schema}.${finding.table}`;
    const pkColumn = pkByTable.get(qualified);
    const rlsRisk = rlsTables.has(qualified) && !bypassesRls;

    console.log(
      `${qualified}.${finding.column}: ${finding.matches} row(s) hold a public URL`,
    );

    if (!apply) continue;

    if (!pkColumn) {
      console.log(`  SKIPPED — no single-column primary key to page on`);
      continue;
    }
    if (rlsRisk) {
      console.log(
        `  SKIPPED — row-level security is enabled and this role does not bypass it; re-run as the owner role`,
      );
      continue;
    }

    const rewritten = await rewriteColumn(
      finding.schema,
      finding.table,
      finding.column,
      pkColumn,
    );
    totalRewritten += rewritten;
    console.log(`  rewrote ${rewritten} row(s) to their object key`);
  }

  if (unscannable.length > 0) {
    console.log(`\n${unscannable.length} column(s) could not be scanned:`);
    for (const item of unscannable.slice(0, 20))
      console.log(`  ${item.target}: ${item.reason}`);
  }

  console.log(
    `\n${apply ? "Applied" : "Dry run"} — ${findings.length} column(s) affected, ${totalRewritten} row(s) rewritten.`,
  );
  if (findings.length > 0) {
    console.log(
      "Reminder: the objects stay fetchable at their old public addresses until the bucket is made private in the storage console.",
    );
  }
}

main()
  .then(() => sql.end())
  .catch(async (error) => {
    console.error(error);
    await sql.end();
    process.exit(1);
  });
