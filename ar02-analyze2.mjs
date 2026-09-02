import fs from "node:fs";
import postgres from "postgres";

const env = fs.readFileSync(".env", "utf8");
const base = (env.match(/^DATABASE_URL=(.*)$/m)?.[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
const url = base.replace(/\/neondb(\?|$)/, "/scratch_boot_a$1");
const inv = JSON.parse(fs.readFileSync("C:/Users/Aditya_Lappy/AppData/Local/Temp/ar02-inventory.json", "utf8"));
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {}, connect_timeout: 30 });
const DEL = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };

const compNames = [...new Set(inv.rows.flatMap((r) => (r.composite_name ?? "").split(",").filter(Boolean)))];
const compRows = await sql`
  SELECT con.conname, con.confdeltype, con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent,
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS cols,
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(con.confkey) WITH ORDINALITY AS x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = x.attnum) AS fcols
  FROM pg_constraint con WHERE con.conname = ANY(${compNames}) AND con.contype = 'f'`;
const byName = new Map(compRows.map((r) => [r.conname, r]));

const allCols = [...new Set(inv.rows.map((r) => `${r.child_schema}.${r.child}|${r.child_col}`))];
const colRows = await sql`
  SELECT n.nspname AS s, c.relname AS t, a.attname AS col, a.attnotnull
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r'`;
const notNull = new Map(colRows.map((r) => [`${r.s}.${r.t}|${r.col}`, r.attnotnull]));

const plan = { prereqUnique: [], rebuild: [], addNew: [], dropOnly: [], drops: [], problems: [] };

for (const r of inv.rows) {
  const child = `${r.child_schema}.${r.child}`;
  const parent = `${r.parent_schema}.${r.parent}`;
  const colNN = notNull.get(`${child}|${r.child_col}`) === true;
  const action = DEL[r.on_delete];
  if (r.on_delete === "n" && colNN)
    plan.problems.push({ kind: "SET NULL on NOT NULL col", child, col: r.child_col, fk: r.constraint_name });
  const entry = {
    child, parent, childCol: r.child_col, parentCol: r.parent_col,
    single: r.constraint_name, action, childColNotNull: colNN,
    childOrgNotNull: r.child_org_notnull, parentHasUnique: r.parent_has_org_unique,
  };
  plan.drops.push({ child, single: r.constraint_name });

  const comps = (r.composite_name ?? "").split(",").filter(Boolean)
    .map((n) => byName.get(n)).filter(Boolean)
    .filter((c) => (c.cols ?? "").split(",").includes("org_id") && (c.cols ?? "").split(",").includes(r.child_col));

  if (comps.length === 0) { plan.addNew.push({ ...entry, name: `fk_${r.child}_${r.child_col}_org` }); continue; }
  if (comps.length > 1) plan.problems.push({ kind: "multiple composites", child, col: r.child_col, names: comps.map((c) => c.conname) });
  const c = comps[0];
  if (c.confdeltype === r.on_delete) plan.dropOnly.push({ ...entry, composite: c.conname });
  else plan.rebuild.push({ ...entry, composite: c.conname, currentAction: DEL[c.confdeltype] });
}

for (const p of new Map(inv.rows.filter((r) => !r.parent_has_org_unique)
  .map((r) => [`${r.parent_schema}.${r.parent}|${r.parent_col}`, r])).values())
  plan.prereqUnique.push({ table: `${p.parent_schema}.${p.parent}`, col: p.parent_col });

console.log("prereq unique:", plan.prereqUnique.length, JSON.stringify(plan.prereqUnique));
console.log("addNew:", plan.addNew.length);
console.log("rebuild (action mismatch):", plan.rebuild.length);
console.log("dropOnly (action already matches):", plan.dropOnly.length);
console.log("total drops:", plan.drops.length);
console.log("problems:", plan.problems.length, JSON.stringify(plan.problems));
console.log("");
console.log("rebuild action distribution:", JSON.stringify(plan.rebuild.reduce((a, r) => ((a[r.action] = (a[r.action] ?? 0) + 1), a), {})));
console.log("addNew action distribution:", JSON.stringify(plan.addNew.reduce((a, r) => ((a[r.action] = (a[r.action] ?? 0) + 1), a), {})));
console.log("dropOnly action distribution:", JSON.stringify(plan.dropOnly.reduce((a, r) => ((a[r.action] = (a[r.action] ?? 0) + 1), a), {})));
console.log("");
console.log("SET NULL rebuilds on nullable col:", plan.rebuild.filter((r) => r.action === "SET NULL" && !r.childColNotNull).length);
console.log("addNew where child org_id nullable:", plan.addNew.filter((r) => !r.childOrgNotNull).length);
console.log("rebuild where child org_id nullable:", plan.rebuild.filter((r) => !r.childOrgNotNull).length);
console.log("dropOnly names sample:", plan.dropOnly.slice(0, 8).map((r) => `${r.child}.${r.childCol}[${r.action}]`).join(" "));

fs.writeFileSync("C:/Users/Aditya_Lappy/AppData/Local/Temp/ar02-plan.json", JSON.stringify(plan, null, 1));
await sql.end();
