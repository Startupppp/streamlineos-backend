import fs from "node:fs";
import path from "node:path";

const rels = JSON.parse(fs.readFileSync("C:/Users/Aditya_Lappy/AppData/Local/Temp/ar02-rels.json", "utf8"));
const MIG = "migrations";
const START_NUM = Number(process.argv.find((a) => a.startsWith("--start="))?.slice(8) ?? "960");

const byRel = new Map();
for (const r of rels) {
  const k = `${r.child}|${r.col}|${r.parent}`;
  if (!byRel.has(k)) byRel.set(k, { ...r, singles: [] });
  byRel.get(k).singles.push(r.single);
  for (const e of r.dropExtras) if (!byRel.get(k).dropExtras.includes(e)) byRel.get(k).dropExtras.push(e);
}
const relations = [...byRel.values()].sort((a, b) =>
  a.child.localeCompare(b.child) || a.col.localeCompare(b.col) || a.parent.localeCompare(b.parent));

function onDelete(action, col) {
  if (action === "SET NULL") return `\n  ON DELETE SET NULL (${col})`;
  if (action === "CASCADE") return "\n  ON DELETE CASCADE";
  if (action === "RESTRICT") return "\n  ON DELETE RESTRICT";
  return "";
}

const addStatements = [];
for (const r of relations) {
  if (r.keepOk) continue;
  if (r.rebuildNamed)
    addStatements.push(`ALTER TABLE ${r.child} DROP CONSTRAINT ${r.name};`);
  addStatements.push(
    `ALTER TABLE ${r.child}\n  ADD CONSTRAINT ${r.name}\n  FOREIGN KEY (org_id, ${r.col})\n  REFERENCES ${r.parent} (org_id, ${r.parentCol})${onDelete(r.action, r.col)}\n  NOT VALID;`);
  addStatements.push(`ALTER TABLE ${r.child} VALIDATE CONSTRAINT ${r.name};`);
}

const dropStatements = [];
for (const r of relations) {
  for (const s of r.singles) dropStatements.push(`ALTER TABLE ${r.child} DROP CONSTRAINT "${s}";`);
  for (const e of r.dropExtras) dropStatements.push(`ALTER TABLE ${r.child} DROP CONSTRAINT "${e}";`);
}

const prereq = [
  { table: "public.coupons", col: "id", name: "coupons_org_id_id_uniq" },
  { table: "public.principal_groups", col: "id", name: "principal_groups_org_id_id_uniq" },
  { table: "public.operator_access_grants", col: "grant_id", name: "operator_access_grants_org_id_grant_id_uniq" },
];

function writeMigration(num, slug, header, statements) {
  const tag = `${String(num).padStart(4, "0")}_${slug}`;
  const body = [`-- ${header}`, "", "SET lock_timeout = '5s';", ...statements.flatMap((s) => ["--> statement-breakpoint", s])].join("\n");
  fs.writeFileSync(path.join(MIG, `${tag}.sql`), body + "\n");
  return { tag, count: statements.length };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const written = [];
let num = START_NUM;

written.push(writeMigration(num++, "ar02_tenant_fk_unique_prereqs",
  "AR-02: parent (org_id, key) uniqueness required by the canonical composite tenant foreign keys.",
  prereq.map((p) => `ALTER TABLE ${p.table}\n  ADD CONSTRAINT ${p.name}\n  UNIQUE (org_id, ${p.col});`)));

const addChunks = chunk(addStatements, 105);
addChunks.forEach((c, i) => {
  written.push(writeMigration(num++, `ar02_canonical_tenant_fks_${i + 1}`,
    `AR-02: canonical (org_id, child_id) -> (org_id, id) tenant foreign keys, part ${i + 1} of ${addChunks.length}. Referential action preserved from the single-column constraint it replaces.`, c));
});

const dropChunks = chunk(dropStatements, 110);
dropChunks.forEach((c, i) => {
  written.push(writeMigration(num++, `ar02_drop_superseded_tenant_fks_${i + 1}`,
    `AR-02: drop single-column and duplicate composite tenant foreign keys superseded by the canonical composites, part ${i + 1} of ${dropChunks.length}.`, c));
});

console.log("relations:", relations.length);
console.log("add statements:", addStatements.length, "drop statements:", dropStatements.length);
for (const w of written) console.log(" ", w.tag, w.count);
fs.writeFileSync("C:/Users/Aditya_Lappy/AppData/Local/Temp/ar02-written.json", JSON.stringify(written, null, 1));
