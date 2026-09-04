/**
 * compare-catalog-parity.mjs
 *
 * Diffs two Postgres databases across ALL of:
 *   - tables (schema, name, RLS enabled/forced)
 *   - columns (name, ordinal position, type, nullability, default expression)
 *   - constraints (PK/FK/unique/check — column list, referential actions, expression)
 *   - indexes (definition text, from pg_indexes)
 *   - policies (name, table, command, permissive/restrictive, roles, qual, with-check)
 *   - functions (schema, name, argument types, return type, language, body)
 *   - triggers (table, name, event, timing, function, orientation, condition)
 *   - extensions (name, schema, version)
 *   - enums (schema, type name, labels in order)
 *
 * Comparison is by FULL DEFINITION — an object that exists in both but with a
 * different definition is flagged as a difference, not silently accepted.
 *
 * Usage:
 *   node src/scripts/compare-catalog-parity.mjs \
 *     --url-a=<postgres url> \
 *     --url-b=<postgres url> \
 *     [--label-a=A] [--label-b=B] [--json=<path>]
 *
 * Exit codes:
 *   0  catalogs are identical
 *   1  catalogs differ (differences printed to stdout)
 *   2  argument error or connection failure
 */
import { writeFileSync } from "node:fs";
import postgres from "postgres";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const urlA = arg("url-a");
const urlB = arg("url-b");
const labelA = arg("label-a", "A");
const labelB = arg("label-b", "B");
const jsonPath = arg("json");

if (!urlA || !urlB) {
  console.error("compare-catalog-parity: --url-a and --url-b are required");
  process.exit(2);
}

function safeLabel(url) {
  try {
    const u = new URL(url);
    const database = u.pathname.replace(/^\//, "").split("?")[0] || "?";
    return `${u.hostname || "?"}:${u.port || "5432"}/${database}`;
  } catch {
    return "<unparseable url>";
  }
}

const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast", "drizzle"];
const SYSTEM_SCHEMA_LIST = SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(", ");

async function fetchCatalog(url, label) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // Tables with RLS state
    const tables = await sql.unsafe(`
      SELECT
        n.nspname AS schema,
        c.relname AS name,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname NOT IN (${SYSTEM_SCHEMA_LIST})
      ORDER BY n.nspname, c.relname
    `);

    // Columns with full type info
    const columns = await sql.unsafe(`
      SELECT
        n.nspname AS schema,
        c.relname AS table,
        a.attname AS column,
        a.attnum AS ordinal,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
        a.attnotnull AS not_null,
        pg_get_expr(d.adbin, d.adrelid) AS column_default
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE c.relkind = 'r'
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND n.nspname NOT IN (${SYSTEM_SCHEMA_LIST})
      ORDER BY n.nspname, c.relname, a.attnum
    `);

    // Constraints (PK, FK, unique, check)
    const constraints = await sql.unsafe(`
      SELECT
        n.nspname AS schema,
        c.relname AS table,
        con.conname AS constraint_name,
        con.contype AS con_type,
        pg_get_constraintdef(con.oid, true) AS definition,
        fn.nspname AS foreign_schema,
        fc.relname AS foreign_table,
        con.confupdtype AS update_action,
        con.confdeltype AS delete_action,
        array_to_string(
          ARRAY(
            SELECT a.attname
            FROM pg_attribute a
            WHERE a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
            ORDER BY array_position(con.conkey, a.attnum)
          ), ','
        ) AS column_list
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_class fc ON fc.oid = con.confrelid
      LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      WHERE n.nspname NOT IN (${SYSTEM_SCHEMA_LIST})
      ORDER BY n.nspname, c.relname, con.conname
    `);

    // Indexes (definition from pg_indexes which includes the full CREATE INDEX statement)
    const indexes = await sql.unsafe(`
      SELECT
        schemaname AS schema,
        tablename AS table,
        indexname AS name,
        indexdef AS definition
      FROM pg_indexes
      WHERE schemaname NOT IN (${SYSTEM_SCHEMA_LIST})
      ORDER BY schemaname, tablename, indexname
    `);

    // RLS Policies
    const policies = await sql.unsafe(`
      SELECT
        n.nspname AS schema,
        c.relname AS table,
        p.polname AS policy_name,
        p.polcmd AS command,
        p.polpermissive AS permissive,
        array_to_string(p.polroles::text[], ',') AS roles,
        pg_get_expr(p.polqual, p.polrelid) AS qual,
        pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN (${SYSTEM_SCHEMA_LIST})
      ORDER BY n.nspname, c.relname, p.polname
    `);

    // Functions (user-defined, not pg catalog)
    const functions = await sql.unsafe(`
      SELECT
        n.nspname AS schema,
        p.proname AS name,
        pg_get_function_identity_arguments(p.oid) AS argument_types,
        pg_catalog.format_type(p.prorettype, NULL) AS return_type,
        l.lanname AS language,
        p.prosrc AS body,
        p.provolatile AS volatility,
        p.prosecdef AS security_definer
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname NOT IN (${SYSTEM_SCHEMA_LIST})
        AND p.prokind IN ('f', 'p')
      ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
    `);

    // Triggers
    const triggers = await sql.unsafe(`
      SELECT
        n.nspname AS schema,
        c.relname AS table,
        t.tgname AS trigger_name,
        t.tgtype AS trigger_type,
        p.proname AS function_name,
        pg_get_triggerdef(t.oid, true) AS definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal
        AND n.nspname NOT IN (${SYSTEM_SCHEMA_LIST})
      ORDER BY n.nspname, c.relname, t.tgname
    `);

    // Extensions
    const extensions = await sql.unsafe(`
      SELECT
        e.extname AS name,
        n.nspname AS schema,
        e.extversion AS version
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      ORDER BY e.extname
    `);

    // Enums and their labels (order is meaningful)
    const enums = await sql.unsafe(`
      SELECT
        n.nspname AS schema,
        t.typname AS type_name,
        array_to_string(
          ARRAY(
            SELECT e.enumlabel
            FROM pg_enum e
            WHERE e.enumtypid = t.oid
            ORDER BY e.enumsortorder
          ), ','
        ) AS labels
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typtype = 'e'
        AND n.nspname NOT IN (${SYSTEM_SCHEMA_LIST})
      ORDER BY n.nspname, t.typname
    `);

    return { label, tables, columns, constraints, indexes, policies, functions, triggers, extensions, enums };
  } finally {
    await sql.end();
  }
}

function key(row, fields) {
  return fields.map((f) => String(row[f] ?? "")).join("|");
}

function diffSection(name, aRows, bRows, keyFields, valueFields) {
  const aMap = new Map(aRows.map((r) => [key(r, keyFields), r]));
  const bMap = new Map(bRows.map((r) => [key(r, keyFields), r]));

  const onlyInA = [];
  const onlyInB = [];
  const different = [];

  for (const [k, aRow] of aMap) {
    if (!bMap.has(k)) {
      onlyInA.push(aRow);
    } else {
      const bRow = bMap.get(k);
      const diffs = valueFields.filter((f) => String(aRow[f] ?? "") !== String(bRow[f] ?? ""));
      if (diffs.length > 0) {
        different.push({ key: k, aRow, bRow, diffs });
      }
    }
  }
  for (const [k, bRow] of bMap) {
    if (!aMap.has(k)) onlyInB.push(bRow);
  }

  return { name, onlyInA, onlyInB, different, totalA: aRows.length, totalB: bRows.length };
}

function printDiff(diff, labelA, labelB) {
  const hasAny = diff.onlyInA.length > 0 || diff.onlyInB.length > 0 || diff.different.length > 0;
  if (!hasAny) {
    console.log(`  ${diff.name}: ${diff.totalA} rows — MATCH`);
    return false;
  }
  console.log(`  ${diff.name}: ${diff.totalA}/${diff.totalB} — DIFFERS`);
  for (const r of diff.onlyInA)
    console.log(`    only in ${labelA}: ${JSON.stringify(r)}`);
  for (const r of diff.onlyInB)
    console.log(`    only in ${labelB}: ${JSON.stringify(r)}`);
  for (const d of diff.different)
    console.log(`    definition differs [${d.key}]: fields=${d.diffs.join(",")}  A=${JSON.stringify(d.diffs.map(f=>d.aRow[f]))}  B=${JSON.stringify(d.diffs.map(f=>d.bRow[f]))}`);
  return true;
}

async function main() {
  console.log(`Fetching catalog for ${labelA} (${safeLabel(urlA)})...`);
  let catA;
  try {
    catA = await fetchCatalog(urlA, labelA);
  } catch (err) {
    console.error(`Failed to connect to ${labelA}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  console.log(`Fetching catalog for ${labelB} (${safeLabel(urlB)})...`);
  let catB;
  try {
    catB = await fetchCatalog(urlB, labelB);
  } catch (err) {
    console.error(`Failed to connect to ${labelB}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  console.log(`\n=== Catalog parity: ${labelA} vs ${labelB} ===\n`);

  const diffs = [
    diffSection("tables", catA.tables, catB.tables,
      ["schema", "name"],
      ["rls_enabled", "rls_forced"]),
    diffSection("columns", catA.columns, catB.columns,
      ["schema", "table", "column"],
      ["ordinal", "data_type", "not_null", "column_default"]),
    diffSection("constraints", catA.constraints, catB.constraints,
      ["schema", "table", "constraint_name"],
      ["con_type", "definition", "update_action", "delete_action", "column_list"]),
    diffSection("indexes", catA.indexes, catB.indexes,
      ["schema", "table", "name"],
      ["definition"]),
    diffSection("policies", catA.policies, catB.policies,
      ["schema", "table", "policy_name"],
      ["command", "permissive", "roles", "qual", "with_check"]),
    diffSection("functions", catA.functions, catB.functions,
      ["schema", "name", "argument_types"],
      ["return_type", "language", "body", "volatility", "security_definer"]),
    diffSection("triggers", catA.triggers, catB.triggers,
      ["schema", "table", "trigger_name"],
      ["definition"]),
    diffSection("extensions", catA.extensions, catB.extensions,
      ["name"],
      ["schema", "version"]),
    diffSection("enums", catA.enums, catB.enums,
      ["schema", "type_name"],
      ["labels"]),
  ];

  let totalDiffs = 0;
  for (const d of diffs) {
    const hasDiff = printDiff(d, labelA, labelB);
    if (hasDiff) totalDiffs++;
  }

  const summary = {
    labelA, labelB,
    targetA: safeLabel(urlA),
    targetB: safeLabel(urlB),
    sections: diffs.map((d) => ({
      name: d.name,
      countA: d.totalA,
      countB: d.totalB,
      onlyInA: d.onlyInA.length,
      onlyInB: d.onlyInB.length,
      different: d.different.length,
      match: d.onlyInA.length === 0 && d.onlyInB.length === 0 && d.different.length === 0,
    })),
    totalDiffSections: totalDiffs,
  };

  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
    console.log(`\njson written ${jsonPath}`);
  }

  if (totalDiffs === 0) {
    console.log(`\nRESULT: CATALOGS MATCH — ${diffs.length} sections, 0 differences`);
    process.exit(0);
  } else {
    console.log(`\nRESULT: CATALOGS DIFFER — ${totalDiffs} of ${diffs.length} sections have differences`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(2);
});
