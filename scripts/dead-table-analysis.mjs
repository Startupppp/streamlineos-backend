import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, ssl: "require", max: 1 });

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(full, acc); }
    else if (/\.(ts|mjs|sql)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

// Every source file OUTSIDE the schema folder — a schema file referencing itself is not a use.
const schemaDir = path.resolve("src/db/schema");
const sourceFiles = walk(path.resolve("src")).filter((f) => !f.startsWith(schemaDir));
const migrationFiles = walk(path.resolve("migrations"));
const sourceText = sourceFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
const schemaText = walk(schemaDir).map((f) => fs.readFileSync(f, "utf8")).join("\n");

// table_name -> exported drizzle symbol, from `export const X = ...table("table_name"`
// Matches pgTable("x"), build.table("x"), buildEvents.table("x") — the capital T in
// pgTable is why a lowercase-only pattern silently maps nothing and reports every
// table as unreferenced.
const symbolFor = new Map();
for (const m of schemaText.matchAll(
  /export const (\w+)\s*=\s*(?:pgTable|\w+\.table)\(\s*"([a-z0-9_]+)"/g,
)) {
  symbolFor.set(m[2], m[1]);
}
const unmapped = [];

const empty = await sql`
  select c.relname as tbl
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  join pg_stat_user_tables s on s.relid = c.oid
  where c.relkind = 'r' and c.relname like 'hr\\_%' and s.n_live_tup = 0
  order by c.relname`;

const rows = [];
for (const { tbl } of empty) {
  const symbol = symbolFor.get(tbl);
  // A table with no resolvable symbol is NOT evidence of deadness — it means the
  // mapping failed. Treat it as unknown and exclude it from the safe list.
  if (!symbol) { unmapped.push(tbl); continue; }
  const symbolUsed = new RegExp(`\\b${symbol}\\b`).test(sourceText);
  // raw table name in application code or raw SQL
  const rawUsed = new RegExp(`["'\`\\s.(]${tbl}["'\`\\s,)]`).test(sourceText);
  // inbound foreign keys from OTHER tables
  const fks = await sql`
    select conrelid::regclass::text as child
    from pg_constraint
    where confrelid = ('public.' || ${tbl})::regclass and contype = 'f'
      and conrelid <> confrelid`;
  const inbound = [...new Set(fks.map((f) => f.child))].filter((c) => c !== `${tbl}` && c !== `public.${tbl}`);
  rows.push({ tbl, symbol: symbol ?? "(unmapped)", symbolUsed, rawUsed, inbound });
}

const safe = rows.filter((r) => !r.symbolUsed && !r.rawUsed && r.inbound.length === 0);
const wired = rows.filter((r) => r.symbolUsed || r.rawUsed);
const referenced = rows.filter((r) => !r.symbolUsed && !r.rawUsed && r.inbound.length > 0);

console.log(`empty hr_* tables examined : ${rows.length + unmapped.length}`);
console.log(`  UNMAPPED (no symbol found): ${unmapped.length}  <- analysis inconclusive, never delete on this`);
console.log(`  WIRED (code references)  : ${wired.length}  <- empty but alive, do NOT delete`);
console.log(`  FK-referenced only       : ${referenced.length}  <- needs child handled first`);
console.log(`  SAFE deletion candidates : ${safe.length}`);
console.log(`\n--- safe candidates ---`);
safe.forEach((r) => console.log("   ", r.tbl));
console.log(`\n--- FK-referenced (blocked) ---`);
referenced.forEach((r) => console.log("   ", r.tbl, "<-", r.inbound.join(", ")));

await sql.end();
