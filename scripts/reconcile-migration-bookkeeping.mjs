// Record the hash of every journalled migration whose objects are demonstrably
// already in the database — and no others.
//
// 243 of 341 journal entries had no row in `drizzle.__drizzle_migrations` while
// their objects existed, because migrations applied by hand never recorded a
// hash. The next `db:migrate` would wrap all 243 in one transaction, fail on the
// first "already exists", roll back everything and swallow the error.
//
// A blind bulk insert would fix the symptom by asserting something nobody
// checked. This verifies instead: it reads what each file claims to create and
// asks the catalog whether it is there. A migration whose objects are present is
// recorded; one whose objects are missing is reported, because that one really
// does still need applying.
//
//   node scripts/reconcile-migration-bookkeeping.mjs                              # report only
//   node scripts/reconcile-migration-bookkeeping.mjs --write                     # record verified
//   node scripts/reconcile-migration-bookkeeping.mjs --self-test                 # run inline tests
//   node scripts/reconcile-migration-bookkeeping.mjs --write --acknowledge-indeterminate
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config();

const SELF_TEST = process.argv.includes("--self-test");
const WRITE = process.argv.includes("--write");
const ACK_INDET = process.argv.includes("--acknowledge-indeterminate");

// ─── Pure parsing ─────────────────────────────────────────────────────────────

/**
 * SQL comments are prose, not statements.
 *
 * A migration's header explains what it does, and those sentences contain the
 * words "create index" and "create table". Parsing them produced claims like
 * `index should` and `type public` — the same failure that made the float
 * ratchet flag its own documentation. Strip first, then read.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

function isAppSchema(s) {
  if (!s) return true;
  if (s === "pg_catalog" || s === "information_schema" || s === "pg_toast") return false;
  if (s.startsWith("pg_")) return false;
  return true;
}

/**
 * What a migration file claims to bring into existence.
 *
 * Returns arrays of structured claims rather than flat name sets so the
 * schema qualifier is preserved and matched against the catalog on (schema,
 * name) where present, falling back to name-only where the migration did not
 * qualify it.
 *
 * Also detects signals that make a migration INDETERMINATE:
 *   hasRename        — ALTER TABLE ... RENAME (TO or COLUMN) with no CREATE claims
 *   hasDynamicExecute — EXECUTE format(...) inside a DO block; DDL target is
 *                       computed at runtime and cannot be verified statically
 */
function parseClaims(raw) {
  const text = stripComments(raw);
  const tables = [];
  const columns = [];
  const types = [];
  const indexes = [];

  for (const m of text.matchAll(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?([a-z0-9_]+)"?\.)?"?([a-z0-9_]+)"?\s*\(/gi,
  )) {
    const schema = m[1]?.toLowerCase() ?? null;
    if (!isAppSchema(schema)) continue;
    tables.push({ schema, name: m[2].toLowerCase() });
  }

  for (const m of text.matchAll(
    /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:"?[a-z0-9_]+"?\.)?"?([a-z0-9_]+)"?[\s\S]{0,200}?ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi,
  ))
    columns.push({ table: m[1].toLowerCase(), col: m[2].toLowerCase() });

  for (const m of text.matchAll(
    /CREATE\s+TYPE\s+(?:"?([a-z0-9_]+)"?\.)?"?([a-z0-9_]+)"?\s+AS/gi,
  )) {
    const schema = m[1]?.toLowerCase() ?? null;
    if (!isAppSchema(schema)) continue;
    types.push({ schema, name: m[2].toLowerCase() });
  }

  for (const m of text.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"?[a-z0-9_]+"?\.)?"?([a-z0-9_]+)"?\s+ON/gi,
  ))
    indexes.push({ name: m[1].toLowerCase() });

  const hasRename =
    /ALTER\s+TABLE\s+\S+\s+RENAME\s+(?:COLUMN\s+|TO\s+)/i.test(text);
  const hasDynamicExecute =
    /\bEXECUTE\s+format\s*\(/i.test(text);

  return { tables, columns, types, indexes, hasRename, hasDynamicExecute };
}

/**
 * What a migration file removes.
 *
 * Parsed from ALL migrations to build the drop timeline independently of
 * whether those migrations are themselves INDETERMINATE. A migration that
 * drops something via EXECUTE format is conservative-flagged INDETERMINATE
 * for its own claims, but static DROP TABLE statements inside DO blocks
 * are still visible to the regex and are captured here.
 *
 * Known limitation: DROP TABLE/TYPE/INDEX inside a DO block that is reached
 * only via a conditional branch (e.g., IF setting = 'on' THEN DROP TABLE...)
 * is treated as always executing. This errs on the side of "expected-absent"
 * rather than "missing", which is the safer direction for a reconciliation tool.
 */
function parseDrops(raw) {
  const text = stripComments(raw);
  const tables = [];
  const columns = [];
  const types = [];
  const indexes = [];

  for (const m of text.matchAll(
    /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\s\S]+?)(?:\s+CASCADE|\s+RESTRICT)?\s*;/gi,
  )) {
    for (const item of m[1].split(",")) {
      const t = item.trim();
      const sqm = t.match(/^(?:"?([a-z0-9_]+)"?\.)?"?([a-z0-9_]+)"?$/i);
      if (sqm?.[2]) {
        tables.push({
          schema: sqm[1]?.toLowerCase() ?? null,
          name: sqm[2].toLowerCase(),
        });
      }
    }
  }

  for (const m of text.matchAll(
    /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:"?[a-z0-9_]+"?\.)?"?([a-z0-9_]+)"?[\s\S]{0,200}?DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi,
  ))
    columns.push({ table: m[1].toLowerCase(), col: m[2].toLowerCase() });

  for (const m of text.matchAll(/DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?([\s\S]+?);/gi)) {
    for (const item of m[1].split(",")) {
      const t = item.trim();
      const sqm = t.match(/^(?:"?([a-z0-9_]+)"?\.)?"?([a-z0-9_]+)"?$/i);
      if (sqm?.[2]) {
        types.push({
          schema: sqm[1]?.toLowerCase() ?? null,
          name: sqm[2].toLowerCase(),
        });
      }
    }
  }

  for (const m of text.matchAll(
    /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:"?[a-z0-9_]+"?\.)?"?([a-z0-9_]+)"?/gi,
  ))
    indexes.push({ name: m[1].toLowerCase() });

  return { tables, columns, types, indexes };
}

/**
 * Scan all journal entries and collect, per object name, which migration
 * indices issue a DROP for that object. Used to detect "expected-absent"
 * objects: ones absent from the live catalog because a later migration
 * deliberately removed them, not because the creating migration never ran.
 */
function buildDropTimeline(texts) {
  const tables = new Map();
  const columns = new Map();
  const types = new Map();
  const indexes = new Map();

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    if (!text) continue;
    const d = parseDrops(text);

    for (const { schema, name } of d.tables) {
      const arr = tables.get(name) ?? [];
      arr.push({ schema, migrIdx: i });
      tables.set(name, arr);
    }
    for (const { table, col } of d.columns) {
      const key = `${table}.${col}`;
      const arr = columns.get(key) ?? [];
      arr.push(i);
      columns.set(key, arr);
    }
    for (const { name } of d.types) {
      const arr = types.get(name) ?? [];
      arr.push(i);
      types.set(name, arr);
    }
    for (const { name } of d.indexes) {
      const arr = indexes.get(name) ?? [];
      arr.push(i);
      indexes.set(name, arr);
    }
  }

  return { tables, columns, types, indexes };
}

function isLaterDroppedTable(timeline, schema, name, migrIdx) {
  const drops = timeline.tables.get(name);
  if (!drops) return false;
  return drops.some(
    (d) =>
      d.migrIdx > migrIdx &&
      (d.schema === null || schema === null || d.schema === schema),
  );
}

function isLaterDroppedColumn(timeline, table, col, migrIdx) {
  return (timeline.columns.get(`${table}.${col}`) ?? []).some((idx) => idx > migrIdx);
}

function isLaterDroppedType(timeline, name, migrIdx) {
  return (timeline.types.get(name) ?? []).some((idx) => idx > migrIdx);
}

function isLaterDroppedIndex(timeline, name, migrIdx) {
  return (timeline.indexes.get(name) ?? []).some((idx) => idx > migrIdx);
}

/**
 * Classify a single migration against the live catalog and drop timeline.
 *
 * Returns one of three statuses:
 *   "verified"      All claimed objects present or expected-absent (later dropped).
 *   "pending"       One or more claimed objects absent and not explained by a later drop.
 *   "indeterminate" Cannot decide: dynamic DDL via EXECUTE, rename-only, or zero claims.
 */
function classifyMigration(claimsObj, migrIdx, live, timeline) {
  const { tables, columns, types, indexes, hasRename, hasDynamicExecute } = claimsObj;
  const total = tables.length + columns.length + types.length + indexes.length;

  if (hasDynamicExecute)
    return { status: "indeterminate", reason: "EXECUTE format() generates DDL at runtime" };
  if (total === 0 && hasRename)
    return { status: "indeterminate", reason: "only RENAME operations, no parseable CREATE claims" };
  if (total === 0)
    return { status: "indeterminate", reason: "no structural claims (backfill/grant/data-only)" };

  const missing = [];
  const expectedAbsent = [];

  for (const { schema, name } of tables) {
    const present = schema
      ? live.tablesFull.has(`${schema}.${name}`)
      : live.tablesNameOnly.has(name);
    if (!present) {
      if (isLaterDroppedTable(timeline, schema, name, migrIdx))
        expectedAbsent.push(`table ${schema ? `${schema}.` : ""}${name}`);
      else
        missing.push(`table ${schema ? `${schema}.` : ""}${name}`);
    }
  }

  for (const { table, col } of columns) {
    const present = live.columns.has(`${table}.${col}`);
    if (!present) {
      if (isLaterDroppedColumn(timeline, table, col, migrIdx))
        expectedAbsent.push(`column ${table}.${col}`);
      else
        missing.push(`column ${table}.${col}`);
    }
  }

  for (const { schema, name } of types) {
    const present = schema
      ? live.typesFull.has(`${schema}.${name}`)
      : live.typesNameOnly.has(name);
    if (!present) {
      if (isLaterDroppedType(timeline, name, migrIdx))
        expectedAbsent.push(`type ${schema ? `${schema}.` : ""}${name}`);
      else
        missing.push(`type ${schema ? `${schema}.` : ""}${name}`);
    }
  }

  for (const { name } of indexes) {
    const present = live.indexes.has(name);
    if (!present) {
      if (isLaterDroppedIndex(timeline, name, migrIdx))
        expectedAbsent.push(`index ${name}`);
      else
        missing.push(`index ${name}`);
    }
  }

  if (missing.length === 0) return { status: "verified", expectedAbsent };
  return { status: "pending", missing, expectedAbsent };
}

// ─── Self-test (no database) ──────────────────────────────────────────────────

if (SELF_TEST) {
  const syntheticLive = {
    tablesFull: new Set(["public.existing_table", "build.build_table"]),
    tablesNameOnly: new Set(["existing_table", "build_table"]),
    columns: new Set(["existing_table.id", "existing_table.name"]),
    typesFull: new Set(["public.existing_type"]),
    typesNameOnly: new Set(["existing_type"]),
    indexes: new Set(["idx_existing"]),
  };

  const syntheticTexts = Array(10).fill("");
  syntheticTexts[5] = `DROP TABLE IF EXISTS "dropped_early" CASCADE;`;
  syntheticTexts[7] = `ALTER TABLE "users" DROP COLUMN IF EXISTS "is_platform_admin";`;
  syntheticTexts[8] = `DROP TYPE IF EXISTS "public"."dropped_type";`;

  const timeline = buildDropTimeline(syntheticTexts);

  const cases = [
    [
      "create-then-later-drop resolves to VERIFIED APPLIED",
      classifyMigration(
        parseClaims(`CREATE TABLE IF NOT EXISTS "dropped_early" (id text PRIMARY KEY);`),
        0,
        syntheticLive,
        timeline,
      ).status,
      "verified",
    ],
    [
      "create with no drop and no catalog entry resolves to GENUINELY PENDING",
      classifyMigration(
        parseClaims(`CREATE TABLE IF NOT EXISTS "ghost_table" (id text PRIMARY KEY);`),
        0,
        syntheticLive,
        timeline,
      ).status,
      "pending",
    ],
    [
      "schema-qualified create in build schema matches catalog entry in that schema",
      classifyMigration(
        parseClaims(`CREATE TABLE IF NOT EXISTS "build"."build_table" (id text PRIMARY KEY);`),
        0,
        syntheticLive,
        timeline,
      ).status,
      "verified",
    ],
    [
      "dynamic EXECUTE format resolves to INDETERMINATE",
      classifyMigration(
        parseClaims(
          `DO $$ DECLARE v text; BEGIN EXECUTE format('CREATE TABLE %I (id text)', v); END $$;`,
        ),
        0,
        syntheticLive,
        timeline,
      ).status,
      "indeterminate",
    ],
    [
      "rename-only migration resolves to INDETERMINATE",
      classifyMigration(
        parseClaims(`ALTER TABLE "foo" RENAME TO "bar";`),
        0,
        syntheticLive,
        timeline,
      ).status,
      "indeterminate",
    ],
    [
      "unqualified create matches existing table present in any app schema",
      classifyMigration(
        parseClaims(`CREATE TABLE IF NOT EXISTS "existing_table" (id text PRIMARY KEY);`),
        0,
        syntheticLive,
        timeline,
      ).status,
      "verified",
    ],
    [
      "schema-qualified type matches catalog entry in that schema",
      classifyMigration(
        parseClaims(`CREATE TYPE "public"."existing_type" AS ENUM ('a', 'b');`),
        0,
        syntheticLive,
        timeline,
      ).status,
      "verified",
    ],
    [
      "drop-column later makes missing column expected-absent",
      classifyMigration(
        parseClaims(
          `ALTER TABLE "users" ADD COLUMN "is_platform_admin" boolean NOT NULL DEFAULT false;`,
        ),
        0,
        syntheticLive,
        timeline,
      ).status,
      "verified",
    ],
    [
      "drop-type later makes missing type expected-absent",
      classifyMigration(
        parseClaims(`CREATE TYPE "public"."dropped_type" AS ENUM ('x');`),
        0,
        syntheticLive,
        timeline,
      ).status,
      "verified",
    ],
    [
      "zero claims with no rename resolves to INDETERMINATE",
      classifyMigration(
        parseClaims(`GRANT SELECT ON TABLE "foo" TO streamline_app;`),
        0,
        syntheticLive,
        timeline,
      ).status,
      "indeterminate",
    ],
  ];

  let failed = 0;
  for (const [label, got, expected] of cases) {
    if (got !== expected) {
      console.error(`FAIL [${label}]: expected "${expected}", got "${got}"`);
      failed++;
    }
  }
  if (failed) process.exit(1);
  console.log(`PASS: reconcile-migration-bookkeeping self-test, ${cases.length} cases.`);
  process.exit(0);
}

// ─── Database queries ─────────────────────────────────────────────────────────

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(1); }
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

const [rawTables, rawColumns, rawTypes, rawIndexes] = await Promise.all([
  sql`SELECT s.nspname AS schema, c.relname AS name
      FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
      WHERE c.relkind IN ('r','p')
        AND s.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND s.nspname NOT LIKE 'pg_temp%'
        AND s.nspname NOT LIKE 'pg_toast_temp%'`,
  sql`SELECT c.relname AS tbl, a.attname AS col
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace s ON s.oid = c.relnamespace
      WHERE s.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND s.nspname NOT LIKE 'pg_temp%'
        AND s.nspname NOT LIKE 'pg_toast_temp%'
        AND a.attnum > 0 AND NOT a.attisdropped`,
  sql`SELECT s.nspname AS schema, t.typname AS name
      FROM pg_type t JOIN pg_namespace s ON s.oid = t.typnamespace
      WHERE s.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND s.nspname NOT LIKE 'pg_temp%'
        AND s.nspname NOT LIKE 'pg_toast_temp%'`,
  sql`SELECT schemaname AS schema, indexname AS name
      FROM pg_indexes
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND schemaname NOT LIKE 'pg_temp%'
        AND schemaname NOT LIKE 'pg_toast_temp%'`,
]);

const live = {
  tablesFull: new Set(rawTables.map((r) => `${r.schema}.${r.name}`)),
  tablesNameOnly: new Set(rawTables.map((r) => r.name)),
  columns: new Set(rawColumns.map((r) => `${r.tbl}.${r.col}`)),
  typesFull: new Set(rawTypes.map((r) => `${r.schema}.${r.name}`)),
  typesNameOnly: new Set(rawTypes.map((r) => r.name)),
  indexes: new Set(rawIndexes.map((r) => r.name)),
};

const journal = JSON.parse(readFileSync("migrations/meta/_journal.json", "utf8"));
const recorded = new Set(
  (await sql`SELECT hash FROM drizzle.__drizzle_migrations`).map((r) => r.hash),
);

const allTexts = journal.entries.map((entry) => {
  const path = `migrations/${entry.tag}.sql`;
  return existsSync(path) ? readFileSync(path, "utf8") : null;
});

const timeline = buildDropTimeline(allTexts);

// ─── Classify ─────────────────────────────────────────────────────────────────

const verified = [];
const pending = [];
const indeterminate = [];

for (let i = 0; i < journal.entries.length; i++) {
  const entry = journal.entries[i];
  const path = `migrations/${entry.tag}.sql`;
  if (!existsSync(path)) {
    pending.push({ tag: entry.tag, missing: ["file missing"], expectedAbsent: [] });
    continue;
  }
  const text = allTexts[i];
  const hash = createHash("sha256").update(text).digest("hex");
  if (recorded.has(hash)) continue;

  const c = parseClaims(text);
  const result = classifyMigration(c, i, live, timeline);

  if (result.status === "verified") {
    const total = c.tables.length + c.columns.length + c.types.length + c.indexes.length;
    verified.push({ tag: entry.tag, hash, total, expectedAbsent: result.expectedAbsent });
  } else if (result.status === "pending") {
    pending.push({ tag: entry.tag, missing: result.missing, expectedAbsent: result.expectedAbsent ?? [] });
  } else {
    indeterminate.push({ tag: entry.tag, reason: result.reason });
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

const alreadyRecorded =
  journal.entries.length - verified.length - pending.length - indeterminate.length;

console.log(`journal entries          ${journal.entries.length}`);
console.log(`already recorded         ${alreadyRecorded}`);
console.log(`verified applied         ${verified.length}${WRITE ? " (recording)" : " (run with --write to record)"}`);
console.log(`genuinely pending        ${pending.length}`);
console.log(`indeterminate            ${indeterminate.length}`);

if (pending.length) {
  console.log("\nGENUINELY PENDING — absent objects not explained by a later drop:");
  for (const { tag, missing, expectedAbsent } of pending) {
    const suffix =
      missing.length === 1 ? missing[0] : `${missing.length} missing — e.g. ${missing[0]}`;
    console.log(`  ${tag}  ${suffix}`);
    if (expectedAbsent.length)
      console.log(`    (later-dropped, so not counted above: ${expectedAbsent.join(", ")})`);
  }
}

if (indeterminate.length) {
  console.log("\nINDETERMINATE — static analysis cannot decide; not recorded by --write:");
  for (const { tag, reason } of indeterminate) console.log(`  ${tag}  (${reason})`);
  console.log(
    `\n  Re-run with --write --acknowledge-indeterminate to record only the verified-applied set`,
    `\n  while leaving these unrecorded. Review each manually before running them.`,
  );
}

const verifiedWithDropped = verified.filter((v) => v.expectedAbsent.length > 0);
if (verifiedWithDropped.length) {
  console.log(
    "\nVERIFIED APPLIED (objects below absent because a later migration dropped them):",
  );
  for (const { tag, expectedAbsent } of verifiedWithDropped) {
    console.log(`  ${tag}`);
    for (const e of expectedAbsent) console.log(`    expected-absent: ${e}`);
  }
}

// ─── Write ────────────────────────────────────────────────────────────────────

if (WRITE) {
  if (indeterminate.length && !ACK_INDET) {
    console.error(
      `\n--write refused: ${indeterminate.length} migration(s) are INDETERMINATE.` +
        ` A ledger rebuilt over undecidable entries is worse than no rebuild.` +
        ` Re-run with --write --acknowledge-indeterminate to record only the` +
        ` ${verified.length} verified-applied migrations while leaving the` +
        ` indeterminate ones unrecorded.`,
    );
    await sql.end();
    process.exit(1);
  }

  if (verified.length) {
    let stamp = Date.now() - verified.length;
    for (const { hash } of verified) {
      await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${stamp})`;
      stamp += 1;
    }
    console.log(`\nRecorded ${verified.length} verified migrations.`);
  } else {
    console.log("\nNothing to record.");
  }
}

await sql.end();
