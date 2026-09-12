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
//   node scripts/reconcile-migration-bookkeeping.mjs           # report only
//   node scripts/reconcile-migration-bookkeeping.mjs --write   # record verified
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config();
const WRITE = process.argv.includes("--write");
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(1); }
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

/**
 * SQL comments are prose, not statements.
 *
 * A migration's header explains what it does, and those sentences contain the
 * words "create index" and "create table". Parsing them produced claims like
 * `index should` and `type public` — the same failure that made the float
 * ratchet flag its own documentation. Strip first, then read.
 */
function statements(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/** What a migration file claims to bring into existence. */
function claims(raw) {
  const text = statements(raw);
  const tables = new Set();
  const columns = new Set();
  const types = new Set();
  const indexes = new Set();

  for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?\s*\(/gi))
    tables.add(m[1].toLowerCase());
  for (const m of text.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?"?([a-z0-9_]+)"?[\s\S]{0,200}?ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi))
    columns.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`);
  for (const m of text.matchAll(/CREATE\s+TYPE\s+(?:"?public"?\.)?"?([a-z0-9_]+)"?\s+AS/gi))
    types.add(m[1].toLowerCase());
  for (const m of text.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?\s+ON/gi))
    indexes.add(m[1].toLowerCase());

  return { tables, columns, types, indexes };
}

const [liveTables, liveColumns, liveTypes, liveIndexes] = await Promise.all([
  sql`SELECT c.relname AS n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
      WHERE s.nspname='public' AND c.relkind IN ('r','p')`,
  sql`SELECT c.relname||'.'||a.attname AS n FROM pg_attribute a
      JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace s ON s.oid=c.relnamespace
      WHERE s.nspname='public' AND a.attnum>0 AND NOT a.attisdropped`,
  sql`SELECT t.typname AS n FROM pg_type t JOIN pg_namespace s ON s.oid=t.typnamespace
      WHERE s.nspname='public'`,
  sql`SELECT indexname AS n FROM pg_indexes WHERE schemaname='public'`,
]);
const live = {
  tables: new Set(liveTables.map((r) => r.n)),
  columns: new Set(liveColumns.map((r) => r.n)),
  types: new Set(liveTypes.map((r) => r.n)),
  indexes: new Set(liveIndexes.map((r) => r.n)),
};

const journal = JSON.parse(readFileSync("migrations/meta/_journal.json", "utf8"));
const recorded = new Set((await sql`SELECT hash FROM drizzle.__drizzle_migrations`).map((r) => r.hash));

const verified = [];
const unapplied = [];
const noClaims = [];

for (const entry of journal.entries) {
  const path = `migrations/${entry.tag}.sql`;
  if (!existsSync(path)) { unapplied.push([entry.tag, "file missing"]); continue; }
  const text = readFileSync(path, "utf8");
  const hash = createHash("sha256").update(text).digest("hex");
  if (recorded.has(hash)) continue;

  const c = claims(text);
  const total = c.tables.size + c.columns.size + c.types.size + c.indexes.size;
  // A migration that only backfills, grants or alters data claims no object this
  // can check. Recording it would be the blind insert this script exists to
  // avoid, so it is reported and left alone.
  if (total === 0) { noClaims.push(entry.tag); continue; }

  const missing = [
    ...[...c.tables].filter((t) => !live.tables.has(t)).map((t) => `table ${t}`),
    ...[...c.columns].filter((t) => !live.columns.has(t)).map((t) => `column ${t}`),
    ...[...c.types].filter((t) => !live.types.has(t)).map((t) => `type ${t}`),
    ...[...c.indexes].filter((t) => !live.indexes.has(t)).map((t) => `index ${t}`),
  ];
  if (missing.length === 0) verified.push([entry.tag, hash, total]);
  else unapplied.push([entry.tag, `${missing.length}/${total} missing — e.g. ${missing[0]}`]);
}

console.log(`journal entries        ${journal.entries.length}`);
console.log(`already recorded       ${journal.entries.length - verified.length - unapplied.length - noClaims.length}`);
console.log(`verified applied       ${verified.length}${WRITE ? " (recording)" : " (run with --write to record)"}`);
console.log(`genuinely not applied  ${unapplied.length}`);
console.log(`claims nothing checkable ${noClaims.length}`);

if (unapplied.length) {
  console.log("\nNOT APPLIED — these need running, not recording:");
  for (const [tag, why] of unapplied) console.log(`  ${tag}  ${why}`);
}
if (noClaims.length) {
  console.log("\nNo checkable object (backfill/grant/data only) — left unrecorded deliberately:");
  for (const tag of noClaims) console.log(`  ${tag}`);
}

if (WRITE && verified.length) {
  let stamp = Date.now() - verified.length;
  for (const [, hash] of verified) {
    await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${stamp})`;
    stamp += 1;
  }
  console.log(`\nRecorded ${verified.length} verified migrations.`);
}
await sql.end();
