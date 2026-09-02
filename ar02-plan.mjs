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
  SELECT con.conname, con.confdeltype,
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS cols,
         con.confdelsetcols IS NOT NULL AS has_setcols
  FROM pg_constraint con WHERE con.conname = ANY(${compNames}) AND con.contype = 'f'`;
const byName = new Map(compRows.map((r) => [r.conname, r]));

const colRows = await sql`
  SELECT n.nspname AS s, c.relname AS t, a.attname AS col, a.attnotnull
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r'`;
const notNull = new Map(colRows.map((r) => [`${r.s}.${r.t}|${r.col}`, r.attnotnull]));

const plan = { prereqUnique: [], addNew: [], rebuild: [], keep: [], dropExtraComposite: [], dropSingle: [], problems: [] };

for (const r of inv.rows) {
  const child = `${r.child_schema}.${r.child}`;
  const parent = `${r.parent_schema}.${r.parent}`;
  const colNN = notNull.get(`${child}|${r.child_col}`) === true;
  const action = DEL[r.on_delete];
  const base_ = {
    child, parent, childCol: r.child_col, parentCol: r.parent_col, single: r.constraint_name,
    action, childColNotNull: colNN, childOrgNotNull: r.child_org_notnull,
  };
  if (action === "SET NULL" && colNN)
    plan.problems.push({ kind: "SET NULL on NOT NULL column", ...base_ });

  plan.dropSingle.push({ child, name: r.constraint_name });

  const comps = (r.composite_name ?? "").split(",").filter(Boolean)
    .map((n) => byName.get(n)).filter(Boolean)
    .filter((c) => (c.cols ?? "").split(",").includes("org_id") && (c.cols ?? "").split(",").includes(r.child_col));

  if (comps.length === 0) {
    plan.addNew.push({ ...base_, name: `fk_${r.child}_${r.child_col}_org` });
    continue;
  }
  const exact = comps.filter((c) => c.confdeltype === r.on_delete);
  const canonical = (exact[0] ?? comps.slice().sort((a, b) => a.conname.localeCompare(b.conname))[0]);
  for (const c of comps) if (c.conname !== canonical.conname) plan.dropExtraComposite.push({ child, name: c.conname });
  if (exact.length > 0) plan.keep.push({ ...base_, composite: canonical.conname });
  else plan.rebuild.push({ ...base_, name: canonical.conname, currentAction: DEL[canonical.confdeltype] });
}

const parentsMissing = new Map();
for (const r of inv.rows)
  if (!r.parent_has_org_unique) parentsMissing.set(`${r.parent_schema}.${r.parent}|${r.parent_col}`,
    { table: `${r.parent_schema}.${r.parent}`, col: r.parent_col });
plan.prereqUnique = [...parentsMissing.values()];

const summary = {
  prereqUnique: plan.prereqUnique.length,
  addNew: plan.addNew.length,
  rebuild: plan.rebuild.length,
  keepExisting: plan.keep.length,
  dropExtraComposite: plan.dropExtraComposite.length,
  dropSingle: plan.dropSingle.length,
  problems: plan.problems.length,
};
console.log(JSON.stringify(summary, null, 1));
console.log("prereq:", JSON.stringify(plan.prereqUnique));
console.log("problems:", JSON.stringify(plan.problems));
console.log("rebuild actions:", JSON.stringify(plan.rebuild.reduce((a, r) => ((a[r.action] = (a[r.action] ?? 0) + 1), a), {})));
console.log("addNew actions:", JSON.stringify(plan.addNew.reduce((a, r) => ((a[r.action] = (a[r.action] ?? 0) + 1), a), {})));
console.log("keep actions:", JSON.stringify(plan.keep.reduce((a, r) => ((a[r.action] = (a[r.action] ?? 0) + 1), a), {})));
console.log("name collisions in addNew:",
  plan.addNew.map((r) => r.name).filter((n, i, a) => a.indexOf(n) !== i).join(",") || "none");
const existingNames = new Set((await sql`SELECT conname FROM pg_constraint`).map((r) => r.conname));
console.log("addNew names already taken:", plan.addNew.filter((r) => existingNames.has(r.name)).map((r) => r.name).join(",") || "none");
console.log("addNew names over 63 chars:", plan.addNew.filter((r) => r.name.length > 63).map((r) => r.name).join(",") || "none");

fs.writeFileSync("C:/Users/Aditya_Lappy/AppData/Local/Temp/ar02-final-plan.json", JSON.stringify(plan, null, 1));
await sql.end();
