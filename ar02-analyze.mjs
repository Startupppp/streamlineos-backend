import fs from "node:fs";
import postgres from "postgres";

const env = fs.readFileSync(".env", "utf8");
const base = (env.match(/^DATABASE_URL=(.*)$/m)?.[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
const url = base.replace(/\/neondb(\?|$)/, "/scratch_boot_a$1");
const inv = JSON.parse(fs.readFileSync("C:/Users/Aditya_Lappy/AppData/Local/Temp/ar02-inventory.json", "utf8"));
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {}, connect_timeout: 30 });

const DEL = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };

const withComposite = inv.rows.filter((r) => r.composite_already_exists);
const needComposite = inv.rows.filter((r) => !r.composite_already_exists);

const compNames = [...new Set(withComposite.flatMap((r) => (r.composite_name ?? "").split(",").filter(Boolean)))];
const compRows = compNames.length
  ? await sql`
      SELECT con.conname, con.confdeltype, con.confupdtype,
             (SELECT string_agg(a.attname, ',' ORDER BY x.ord)
                FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS cols,
             (SELECT count(*) FROM pg_attribute a
                WHERE a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey) AND a.attnotnull) AS notnull_cols,
             con.confdelsetcols IS NOT NULL AS has_setcols
      FROM pg_constraint con WHERE con.conname = ANY(${compNames}) AND con.contype='f'`
  : [];
const compByName = new Map(compRows.map((r) => [r.conname, r]));

const mismatched = [];
for (const r of withComposite) {
  for (const cn of (r.composite_name ?? "").split(",").filter(Boolean)) {
    const c = compByName.get(cn);
    if (!c) { mismatched.push({ ...r, why: "composite not found", cn }); continue; }
    if (c.confdeltype !== r.on_delete)
      mismatched.push({ child: `${r.child_schema}.${r.child}`, col: r.child_col, single: r.constraint_name,
        singleDel: DEL[r.on_delete], composite: cn, compositeDel: DEL[c.confdeltype], setcols: c.has_setcols });
  }
}

const childCols = needComposite.map((r) => ({ t: `${r.child_schema}.${r.child}`, c: r.child_col }));
const nullRows = await sql`
  SELECT n.nspname||'.'||c.relname AS tbl, a.attname AS col, a.attnotnull
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE (n.nspname||'.'||c.relname||'.'||a.attname) = ANY(${childCols.map((x) => `${x.t}.${x.c}`)})`;
const nn = new Map(nullRows.map((r) => [`${r.tbl}.${r.col}`, r.attnotnull]));

const setNullOnNotNull = needComposite.filter(
  (r) => r.on_delete === "n" && nn.get(`${r.child_schema}.${r.child}.${r.child_col}`) === true,
);

console.log("=== composite already exists:", withComposite.length);
console.log("  ON DELETE mismatch single vs composite:", mismatched.length);
for (const m of mismatched.slice(0, 60)) console.log("   ", JSON.stringify(m));
console.log("");
console.log("=== need new composite:", needComposite.length);
console.log("  SET NULL targeting a NOT NULL child column (would be illegal):", setNullOnNotNull.length);
for (const r of setNullOnNotNull) console.log("   ", `${r.child_schema}.${r.child}.${r.child_col} -> ${r.parent_schema}.${r.parent}`, r.constraint_name);
console.log("");
console.log("=== nullable child org_id:");
for (const r of inv.rows.filter((x) => !x.child_org_notnull))
  console.log("   ", `${r.child_schema}.${r.child}`, r.constraint_name, "org_type", r.child_org_type);
console.log("");
console.log("=== parent col not 'id':");
for (const r of inv.rows.filter((x) => x.parent_col !== "id"))
  console.log("   ", `${r.child_schema}.${r.child}.${r.child_col} -> ${r.parent_schema}.${r.parent}.${r.parent_col}`, r.constraint_name);
console.log("");
console.log("=== need-composite grouped by child schema.table (top 40):");
const g = {};
for (const r of needComposite) g[`${r.child_schema}.${r.child}`] = (g[`${r.child_schema}.${r.child}`] ?? 0) + 1;
for (const [k, v] of Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log("   ", k, v);
console.log("   distinct child tables needing composite:", Object.keys(g).length);

fs.writeFileSync("C:/Users/Aditya_Lappy/AppData/Local/Temp/ar02-split.json", JSON.stringify(
  { needComposite, withComposite, mismatched, setNullOnNotNull, notNullMap: Object.fromEntries(nn) }, null, 1));
await sql.end();
