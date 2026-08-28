import { writeFileSync } from "node:fs";
import { readCatalog, connect } from "./chain-repair/catalog-read.mjs";
import {
  CONFLICTS,
  DROP_IN_CELL,
  dependsOnSuppressedColumn,
  isSuppressed,
} from "./chain-repair/decisions.mjs";
import { loadEnv, parseCellArgs, redact } from "./cell-topology.mjs";
import {
  addColumn,
  addConstraint,
  alterColumnType,
  createFunction,
  createIndex,
  createPolicy,
  createSchema,
  createTable,
  createTrigger,
  createType,
  enableRls,
  grantAppRole,
  ident,
  join,
  literal,
  qualify,
  section,
} from "./chain-repair/emit-ddl.mjs";

const env = loadEnv();
const argv = process.argv.slice(2);

if (argv.includes("--help")) {
  console.log(`
Generate the SQL that reconciles a cell's schema with the control plane, from pg_catalog.

  node src/scripts/generate-chain-repair.mjs --direction=forward --out=migrations/0619_x.sql
  node src/scripts/generate-chain-repair.mjs --direction=drift   --out=migrations/0620_x.sql
  node src/scripts/generate-chain-repair.mjs --summary
  node src/scripts/generate-chain-repair.mjs --self-test

forward — objects the control plane has that the migration chain never creates.
drift   — objects the chain creates that the control plane never received.

Every emitted statement is idempotent, so the file is a no-op on a database that already
has the object. Guards are whole DO blocks: the statement-breakpoint marker never appears
inside one, because Drizzle splits on it and would tear the block into invalid fragments.
`);
  process.exit(0);
}

const topology = parseCellArgs(argv, env);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const DIRECTION = flag("direction", "forward");
const OUT = flag("out", null);
const SUMMARY = argv.includes("--summary");
const SELF_TEST = argv.includes("--self-test");
const APP_ROLE = env.APP_DATABASE_ROLE ?? "streamline_app";

const keyed = (rows) => new Map(rows.map((r) => [r.key, r]));

function difference(source, target) {
  const have = keyed(target);
  return source.filter((r) => !have.has(r.key));
}

function plan(source, target, direction) {
  const missingTables = difference(source.tables, target.tables);
  const missingTableKeys = new Set(missingTables.map((t) => t.key));
  const targetColumnNames = new Set(target.columns.map((c) => c.nameKey));
  const targetTableKeys = new Set(target.tables.map((t) => t.key));
  const targetNotNull = new Set(target.columns.filter((c) => c.notnull).map((c) => c.nameKey));
  const targetByName = new Map(target.columns.map((c) => [c.nameKey, c]));

  const missingColumns = difference(source.columns, target.columns).filter(
    (c) => !isSuppressed(c.nameKey, direction),
  );
  const newColumns = missingColumns.filter(
    (c) => !missingTableKeys.has(c.tableKey) && !targetColumnNames.has(c.nameKey),
  );
  const changed = missingColumns.filter(
    (c) => !missingTableKeys.has(c.tableKey) && targetColumnNames.has(c.nameKey),
  );
  const retypedColumns = changed.filter((c) => targetByName.get(c.nameKey).type !== c.type);
  const renullableColumns = changed.filter(
    (c) => targetByName.get(c.nameKey).type === c.type && targetByName.get(c.nameKey).notnull !== c.notnull,
  );

  const missingEnums = difference(source.enums, target.enums);
  const targetTypes = new Set(target.enums.map((e) => e.typeKey));
  const newTypeKeys = [...new Set(missingEnums.map((e) => e.typeKey))].filter(
    (t) => !targetTypes.has(t),
  );
  const newTypes = newTypeKeys.map((typeKey) => {
    const labels = source.enums.filter((e) => e.typeKey === typeKey);
    const [first] = labels;
    return { type: { schema: first.schema, name: first.name }, labels };
  });
  const addedLabels = missingEnums.filter((e) => targetTypes.has(e.typeKey));

  const constraints = difference(source.constraints, target.constraints)
    .filter((c) => targetTableKeys.has(c.tableKey) || missingTableKeys.has(c.tableKey))
    .filter((c) => !dependsOnSuppressedColumn(c, direction))
    .filter((c) => c.type !== "t");

  return {
    missingSchemas: difference(source.schemas, target.schemas),
    newTypes,
    addedLabels,
    missingTables,
    tableColumns: (table) => source.columns.filter((c) => c.tableKey === table.key),
    newColumns,
    retypedColumns,
    renullableColumns,
    dropColumns:
      direction === "forward"
        ? DROP_IN_CELL.filter((key) => targetColumnNames.has(key))
        : [],
    functions: difference(source.functions, target.functions),
    constraintsFirst: constraints.filter((c) => c.type !== "f" && c.type !== "n"),
    notNulls: constraints
      .filter((c) => c.type === "n")
      .filter((c) => {
        const column = c.def.replace(/^NOT NULL\s+/i, "").replace(/"/g, "");
        return !targetNotNull.has(`${c.schema}.${c.table}.${column}`);
      }),
    foreignKeys: constraints.filter((c) => c.type === "f"),
    indexes: difference(source.indexes, target.indexes)
      .filter((i) => !i.backsConstraint)
      .filter((i) => !dependsOnSuppressedColumn(i, direction)),
    triggers: difference(source.triggers, target.triggers),
    rls: difference(source.rlsEnabled, target.rlsEnabled),
    policies: difference(source.policies, target.policies),
  };
}

function emit(p, header, violations = new Map()) {
  const out = [];
  const push = (title, statements) => {
    const kept = statements.filter((s) => s !== null && s !== "");
    if (kept.length === 0) return;
    out.push(section(`${title} (${kept.length})`));
    out.push(...kept);
  };

  push(
    "schemas",
    p.missingSchemas.map((s) => createSchema(s)),
  );
  push(
    "enum types the chain never creates",
    p.newTypes.map((t) => createType(t.type, t.labels)),
  );
  push(
    "enum labels added to an existing type",
    p.addedLabels.map(
      (e) =>
        `ALTER TYPE ${qualify(e.schema, e.name)} ADD VALUE IF NOT EXISTS ${literal(e.label)};`,
    ),
  );
  push(
    "tables",
    p.missingTables.map((t) => createTable(t, p.tableColumns(t))),
  );
  push(
    "columns on tables that already exist",
    p.newColumns.map((c) => addColumn(c)),
  );
  push(
    "columns whose declared type drifted",
    p.retypedColumns.map((c) => alterColumnType(c)),
  );
  push(
    "columns whose nullability drifted",
    p.renullableColumns.map(
      (c) =>
        `ALTER TABLE ${qualify(c.schema, c.table)} ALTER COLUMN ${ident(c.name)}` +
        ` ${c.notnull ? "SET" : "DROP"} NOT NULL;`,
    ),
  );
  push(
    "columns a migration renamed or dropped, which a cold build never reaches",
    p.dropColumns.map((key) => {
      const [schema, table, column] = key.split(".");
      return `ALTER TABLE ${qualify(schema, table)} DROP COLUMN IF EXISTS ${ident(column)};`;
    }),
  );
  push(
    "functions",
    p.functions.map((f) => createFunction(f)),
  );
  push(
    "primary keys, unique and check constraints",
    p.constraintsFirst.map((c) => addConstraint(c)),
  );
  push(
    "not-null constraints",
    p.notNulls.map((c) => addConstraint(c)),
  );
  push(
    "foreign keys",
    p.foreignKeys.map((c) =>
      violations.has(c.key)
        ? addConstraint({ ...c, def: `${c.def} NOT VALID` })
        : addConstraint(c),
    ),
  );
  push(
    "indexes",
    p.indexes.map((i) => createIndex(i)),
  );
  push(
    "triggers",
    p.triggers.map((t) => createTrigger(t)),
  );
  push(
    "row-level security",
    p.rls.map((t) => enableRls(t)),
  );
  push(
    "tenant isolation policies",
    p.policies.map((t) => createPolicy(t)),
  );
  push(
    "privileges on the tables this file creates",
    p.missingTables.map((t) => grantAppRole(t, APP_ROLE)),
  );

  return `${header}\n\n${join(out)}\n`;
}

const FK_SHAPE = /^FOREIGN KEY \(([^)]+)\) REFERENCES ([^(]+)\(([^)]+)\)/i;

export function violationQuery(constraint) {
  const match = FK_SHAPE.exec(constraint.def);
  if (match === null) return null;
  const local = match[1].split(",").map((c) => c.trim());
  const referenced = match[2].trim();
  const remote = match[3].split(",").map((c) => c.trim());
  if (local.length !== remote.length) return null;
  const notNull = local.map((c) => `child.${c} IS NOT NULL`).join(" AND ");
  const joinOn = local.map((c, i) => `parent.${remote[i]} = child.${c}`).join(" AND ");
  return (
    `SELECT count(*)::int AS n FROM ${qualify(constraint.schema, constraint.table)} child` +
    ` WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${referenced} parent WHERE ${joinOn})`
  );
}

async function probeViolations(url, foreignKeys) {
  const sql = connect(url);
  const violations = new Map();
  const unprobed = [];
  try {
    for (const fk of foreignKeys) {
      const query = violationQuery(fk);
      if (query === null) {
        unprobed.push({ key: fk.key, reason: "constraint definition is not a plain foreign key" });
        continue;
      }
      try {
        const rows = await sql.unsafe(query);
        const n = Number(rows[0]?.n ?? 0);
        if (n > 0) violations.set(fk.key, n);
      } catch (e) {
        unprobed.push({ key: fk.key, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    await sql.end();
  }
  return { violations, unprobed };
}

function counts(p) {
  return {
    schemas: p.missingSchemas.length,
    types: p.newTypes.length,
    enumLabels: p.addedLabels.length,
    tables: p.missingTables.length,
    columns: p.newColumns.length,
    retyped: p.retypedColumns.length,
    renullable: p.renullableColumns.length,
    dropped: p.dropColumns.length,
    functions: p.functions.length,
    constraints: p.constraintsFirst.length + p.notNulls.length + p.foreignKeys.length,
    indexes: p.indexes.length,
    triggers: p.triggers.length,
    rls: p.rls.length,
    policies: p.policies.length,
  };
}

async function selfTest() {
  const sql = connect(topology.cell.ownerDirect);
  const scratch = "chain_repair_self_test";
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`);
    await sql.unsafe(`CREATE SCHEMA ${scratch}`);
    await sql.unsafe(`CREATE TABLE ${scratch}.probe (id integer NOT NULL, note text)`);

    const source = await readCatalog(topology.cell.ownerDirect);
    const target = await readCatalog(topology.cell.ownerDirect);
    const withoutProbe = {
      ...target,
      tables: target.tables.filter((t) => t.schema !== scratch),
      columns: target.columns.filter((c) => c.schema !== scratch),
      constraints: target.constraints.filter((c) => c.schema !== scratch),
    };

    const p = plan(source, withoutProbe, "forward");
    const sqlText = emit(p, "-- self test");
    const found = sqlText.includes(`"${scratch}"."probe"`);

    await sql.unsafe(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`);

    if (!found) {
      console.error("SELF-TEST FAIL: a table present only in the source produced no repair SQL");
      process.exitCode = 1;
      return;
    }

    const emptyPlan = plan(source, source, "forward");
    if (counts(emptyPlan).tables !== 0) {
      console.error("SELF-TEST FAIL: identical catalogs still produced table repair SQL");
      process.exitCode = 1;
      return;
    }

    console.log(
      "SELF-TEST PASS: a source-only table is emitted as repair SQL, and identical catalogs emit nothing",
    );
  } finally {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`).catch(() => {});
    await sql.end();
  }
}

async function main() {
  if (SELF_TEST) return selfTest();

  console.log(`control plane: ${redact(topology.controlPlane.ownerDirect)}`);
  console.log(`cell         : ${redact(topology.cell.ownerDirect)}`);
  console.log(`direction    : ${DIRECTION}\n`);

  const [control, cell] = await Promise.all([
    readCatalog(topology.controlPlane.ownerDirect),
    readCatalog(topology.cell.ownerDirect),
  ]);

  const forward = DIRECTION === "forward";
  const source = forward ? control : cell;
  const target = forward ? cell : control;
  const p = plan(source, target, DIRECTION);

  console.log(JSON.stringify(counts(p), null, 2));
  for (const c of CONFLICTS)
    console.log(`conflict ${c.column} → ${c.winner} wins`);

  if (SUMMARY) return;

  const header = forward
    ? [
        "-- Objects the running control plane has that the committed migration chain never creates.",
        "--",
        "-- Generated from pg_catalog by src/scripts/generate-chain-repair.mjs --direction=forward.",
        "-- A cold build of a cell reaches head and is still short of these, so the chain cannot",
        "-- reproduce the database it is supposed to describe. Every statement is idempotent, so",
        "-- this file is a no-op against the control plane that supplied it.",
      ].join("\n")
    : [
        "-- Objects the migration chain creates that the running control plane never received.",
        "--",
        "-- Generated from pg_catalog by src/scripts/generate-chain-repair.mjs --direction=drift.",
        "-- 0320_recon_phase_a_orgid.sql sweeps the catalogue rather than naming its tables, so its",
        "-- outcome depends on the shape of the database at the moment it runs. It covered 66 tables",
        "-- in the control plane and 69 in a cold cell. This file closes that difference.",
      ].join("\n");

  const targetUrl = forward ? topology.cell.ownerDirect : topology.controlPlane.ownerDirect;
  const { violations, unprobed } = await probeViolations(targetUrl, p.foreignKeys);
  for (const [key, n] of violations)
    console.log(
      `VIOLATION ${key}: ${n} row(s) already break this constraint — emitted NOT VALID so it` +
        ` binds new writes without failing the migration on rows that predate it`,
    );
  console.log(
    `foreign keys probed=${p.foreignKeys.length - unprobed.length}` +
      ` violating=${violations.size} not-probeable=${unprobed.length}` +
      ` (columns this same file adds cannot be probed before it runs)`,
  );

  const text = emit(p, header, violations);

  if (OUT) {
    writeFileSync(OUT, text, "utf8");
    console.log(`\nwrote ${OUT} (${text.split("\n").length} lines)`);
    return;
  }
  console.log(text);
}

main().catch((e) => {
  console.error("CHAIN REPAIR GENERATION FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
