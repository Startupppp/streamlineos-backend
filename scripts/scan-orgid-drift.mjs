import postgres from "postgres";
import fs from "node:fs";
import path from "node:path";

const sql = postgres(process.env.DATABASE_URL, { prepare: false, ssl: "require", max: 1 });

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith(".ts") && !entry.name.includes("spec")) acc.push(full);
  }
  return acc;
}

const blocks = new Map();
for (const file of walk("src/db/schema")) {
  const src = fs.readFileSync(file, "utf8");
  const re = /pgTable\(\s*"([a-z_0-9]+)"([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(src))) blocks.set(m[1], { body: m[2], file });
}

const rows = await sql`
  select table_name from information_schema.columns
  where table_schema = 'public' and column_name = 'org_id'
    and is_nullable = 'NO' and column_default is null`;

const missing = [];
const unmodelled = [];
for (const { table_name: table } of rows) {
  const block = blocks.get(table);
  if (!block) { unmodelled.push(table); continue; }
  if (!block.body.includes("org_id")) missing.push(`${table}  <-  ${block.file.split(path.sep).join("/")}`);
}

console.log(`DB tables with NOT NULL org_id, no default : ${rows.length}`);
console.log(`modelled in drizzle, MISSING org_id        : ${missing.length}`);
missing.forEach((x) => console.log("   INSERTS FAIL:", x));
console.log(`in DB but not modelled as pgTable          : ${unmodelled.length}`);
unmodelled.slice(0, 20).forEach((x) => console.log("   unmodelled:", x));

await sql.end();
