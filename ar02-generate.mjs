import fs from "node:fs";
import path from "node:path";
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
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS cols
  FROM pg_constraint con WHERE con.conname = ANY(${compNames}) AND con.contype = 'f'`;
const byName = new Map(compRows.map((r) => [r.conname, r]));
const allConstraintNames = new Set((await sql`SELECT conname FROM pg_constraint`).map((r) => r.conname));

function canonicalName(child, col) {
  const bare = child.replace(/^[^.]+\./, "");
  let n = `fk_${bare}_${col}_org`;
  if (n.length <= 63) return n;
  n = `fk_${bare}_${col.replace(/_id$/, "")}_org`;
  if (n.length <= 63) return n;
  return n.slice(0, 63);
}

const rels = [];
for (const r of inv.rows) {
  const child = `${r.child_schema}.${r.child}`;
  const parent = `${r.parent_schema}.${r.parent}`;
  const name = canonicalName(child, r.child_col);
  const comps = (r.composite_name ?? "").split(",").filter(Boolean)
    .map((n) => byName.get(n)).filter(Boolean)
    .filter((c) => (c.cols ?? "").split(",").includes("org_id") && (c.cols ?? "").split(",").includes(r.child_col));
  const match = comps.find((c) => c.conname === name);
  rels.push({
    child, parent, col: r.child_col, parentCol: r.parent_col, single: r.constraint_name,
    action: DEL[r.on_delete], name,
    existing: comps.map((c) => ({ name: c.conname, action: DEL[c.confdeltype] })),
    keep: Boolean(match && DEL[match.confdeltype] === r.action),
    keepOk: Boolean(match && match.confdeltype === r.on_delete),
    dropExtras: comps.filter((c) => c.conname !== name).map((c) => c.conname),
    rebuildNamed: Boolean(match && match.confdeltype !== r.on_delete),
    addNew: !match,
  });
}

const dupNames = rels.map((r) => `${r.child}|${r.name}`).filter((n, i, a) => a.indexOf(n) !== i);
const nameCollision = rels.filter((r) => !r.existing.some((e) => e.name === r.name) && allConstraintNames.has(r.name));

const summary = {
  total: rels.length,
  keepOk: rels.filter((r) => r.keepOk).length,
  rebuildNamed: rels.filter((r) => r.rebuildNamed).length,
  addNew: rels.filter((r) => r.addNew).length,
  extrasToDrop: rels.reduce((a, r) => a + r.dropExtras.length, 0),
  tooLongNames: rels.filter((r) => r.name.length > 63).length,
  duplicateCanonicalNames: dupNames.length,
  canonicalNameAlreadyTakenElsewhere: nameCollision.length,
};
console.log(JSON.stringify(summary, null, 1));
if (dupNames.length) console.log("DUP:", dupNames.join(", "));
if (nameCollision.length) console.log("COLLISION:", nameCollision.map((r) => r.name).join(", "));

fs.writeFileSync("C:/Users/Aditya_Lappy/AppData/Local/Temp/ar02-rels.json", JSON.stringify(rels, null, 1));

const dropped = [...new Set([...rels.map((r) => r.single), ...rels.flatMap((r) => r.dropExtras)])];
fs.writeFileSync("C:/Users/Aditya_Lappy/AppData/Local/Temp/ar02-dropped-names.txt", dropped.join("\n"));
console.log("distinct constraint names to be dropped:", dropped.length);

const parentsMissing = new Map();
for (const r of inv.rows)
  if (!r.parent_has_org_unique)
    parentsMissing.set(`${r.parent_schema}.${r.parent}|${r.parent_col}`, { table: `${r.parent_schema}.${r.parent}`, col: r.parent_col });
console.log("prereq unique:", JSON.stringify([...parentsMissing.values()]));

await sql.end();
