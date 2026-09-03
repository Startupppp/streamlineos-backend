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
 * `chat_attachments.file_url` IS handled here when this runs as the database
 * owner: discovery is catalog-driven, so the column is found like any other and
 * the owner bypasses the row-level security policy that would otherwise hide it.
 * `backfill-chat-attachment-file-url.mjs` is needed only when this must run as
 * the application role, which cannot read through that policy — this script then
 * reports the column UNVERIFIABLE and exits 2 rather than counting it as clean.
 *
 * Discovery is catalog-driven, so a column added after this was written is
 * still swept: every text/varchar/bpchar column of every table in every
 * application schema is examined, and so is every json/jsonb/xml/text[] column.
 * A URL pointing anywhere else (a customer's website, a webhook target, an
 * external job posting) never matches and is never touched.
 *
 * TWO FINDINGS, ONLY ONE OF WHICH IS REWRITTEN.
 *   WHOLE    — the value IS a public URL and nothing else. Rewritten to the
 *              object key it points at, percent-escapes decoded.
 *   EMBEDDED — the value CARRIES a public URL inside something larger: an
 *              <img src> in a rich-text body, a "url" member in a jsonb blob,
 *              one member of a text[]. Reported and counted, never rewritten —
 *              replacing an <img src> with a bare object key breaks the render
 *              rather than fixing the leak, and which JSON path is an object
 *              address is not knowable from the catalog. It exits 3 so the
 *              residue cannot be read off a run that "succeeded".
 *
 * The EMBEDDED half exists because the earlier version of this script did not.
 * It scanned only text/varchar/bpchar and matched only `LIKE '<base>/%'`, so on
 * a fixture holding six leaked object URLs it found ONE and printed
 * "ROWS HOLDING A PUBLIC URL: 1 … UNVERIFIABLE COLUMNS: 0" with exit 0 — which
 * is the exact line ticket 33 names as the evidence that would close its box.
 * Measured on a database at head: 501 of 5,996 URL-capable columns (479 jsonb,
 * 22 text[]) were outside the old scan entirely.
 *
 * Operator action still required after this runs:
 *   Make the object-storage bucket private. Rewriting the database does not
 *   invalidate a URL somebody already copied — the object stays fetchable at
 *   its public address until the bucket policy changes. That is an action in
 *   the R2 / Cloudflare console and cannot be done from here.
 *
 * Safety:
 *   - Dry-run by default. `--apply` writes.
 *   - Idempotent: the WHERE clause only matches values that are still, in their
 *     entirety, a public URL, so a re-run after an interruption skips finished
 *     rows.
 *   - Resumable: keyset pagination on each table's single-column primary key,
 *     never OFFSET. A table without one is rewritten by ctid instead of being
 *     skipped, re-reading the first page of still-matching rows each pass.
 *   - Never reports a count for a table this role reads through a row-level
 *     security policy. `row_security_active()` decides that, per table, and such
 *     a column is listed as UNVERIFIABLE and the process exits 2 — because a
 *     policy the role does not bypass turns "nothing to do" and "cannot see it"
 *     into the same output, and the whole point of this run is a known number.
 *     Run as the database owner (which bypasses RLS and therefore also covers
 *     chat_attachments.file_url), or use the per-organization script below.
 *
 * Usage:
 *   node scripts/backfill-public-object-urls.mjs [--apply] [--url <DSN>]
 *                                                [--base <https://…>]...
 *
 * Environment:
 *   DATABASE_URL / APP_DATABASE_URL — connection
 *   NEXT_PUBLIC_R2_PUBLIC_URL, R2_KB_PUBLIC_URL — public bases to strip. An
 *   UNSET one is announced, not inferred away: a run that strips one base and
 *   silently ignores the other still exits 0 and still reads as clean.
 *   R2's own public host shape (https://pub-<32 hex>.r2.dev/) is matched
 *   intrinsically, so a missing env var does not blind the scan to it. A
 *   CUSTOM public domain is not intrinsic and must be passed with --base.
 *
 * Exit:
 *   0  clean — nothing left, and every column was readable by this role
 *   1  configuration error (no base, no DSN) or an unhandled failure
 *   2  at least one column could not be read by this role (row-level security)
 *   3  at least one public URL survives EMBEDDED in a value this cannot rewrite
 */

import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Schemas are DISCOVERED, not listed. A hard-coded list was "public, build,
 * build_events", which is right today and silently wrong the first time a
 * migration adds a fourth — and the whole point of this run is a number the
 * operator can trust, so a miss must not be possible by omission.
 */
const SYSTEM_SCHEMAS = ["information_schema"];
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

/**
 * Every env var that has ever named a public base. Absence of ONE of them is
 * the quiet failure: the run then strips the base it has, reports zero for the
 * other, and exits 0 — a clean-looking scan over a base it was never told
 * about. Missing names are announced rather than inferred away.
 */
const BASE_ENV_VARS = ["NEXT_PUBLIC_R2_PUBLIC_URL", "R2_KB_PUBLIC_URL"];
const missingBaseEnvVars = BASE_ENV_VARS.filter(
  (name) => !(typeof process.env[name] === "string" && process.env[name].trim().length > 0),
);

const bases = [...extraBases, ...BASE_ENV_VARS.map((name) => process.env[name])]
  .filter((value) => typeof value === "string" && value.trim().length > 0)
  .map((value) => value.trim().replace(/\/+$/, ""));

const uniqueBases = [...new Set(bases)];

/**
 * R2 serves a public bucket at https://pub-<32 hex>.r2.dev. That shape is
 * intrinsic to the provider, so it is matched whether or not anybody remembered
 * to set the env var — the scan must not go blind because a deployment's shell
 * was missing a name. A CUSTOM public domain is NOT intrinsic and still has to
 * be supplied with --base; that is the one gap this cannot close by itself.
 */
const R2_PUBLIC_DEV_URL_SOURCE = "https?://pub-[0-9a-f]{32}\\.r2\\.dev/";

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
console.log(`Public bases treated as leaked: ${uniqueBases.join(", ")}`);
console.log(`Also matched intrinsically: https://pub-<32 hex>.r2.dev/`);
if (missingBaseEnvVars.length > 0) {
  console.log(
    `NOTE: ${missingBaseEnvVars.join(", ")} ${missingBaseEnvVars.length === 1 ? "is" : "are"} not set in this environment. ` +
      "A public base served from a CUSTOM DOMAIN under a name this run was not given is NOT scanned. " +
      "Pass it with --base <url> if one was ever configured.",
  );
}
console.log("");

const sql = postgres(dsn, { prepare: false, max: 1 });

function keyFromUrl(value) {
  const intrinsic = new RegExp(`^${R2_PUBLIC_DEV_URL_SOURCE}`).exec(value);
  if (intrinsic !== null) {
    const tail = value.slice(intrinsic[0].length).split(/[?#]/, 1)[0] ?? "";
    if (tail.length > 0) {
      try {
        return decodeURIComponent(tail);
      } catch {
        return tail;
      }
    }
  }
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

async function appSchemas() {
  const rows = await sql`
    SELECT n.nspname AS schema_name
    FROM   pg_namespace n
    WHERE  n.nspname <> ALL(${SYSTEM_SCHEMAS})
      AND  n.nspname NOT LIKE 'pg\\_%'
      AND  EXISTS (
             SELECT 1 FROM pg_class c
             WHERE c.relnamespace = n.oid AND c.relkind = 'r'
           )
    ORDER  BY n.nspname
  `;
  return rows.map((r) => r.schema_name);
}

/**
 * Types whose whole value can BE a URL, and which this can therefore rewrite.
 */
const REWRITABLE_TYPES = ["text", "varchar", "bpchar"];

/**
 * Types that can CARRY a URL inside a larger value: a jsonb blob, a rich-text
 * or HTML body, an array of addresses. Restricting the scan to the rewritable
 * three is what made an earlier version of this report unsound — it printed
 * "ROWS HOLDING A PUBLIC URL: 0 … UNVERIFIABLE COLUMNS: 0" and exit 0, the exact
 * line the ticket names as closing evidence, while URLs sat in jsonb it never
 * looked at. Measured on a database at head: 501 of 5,996 URL-capable columns
 * (479 jsonb, 22 text[]) were outside the old scan.
 */
const SCAN_ONLY_TYPES = ["json", "jsonb", "xml", "_text", "_varchar"];

async function candidateColumns(APP_SCHEMAS) {
  return sql`
    SELECT n.nspname AS schema_name,
           c.relname AS table_name,
           a.attname AS column_name,
           t.typname AS type_name
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    JOIN   pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN   pg_type t ON t.oid = a.atttypid
    WHERE  n.nspname = ANY(${APP_SCHEMAS})
      AND  c.relkind = 'r'
      AND  t.typname = ANY(${[...REWRITABLE_TYPES, ...SCAN_ONLY_TYPES]})
    ORDER  BY n.nspname, c.relname, a.attname
  `;
}

async function singleColumnPrimaryKeys(APP_SCHEMAS) {
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

/**
 * Tables whose rows this role reads through a row-level-security policy.
 *
 * `relrowsecurity` alone is the wrong test: it is true for a table the owner
 * reads unfiltered, and it says nothing about BYPASSRLS or superuser.
 * `row_security_active` answers the only question that matters here — will THIS
 * role, right now, get a filtered view of this table — and it is what keeps a
 * count of zero from meaning two different things.
 */
async function rlsFilteredTables(APP_SCHEMAS) {
  const rows = await sql`
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = ANY(${APP_SCHEMAS})
      AND  c.relkind = 'r'
      AND  c.relrowsecurity
      AND  row_security_active(c.oid)
  `;
  return new Set(rows.map((r) => `${r.schema_name}.${r.table_name}`));
}

function likePatterns() {
  return uniqueBases.map((base) => `${base}/%`);
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One alternation of every public base this run knows about, plus R2's
 * intrinsic public-development host shape.
 */
const PREFIX_ALTERNATION = [
  ...uniqueBases.map((base) => `${escapeForRegex(base)}/`),
  R2_PUBLIC_DEV_URL_SOURCE,
].join("|");

/**
 * WHOLE — the value is a public URL and nothing else, so replacing it with the
 * object key is a faithful rewrite. `LIKE '<base>/%'` was the old test and it is
 * both too narrow (it never saw the intrinsic r2.dev host under a missing env
 * var) and too broad (a rich-text body that merely STARTS with a URL matched it
 * and would have been replaced wholesale by a key).
 */
const WHOLE_PATTERN = `^(${PREFIX_ALTERNATION})[^[:space:]<>"']+$`;

/**
 * CONTAINS — the value carries a public URL somewhere inside it. This is the
 * shape that hides: an <img src> in a KB page body, a "url" member in a jsonb
 * blob, one member of a text[]. It is reported, never rewritten: replacing an
 * <img src> with a bare object key breaks the render rather than fixing the
 * leak, and which JSON path is an object address is not knowable from the
 * catalog. Reporting it is the point — it turns an invisible remainder into a
 * number and a non-zero exit.
 */
const CONTAINS_PATTERN = `(${PREFIX_ALTERNATION})`;

async function countWhole(schema, table, column) {
  const rows = await sql`
    SELECT count(*)::bigint AS n
    FROM   ${sql(schema)}.${sql(table)}
    WHERE  ${sql(column)} ~ ${WHOLE_PATTERN}
  `;
  return Number(rows[0]?.n ?? 0);
}

async function countContains(schema, table, column) {
  const rows = await sql`
    SELECT count(*)::bigint AS n
    FROM   ${sql(schema)}.${sql(table)}
    WHERE  ${sql(column)}::text ~ ${CONTAINS_PATTERN}
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
          WHERE  ${sql(column)} ~ ${WHOLE_PATTERN}
          ORDER  BY ${sql(pkColumn)} ASC
          LIMIT  ${BATCH_SIZE}
        `
      : await sql`
          SELECT ${sql(pkColumn)} AS pk, ${sql(column)} AS value
          FROM   ${sql(schema)}.${sql(table)}
          WHERE  ${sql(column)} ~ ${WHOLE_PATTERN}
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

/**
 * Rewrite path for a table with no single-column primary key. Keyset paging
 * needs one, and OFFSET over a set the loop is shrinking skips rows, so this
 * repeatedly takes the FIRST page of still-matching rows instead: every update
 * removes its row from the match set, so the loop makes progress and
 * terminates. `ctid` addresses the physical row and is re-read each pass rather
 * than carried across statements, and the value is re-asserted in the WHERE so
 * a concurrent write is never clobbered.
 */
async function rewriteColumnWithoutPk(schema, table, column) {
  let rewritten = 0;

  for (;;) {
    const page = await sql`
      SELECT ctid AS row_ctid, ${sql(column)} AS value
      FROM   ${sql(schema)}.${sql(table)}
      WHERE  ${sql(column)} ~ ${WHOLE_PATTERN}
      LIMIT  ${BATCH_SIZE}
    `;
    if (page.length === 0) return rewritten;

    let updatedThisPass = 0;
    for (const row of page) {
      const key = keyFromUrl(String(row.value));
      if (key === null || key.length === 0) continue;
      const result = await sql`
        UPDATE ${sql(schema)}.${sql(table)}
        SET    ${sql(column)} = ${key}
        WHERE  ctid = ${row.row_ctid}::tid
          AND  ${sql(column)} = ${String(row.value)}
      `;
      rewritten += result.count;
      updatedThisPass += result.count;
    }

    if (updatedThisPass === 0) return rewritten;
  }
}

async function main() {
  const schemas = await appSchemas();
  console.log(`Schemas scanned: ${schemas.join(", ")}\n`);

  const rlsFiltered = await rlsFilteredTables(schemas);
  const pkByTable = await singleColumnPrimaryKeys(schemas);
  const columns = await candidateColumns(schemas);

  const findings = [];
  const embedded = [];
  const unverifiable = [];

  for (const {
    schema_name: schema,
    table_name: table,
    column_name: column,
    type_name: typeName,
  } of columns) {
    const qualified = `${schema}.${table}`;
    const rewritable = REWRITABLE_TYPES.includes(typeName);

    /**
     * A filtered read must never be reported as a count. Counting first and
     * warning afterwards is what turned "there is nothing here" and "this role
     * cannot see it" into the same line of output, and an operator reading a
     * clean report has no way to tell which one they got.
     */
    if (rlsFiltered.has(qualified)) {
      unverifiable.push({
        target: `${qualified}.${column}`,
        reason:
          "row-level security is active for this role; a count here would be filtered, not empty",
      });
      continue;
    }

    let contains;
    let whole = 0;
    try {
      contains = await countContains(schema, table, column);
      if (contains > 0 && rewritable) whole = await countWhole(schema, table, column);
    } catch (error) {
      unverifiable.push({
        target: `${qualified}.${column}`,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (contains === 0) continue;
    if (whole > 0) findings.push({ schema, table, column, matches: whole });

    /**
     * A row can hold a public URL inside a larger value in a column this can
     * rewrite (a rich-text body) or in one it cannot (jsonb, an array). Both are
     * the same finding and neither is rewritten here.
     */
    const carried = contains - whole;
    if (carried > 0)
      embedded.push({ schema, table, column, typeName, matches: carried });
  }

  let totalMatched = 0;
  let totalRewritten = 0;

  for (const finding of findings) {
    const qualified = `${finding.schema}.${finding.table}`;
    const pkColumn = pkByTable.get(qualified);
    totalMatched += finding.matches;

    console.log(
      `${qualified}.${finding.column}: ${finding.matches} row(s) hold a public URL` +
        (pkColumn ? "" : "  [no single-column primary key — paged by ctid]"),
    );

    if (!apply) continue;

    const rewritten = pkColumn
      ? await rewriteColumn(finding.schema, finding.table, finding.column, pkColumn)
      : await rewriteColumnWithoutPk(finding.schema, finding.table, finding.column);
    totalRewritten += rewritten;
    console.log(`  rewrote ${rewritten} row(s) to their object key`);
  }

  if (findings.length === 0)
    console.log("No whole-value stored public object URLs found in any scannable column.");

  let totalEmbedded = 0;
  if (embedded.length > 0) {
    console.log(
      `\n${embedded.length} column(s) carry a public object URL EMBEDDED inside a larger value.` +
        "\n  These are NOT rewritten: replacing an <img src> with a bare object key breaks the" +
        "\n  render, and which JSON path is an object address is not knowable from the catalog." +
        "\n  Each one needs a decision by whoever owns that column.",
    );
    for (const item of embedded) {
      totalEmbedded += item.matches;
      console.log(
        `  ${item.schema}.${item.table}.${item.column} (${item.typeName}): ${item.matches} row(s)`,
      );
    }
  }

  if (unverifiable.length > 0) {
    console.log(`\n${unverifiable.length} column(s) COULD NOT BE VERIFIED by this role:`);
    for (const item of unverifiable) console.log(`  ${item.target}: ${item.reason}`);
    console.log(
      "  Re-run as a role that bypasses row-level security (the database owner), or,\n" +
        "  for chat_attachments.file_url, run scripts/backfill-chat-attachment-file-url.mjs,\n" +
        "  which sets the per-organization GUC the policy reads.",
    );
  }

  console.log(
    `\n${apply ? "APPLIED" : "DRY RUN"} — ROWS HOLDING A PUBLIC URL: ${totalMatched} ` +
      `across ${findings.length} column(s); ROWS REWRITTEN: ${totalRewritten}; ` +
      `ROWS WITH AN EMBEDDED PUBLIC URL: ${totalEmbedded} across ${embedded.length} column(s); ` +
      `UNVERIFIABLE COLUMNS: ${unverifiable.length}`,
  );
  if (totalMatched > 0) {
    console.log(
      "Reminder: the objects stay fetchable at their old public addresses until the bucket is made private in the storage console.",
    );
  }

  /**
   * Exit non-zero when any column could not be read, so "the backfill reported
   * nothing" can never be mistaken for "there is nothing left" — and non-zero
   * again when a public URL survives inside a value this cannot rewrite, so a
   * remaining leak cannot be read off a run that "succeeded". Exit 2 outranks
   * exit 3: a scan this role could not complete is the more serious answer.
   */
  if (totalEmbedded > 0) process.exitCode = 3;
  if (unverifiable.length > 0) process.exitCode = 2;
}

main()
  .then(() => sql.end())
  .catch(async (error) => {
    console.error(error);
    await sql.end();
    process.exit(1);
  });
