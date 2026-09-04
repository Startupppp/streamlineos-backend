/**
 * _analyze_redundant_fks.mjs
 *
 * Queries scratch_boot_a for all 152 redundant FK pairs (child/parent combos
 * with BOTH a composite org-scoped FK AND a redundant single-column FK).
 *
 * For each pair reports:
 *   - child_table, parent_table
 *   - composite FK name and referential action
 *   - single-col FK name, child column, referential action, is the child col nullable?
 *
 * Usage:
 *   DATABASE_URL=<owner-url> node src/scripts/_analyze_redundant_fks.mjs [--json=<path>]
 */
import { writeFileSync } from "node:fs";
import postgres from "postgres";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const jsonPath = arg("json");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set");
  process.exit(2);
}

const sql = postgres(url, { ssl: "require", prepare: false });

const rows = await sql`
WITH composite_fks AS (
  SELECT
    con.conname                                              AS fk_name,
    src.relname                                              AS child_table,
    tgt.relname                                              AS parent_table,
    con.confdeltype                                          AS del_action,
    con.confdelsetcols                                       AS set_cols,
    con.convalidated                                         AS validated,
    array_agg(a.attname ORDER BY u.pos) FILTER (WHERE a.atttypid IS NOT NULL) AS child_cols
  FROM pg_constraint con
  JOIN pg_class    src ON src.oid = con.conrelid
  JOIN pg_class    tgt ON tgt.oid = con.confrelid
  JOIN pg_namespace ns ON ns.oid = src.relnamespace
  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(attnum, pos) ON TRUE
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.attnum
  WHERE con.contype = 'f'
    AND ns.nspname = 'public'
    AND array_length(con.conkey, 1) > 1
    AND EXISTS (
      SELECT 1
        FROM unnest(con.conkey) AS ck(attnum2)
        JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = ck.attnum2
       WHERE ca.attname = 'org_id'
    )
  GROUP BY con.conname, src.relname, tgt.relname, con.confdeltype, con.confdelsetcols, con.convalidated
),
single_col_fks AS (
  SELECT
    con.conname                    AS fk_name,
    src.relname                    AS child_table,
    tgt.relname                    AS parent_table,
    a.attname                      AS child_col,
    a.attnotnull                   AS col_notnull,
    con.confdeltype                AS del_action,
    con.convalidated               AS validated
  FROM pg_constraint con
  JOIN pg_class    src ON src.oid = con.conrelid
  JOIN pg_class    tgt ON tgt.oid = con.confrelid
  JOIN pg_namespace ns ON ns.oid = src.relnamespace
  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
  WHERE con.contype = 'f'
    AND ns.nspname = 'public'
    AND array_length(con.conkey, 1) = 1
    AND a.attname <> 'org_id'
)
SELECT
  c.child_table,
  c.parent_table,
  c.fk_name       AS composite_fk_name,
  c.del_action    AS composite_del_action,
  c.set_cols      AS composite_set_cols,
  c.validated     AS composite_validated,
  c.child_cols    AS composite_child_cols,
  s.fk_name       AS single_fk_name,
  s.child_col     AS single_child_col,
  s.col_notnull   AS single_col_notnull,
  s.del_action    AS single_del_action,
  s.validated     AS single_validated
FROM composite_fks c
JOIN single_col_fks s
  ON s.child_table  = c.child_table
 AND s.parent_table = c.parent_table
 AND s.child_col    = ANY (c.child_cols)
ORDER BY c.child_table, c.parent_table, s.child_col
`;

// Map Postgres action codes to names
const actionName = {
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

const pairs = rows.map((r) => ({
  child_table: r.child_table,
  parent_table: r.parent_table,
  composite_fk_name: r.composite_fk_name,
  composite_del_action: actionName[r.composite_del_action] ?? r.composite_del_action,
  composite_set_cols: r.composite_set_cols,
  composite_validated: r.composite_validated,
  composite_child_cols: r.composite_child_cols,
  single_fk_name: r.single_fk_name,
  single_child_col: r.single_child_col,
  single_col_notnull: r.single_col_notnull,
  single_del_action: actionName[r.single_del_action] ?? r.single_del_action,
  single_validated: r.single_validated,
}));

console.log(`Total redundant pairs: ${pairs.length}`);
console.log();

// Group by module prefix (table name prefix)
const crmPrefixes = ["client_", "deal", "lead", "commission", "pipeline", "crm_", "contact_"];
const invPrefixes = ["inv_"];

function classifyTable(t) {
  if (invPrefixes.some((p) => t.startsWith(p))) return "inventory";
  if (crmPrefixes.some((p) => t.startsWith(p))) return "crm";
  return "in-scope";
}

const byScope = { "in-scope": [], crm: [], inventory: [] };
for (const p of pairs) {
  const scope = classifyTable(p.child_table);
  byScope[scope].push(p);
}

console.log(`Scope breakdown:`);
console.log(`  in-scope: ${byScope["in-scope"].length}`);
console.log(`  crm:      ${byScope.crm.length}`);
console.log(`  inventory:${byScope.inventory.length}`);
console.log();

// For in-scope, group by single_del_action
const byAction = {};
for (const p of byScope["in-scope"]) {
  const k = p.single_del_action;
  byAction[k] = byAction[k] || [];
  byAction[k].push(p);
}

console.log(`In-scope pairs by single-col referential action:`);
for (const [action, list] of Object.entries(byAction)) {
  console.log(`  ${action}: ${list.length}`);
}
console.log();

console.log(`=== ALL IN-SCOPE PAIRS ===`);
for (const p of byScope["in-scope"]) {
  console.log(`\n${p.child_table} -> ${p.parent_table}`);
  console.log(`  COMPOSITE: ${p.composite_fk_name}  (cols: ${p.composite_child_cols.join(",")})  action: ${p.composite_del_action}  validated: ${p.composite_validated}`);
  console.log(`  SINGLE:    ${p.single_fk_name}  (col: ${p.single_child_col}  notnull: ${p.single_col_notnull})  action: ${p.single_del_action}  validated: ${p.single_validated}`);
}

console.log(`\n=== CRM PAIRS (excluded - out of release scope) ===`);
for (const p of byScope.crm) {
  console.log(`\n${p.child_table} -> ${p.parent_table}`);
  console.log(`  COMPOSITE: ${p.composite_fk_name}  action: ${p.composite_del_action}`);
  console.log(`  SINGLE:    ${p.single_fk_name}  (col: ${p.single_child_col})  action: ${p.single_del_action}`);
}

console.log(`\n=== INVENTORY PAIRS (excluded - out of release scope) ===`);
for (const p of byScope.inventory) {
  console.log(`\n${p.child_table} -> ${p.parent_table}`);
  console.log(`  COMPOSITE: ${p.composite_fk_name}  action: ${p.composite_del_action}`);
  console.log(`  SINGLE:    ${p.single_fk_name}  (col: ${p.single_child_col})  action: ${p.single_del_action}`);
}

if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({ pairs, byScope, byAction }, null, 2));
  console.log(`\nJSON written to ${jsonPath}`);
}

await sql.end();
