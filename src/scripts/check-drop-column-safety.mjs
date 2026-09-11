/**
 * A migration that drops a column the Drizzle schema still declares is invisible
 * to every other gate. Typecheck, openapi:generate, madge, knip and the whole test
 * suite stay green, because only a live query discovers the mismatch — Drizzle emits
 * the dropped column in every `findFirst`/`findMany` without an explicit projection
 * and Postgres answers 42703.
 *
 * Passes when no column dropped by an unapplied migration is still declared.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const MIGRATIONS = join(ROOT, "migrations");
const SCHEMA = join(ROOT, "src/db/schema");
const DROP_RE = /ALTER TABLE\s+"?([a-z_][a-z0-9_]*)"?\s+DROP COLUMN(?:\s+IF EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?/gi;
const ADD_RE = /ALTER TABLE\s+"?([a-z_][a-z0-9_]*)"?\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?/gi;

function collectDrops(sql, tag) {
  const out = [];
  for (const m of sql.matchAll(DROP_RE)) out.push({ tag, table: m[1], column: m[2] });
  return out;
}

function collectAdds(sql, tag) {
  const out = [];
  for (const m of sql.matchAll(ADD_RE)) out.push({ tag, table: m[1], column: m[2] });
  return out;
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

/**
 * Scoped to the specific pgTable block. A file-wide search reports a same-named
 * column on a neighbouring table in the same file — `auth.ts` declares `role` on
 * `organization_members` and `invitations`, which would otherwise be read as a
 * still-declared `users.role`.
 */
function tableBlock(source, table) {
  const start = source.indexOf(`pgTable("${table}"`);
  if (start === -1) return null;
  let i = source.indexOf("{", start);
  if (i === -1) return null;
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    const c = source[j];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(i, j + 1);
    }
  }
  return null;
}

function declaresColumn(source, table, column) {
  const block = tableBlock(source, table);
  if (block === null) return false;
  return block.includes(`("${column}")`) || block.includes(`("${column}",`);
}

function selfTest() {
  const drops = collectDrops(
    `ALTER TABLE foo DROP COLUMN IF EXISTS bar;
     ALTER TABLE "baz" DROP COLUMN qux;`,
    "t",
  );
  const ok = [
    ["parses both quoted and unquoted forms", drops.length === 2],
    ["captures table and column", drops[0].table === "foo" && drops[0].column === "bar"],
    ["strips quotes", drops[1].table === "baz" && drops[1].column === "qux"],
    [
      "detects a still-declared column",
      declaresColumn(`pgTable("foo", { bar: text("bar") })`, "foo", "bar"),
    ],
    [
      "detects the trailing-comma declaration form",
      declaresColumn(`pgTable("foo", { bar: text("bar", { length: 2 }) })`, "foo", "bar"),
    ],
    [
      "does not fire for a same-named column on another table",
      !declaresColumn(`pgTable("other", { bar: text("bar") })`, "foo", "bar"),
    ],
    [
      "does not fire for a same-named column on a neighbouring table in the same file",
      !declaresColumn(
        `export const a = pgTable("foo", { id: text("id") });\nexport const b = pgTable("other", { bar: text("bar") });`,
        "foo",
        "bar",
      ),
    ],
    [
      "still fires for the correct table in a multi-table file",
      declaresColumn(
        `export const a = pgTable("foo", { bar: text("bar") });\nexport const b = pgTable("other", { baz: text("baz") });`,
        "foo",
        "bar",
      ),
    ],
    [
      "spans a nested brace block without ending early",
      declaresColumn(`pgTable("foo", { a: text("a", { length: 2 }), bar: text("bar") })`, "foo", "bar"),
    ],
    [
      "does not fire when the column is absent",
      !declaresColumn(`pgTable("foo", { baz: text("baz") })`, "foo", "bar"),
    ],
  ];
  let failed = 0;
  for (const [name, pass] of ok) {
    console.log(`  [${pass ? "pass" : "FAIL"}] ${name}`);
    if (!pass) failed++;
  }
  console.log(failed === 0 ? "\nSELF-TEST PASSED" : `\nSELF-TEST FAILED (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv.includes("--self-test")) selfTest();

const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8"));
const applied = new Set(journal.entries.map((e) => e.tag));

const onlyUnapplied = process.argv.includes("--unapplied-only");
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .filter((f) => !onlyUnapplied || !applied.has(f.replace(/\.sql$/, "")));

const ordered = [...files].sort();
const sources = new Map(ordered.map((f) => [f, readFileSync(join(MIGRATIONS, f), "utf8")]));

/**
 * A column dropped and later re-added is not a drop. Replaying both statement kinds
 * in migration order is what distinguishes a real contraction from a rename cycle;
 * counting DROPs alone reports every re-added column as missing.
 */
const effective = new Map();
for (const f of ordered) {
  const tag = f.replace(/\.sql$/, "");
  const sql = sources.get(f);

  for (const d of collectDrops(sql, tag))
    effective.set(`${d.table}.${d.column}`, { ...d, dropped: true });
  for (const a of collectAdds(sql, tag))
    effective.set(`${a.table}.${a.column}`, { ...a, dropped: false });

  // A column-type swap drops the old column and renames a temporary one back over it
  // (ADD department_id_new -> DROP department_id -> RENAME department_id_new TO
  // department_id). Without RENAME the drop reads as permanent and the column that
  // still exists is reported missing.
  const RENAME_RE =
    /ALTER TABLE\s+"?([a-z_][a-z0-9_]*)"?\s+RENAME COLUMN\s+"?([a-z_][a-z0-9_]*)"?\s+TO\s+"?([a-z_][a-z0-9_]*)"?/gi;
  for (const m of sql.matchAll(RENAME_RE)) {
    effective.delete(`${m[1]}.${m[2]}`);
    effective.set(`${m[1]}.${m[3]}`, { tag, table: m[1], column: m[3], dropped: false });
  }

  // A recreated table reintroduces every column at once, so a CREATE TABLE clears
  // that table's accumulated drops. 47 CRM and accounting tables were recreated
  // from the baseline this way; without this, each reads as a permanent drop.
  for (const m of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?/gi))
    for (const key of [...effective.keys()])
      if (key.startsWith(`${m[1]}.`)) effective.delete(key);
}
const drops = [...effective.values()].filter((e) => e.dropped);

const schemaFiles = walk(SCHEMA).map((p) => ({ path: p, source: readFileSync(p, "utf8") }));

const violations = [];
for (const d of drops)
  for (const s of schemaFiles)
    if (declaresColumn(s.source, d.table, d.column))
      violations.push({ ...d, file: s.path.replace(ROOT, "").replace(/\\/g, "/") });

console.log(
  `check-drop-column-safety: ${files.length} migration file(s), ${drops.length} dropped column(s), ${schemaFiles.length} schema file(s)`,
);

// The cross-product below is empty when EITHER side is empty, so an unreachable
// migrations dir, an unreachable schema dir, or a DROP parser that matched nothing
// all print the same "OK" as a genuinely safe tree. Each side gets its own floor.
const MIN_MIGRATION_FILES = 100;
const MIN_SCHEMA_FILES = 50;
const MIN_DROPS = 1;
const inconclusive = [];
if (files.length < MIN_MIGRATION_FILES)
  inconclusive.push(`only ${files.length} migration file(s) read (floor ${MIN_MIGRATION_FILES})`);
if (schemaFiles.length < MIN_SCHEMA_FILES)
  inconclusive.push(`only ${schemaFiles.length} schema file(s) read (floor ${MIN_SCHEMA_FILES})`);
if (drops.length < MIN_DROPS)
  inconclusive.push(
    `the DROP COLUMN parser matched ${drops.length} drop(s) across ${files.length} migrations — history contains drops, so zero means the parser stopped matching`,
  );
if (inconclusive.length > 0) {
  console.error(`\nINCONCLUSIVE — this run compared nothing:`);
  for (const r of inconclusive) console.error(`  ${r}`);
  process.exit(2);
}

if (violations.length === 0) {
  console.log("  OK — no dropped column is still declared in the Drizzle schema");
  process.exit(0);
}

console.error(`\nFAIL — ${violations.length} dropped column(s) still declared:\n`);
for (const v of violations)
  console.error(`  ${v.table}.${v.column}  dropped by ${v.tag}\n      still declared in ${v.file}`);
console.error(
  `\nDrizzle will emit the dropped column in every query without an explicit projection,` +
    `\nso Postgres answers 42703 at runtime while every other gate stays green.` +
    `\nRemove the column from the table definition AND any index or constraint referencing it.`,
);
process.exit(1);
