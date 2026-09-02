/**
 * Every tenant table must declare an index LEADING with its tenant column.
 *
 * Under RLS the policy's `org_id = app.current_org_id()` is not leakproof, so an
 * index that does not supply org_id is refused outright and the read becomes a
 * sequential scan -- an isolation cost, not a tuning preference. Reads the
 * Drizzle schema, so it needs no database and can gate every commit.
 *
 * The default mode reads the Drizzle declarations, which is what a commit can gate on. It is not
 * the whole truth: 554 tenant-anchor `unique(org_id, id)` constraints exist only in migrations, so
 * a table can be red here and indexed in the catalog. `--db` asks a bootstrapped database instead,
 * via TENANT_RELATIONSHIP_DB_URL / DIRECT_DATABASE_URL / DATABASE_URL, and that answer is the one
 * that describes what the planner will actually do under RLS.
 *
 * Usage:  node src/scripts/check-tenant-indexes.mjs [--self-test|--db]
 * Exit:   0 clean · 1 a table has none · 2 the parser found implausibly few / no reachable target
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const DB_MODE = args.includes("--db");

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const SCHEMA_DIR = join(BACKEND_ROOT, "src", "db", "schema");

const TENANT_COLUMNS = ["org_id", "organization_id"];

// Tables that carry a tenant column but are not tenant-partitioned data, each with the reason
export const NOT_TENANT_PARTITIONED = new Map([
  [
    "organizations",
    "the tenant row itself — its id IS the tenant, so there is no foreign org_id to lead with",
  ],
]);

// -- parsing -----------------------------------------------------------------

// Extract the full `pgTable(...)` call text starting at `from`, by balancing brackets
function callBody(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return null;
}

// The text of one object property, from `from` to the comma that ends it, ignoring commas nested inside the builder chain's own calls
function propertyDefinition(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return src.slice(from, i);
      depth--;
    } else if (ch === "," && depth === 0) return src.slice(from, i);
  }
  return src.slice(from);
}

// Parse every table declaration in one schema source file. The Build module declares its 83
// tables as `build.table(...)` / `buildEvents.table(...)` through pgSchema(), so a `pgTable(`-only
// pattern reported a clean schema while never seeing a whole Postgres schema. The sibling gates
// check-tenant-relationships and check-drop-column-safety already use this two-form pattern.
export function parseTables(src, filePath) {
  const tables = [];
  const decl = /export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:pgTable|[A-Za-z_$][A-Za-z0-9_$]*\.table)\(/g;

  for (const match of src.matchAll(decl)) {
    const open = match.index + match[0].length - 1;
    const body = callBody(src, open);
    if (body === null) continue;

    const name = body.match(/^\(\s*["']([^"']+)["']/s);
    if (!name) continue;

    // The JS property whose column name is a tenant column
    let tenantProp = null;
    let tenantDefinition = "";
    for (const column of TENANT_COLUMNS) {
      const prop = body.match(
        new RegExp(`([A-Za-z_$][A-Za-z0-9_$]*)\\s*:\\s*\\w+\\(\\s*["']${column}["']`),
      );
      if (prop) {
        tenantProp = prop[1];
        tenantDefinition = propertyDefinition(body, prop.index);
        break;
      }
    }
    if (tenantProp === null) continue;

    // Every declared index/constraint's FIRST column
    const leading = new Set();

    // A column-level `.primaryKey()` or `.unique()` on the tenant column keys the table on the tenant, which Postgres backs with an index leading on it
    if (/\.(primaryKey|unique)\(/.test(tenantDefinition)) leading.add(tenantProp);

    for (const on of body.matchAll(/\.on\(\s*(?:\w+\.)?([A-Za-z_$][A-Za-z0-9_$]*)/g))
      leading.add(on[1]);
    for (const pk of body.matchAll(
      /primaryKey\(\s*\{[^}]*columns:\s*\[\s*(?:\w+\.)?([A-Za-z_$][A-Za-z0-9_$]*)/g,
    ))
      leading.add(pk[1]);

    tables.push({
      symbol: match[1],
      table: name[1],
      tenantProp,
      leadingColumns: leading,
      file: filePath,
    });
  }

  return tables;
}

// -- self-test ---------------------------------------------------------------

if (args.includes("--self-test")) {
  const fixture = [
    `export const goodOneLine = pgTable("good_one_line", {`,
    `  id: uuid("id").primaryKey(),`,
    `  orgId: text("org_id").references(() => organizations.id).notNull(),`,
    `  status: text("status"),`,
    `}, (table) => [`,
    `  index("idx_good_org_status").on(table.orgId, table.status),`,
    `]);`,
    ``,
    // 324 of 788 real declarations look like this: the name is NOT on the declaration line
    `export const goodMultiLine = pgTable(`,
    `  "good_multi_line",`,
    `  {`,
    `    id: uuid("id").primaryKey(),`,
    `    organizationId: text("organization_id").notNull(),`,
    `    createdAt: timestamp("created_at"),`,
    `  },`,
    `  (table) => [`,
    `    uniqueIndex("uniq_good_multi").on(table.organizationId, table.id),`,
    `  ],`,
    `);`,
    ``,
    `export const compositePk = pgTable("composite_pk", {`,
    `  orgId: text("org_id").notNull(),`,
    `  memberId: text("member_id").notNull(),`,
    `}, (table) => [`,
    `  primaryKey({ columns: [table.orgId, table.memberId] }),`,
    `]);`,
    ``,
    // The defect
    `export const trailingTenant = pgTable("trailing_tenant", {`,
    `  id: uuid("id").primaryKey(),`,
    `  orgId: text("org_id").notNull(),`,
    `  userId: text("user_id"),`,
    `}, (table) => [`,
    `  index("idx_trailing_user_org").on(table.userId, table.orgId),`,
    `]);`,
    ``,
    `export const noIndexAtAll = pgTable("no_index_at_all", {`,
    `  id: uuid("id").primaryKey(),`,
    `  orgId: text("org_id").notNull(),`,
    `});`,
    ``,
    // access_versions and autonomy_settings: the tenant column IS the primary key, across a multi-line builder chain
    `export const tenantIsThePk = pgTable("tenant_is_the_pk", {`,
    `  orgId: text("org_id")`,
    `    .primaryKey()`,
    `    .references(() => organizations.id, { onDelete: "cascade" }),`,
    `  version: integer("version").default(1).notNull(),`,
    `});`,
    ``,
    // timesheet_settings
    `export const tenantIsUnique = pgTable("tenant_is_unique", {`,
    `  id: serial("id").primaryKey(),`,
    `  orgId: text("org_id")`,
    `    .notNull()`,
    `    .unique()`,
    `    .references(() => organizations.id, { onDelete: "cascade" }),`,
    `  workWeekStart: integer("work_week_start").notNull().default(1),`,
    `});`,
    ``,
    // The Build module's form: pgSchema("build") then build.table(...). 83 real tables look
    // like this and a pgTable-only pattern reported the whole schema as clean.
    `export const buildScopedGood = build.table("build_scoped_good", {`,
    `  id: uuid("id").primaryKey(),`,
    `  orgId: text("org_id").notNull(),`,
    `  status: text("status"),`,
    `}, (table) => [`,
    `  index("idx_build_scoped_good_org_status").on(table.orgId, table.status),`,
    `]);`,
    ``,
    `export const buildScopedBad = buildEvents.table("build_scoped_bad", {`,
    `  id: uuid("id").primaryKey(),`,
    `  orgId: text("org_id").notNull(),`,
    `  ticketId: integer("ticket_id"),`,
    `}, (table) => [`,
    `  index("idx_build_scoped_bad_ticket").on(table.ticketId),`,
    `]);`,
    ``,
    // Not a tenant table
    `export const globalCatalog = pgTable("global_catalog", {`,
    `  id: uuid("id").primaryKey(),`,
    `  code: text("code").notNull(),`,
    `});`,
  ].join("\n");

  const parsed = parseTables(fixture, "fixture.ts");
  const byName = new Map(parsed.map((t) => [t.table, t]));
  const leads = (name) => {
    const t = byName.get(name);
    return t ? t.leadingColumns.has(t.tenantProp) : null;
  };

  const checks = {
    findsAllNineTenantTables: parsed.length === 9,
    ignoresNonTenantTable: !byName.has("global_catalog"),
    readsPgSchemaTableForm: byName.has("build_scoped_good"),
    pgSchemaLeadingIndexPasses: leads("build_scoped_good") === true,
    pgSchemaTrailingTenantFails: leads("build_scoped_bad") === false,
    columnLevelPrimaryKeyCounts: leads("tenant_is_the_pk") === true,
    columnLevelUniqueCounts: leads("tenant_is_unique") === true,
    // The id column's own .primaryKey() must not be mistaken for the tenant's
    rowIdPrimaryKeyIsNotATenantIndex: leads("no_index_at_all") === false,
    readsNameFromOneLineForm: byName.has("good_one_line"),
    readsNameFromMultiLineForm: byName.has("good_multi_line"),
    detectsOrgIdProp: byName.get("good_one_line")?.tenantProp === "orgId",
    detectsOrganizationIdProp: byName.get("good_multi_line")?.tenantProp === "organizationId",
    leadingIndexPasses: leads("good_one_line") === true,
    leadingUniqueIndexPasses: leads("good_multi_line") === true,
    compositePrimaryKeyCounts: leads("composite_pk") === true,
    trailingTenantColumnFails: leads("trailing_tenant") === false,
    noIndexFails: leads("no_index_at_all") === false,
    exceptionRegistryIsExplicit: NOT_TENANT_PARTITIONED.has("organizations"),
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

// -- pg_catalog mode ---------------------------------------------------------

const MIN_CATALOG_TENANT_TABLES = 400;

async function runCatalogMode() {
  const { default: postgres } = await import("postgres");
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ path: resolve(BACKEND_ROOT, ".env") });
  } catch {
    /* .env is optional when the URL is already in the environment */
  }

  const rawUrl =
    process.env.TENANT_RELATIONSHIP_DB_URL ||
    process.env.DIRECT_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!rawUrl) {
    process.stderr.write("--db needs TENANT_RELATIONSHIP_DB_URL, DIRECT_DATABASE_URL or DATABASE_URL.\n");
    process.exit(2);
  }
  const cleanUrl = rawUrl.replace(/'/g, "");
  if (/\/neondb(\?|$)/.test(cleanUrl) || /\/cell2(\?|$)/.test(cleanUrl)) {
    process.stderr.write("Refusing to read neondb or cell2 — point at a scratch target.\n");
    process.exit(2);
  }

  const sql = postgres(cleanUrl, { prepare: false, max: 1, onnotice: () => {}, connect_timeout: 10, idle_timeout: 15 });
  try {
    const [{ target }] = await sql`SELECT current_database() AS target`;
    const rows = await sql`
      WITH org_tables AS (
        SELECT c.oid AS reloid, n.nspname, c.relname,
               (SELECT a.attnum FROM pg_attribute a
                 WHERE a.attrelid = c.oid AND NOT a.attisdropped
                   AND a.attname = ANY(${TENANT_COLUMNS})
                 ORDER BY (a.attname = 'org_id') DESC LIMIT 1) AS org_attnum
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
              AND a.attname = ANY(${TENANT_COLUMNS})
          )
      )
      SELECT t.nspname, t.relname,
             EXISTS (
               SELECT 1 FROM pg_index i
               WHERE i.indrelid = t.reloid AND i.indisvalid
                 AND (i.indkey::int2[])[0] = t.org_attnum
             ) AS has_leading,
             (SELECT count(*)::int FROM pg_index i2 WHERE i2.indrelid = t.reloid) AS index_count
      FROM org_tables t
      ORDER BY t.nspname, t.relname`;

    if (rows.length < MIN_CATALOG_TENANT_TABLES) {
      process.stderr.write(
        `Vacuity guard — ${target} has only ${rows.length} tenant table(s) (expected >= ${MIN_CATALOG_TENANT_TABLES}). ` +
          `An unbootstrapped database has no index coverage to be missing.\n`,
      );
      process.exit(2);
    }

    const missing = rows.filter((r) => !r.has_leading && !NOT_TENANT_PARTITIONED.has(r.relname));
    const excused = rows.filter((r) => !r.has_leading && NOT_TENANT_PARTITIONED.has(r.relname));

    console.log(`Mode                    pg_catalog (${target})`);
    console.log(`Tenant tables           ${rows.length}`);
    console.log(`Leading tenant index    ${rows.length - missing.length - excused.length}`);
    console.log("");
    for (const r of excused)
      console.log(`  SKIP  ${r.nspname}.${r.relname}  — ${NOT_TENANT_PARTITIONED.get(r.relname)}`);

    if (missing.length === 0) {
      console.log("OK — every tenant table in the catalog has an index leading with its tenant column.");
      return 0;
    }
    console.error("NO LEADING TENANT INDEX — the RLS qual falls back to a sequential scan:");
    for (const r of missing)
      console.error(`  FAIL  ${r.nspname}.${r.relname}  — ${r.index_count} index(es), none leading with the tenant column`);
    console.error("");
    console.error(`FAIL — ${missing.length} of ${rows.length} tenant tables have no leading tenant index.`);
    return 1;
  } finally {
    await sql.end();
  }
}

if (DB_MODE) {
  process.exit(await runCatalogMode());
}

// -- run ---------------------------------------------------------------------

if (!existsSync(SCHEMA_DIR)) {
  process.stderr.write(`Cannot read schema dir: ${SCHEMA_DIR}\n`);
  process.exit(2);
}

function walkTs(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkTs(full));
    else if (entry.name.endsWith(".ts") && !/\.spec\.ts$/.test(entry.name)) results.push(full);
  }
  return results;
}

const files = walkTs(SCHEMA_DIR);
const tenantTables = files.flatMap((file) => parseTables(readFileSync(file, "utf8"), file));

// A parser that matched nothing would otherwise report a clean schema
if (tenantTables.length < 100) {
  process.stderr.write(
    `Parser found only ${tenantTables.length} tenant tables across ${files.length} schema files. ` +
      `That is a broken parser, not a clean schema.\n`,
  );
  process.exit(2);
}

const missing = [];
const excused = [];
for (const t of tenantTables) {
  if (t.leadingColumns.has(t.tenantProp)) continue;
  if (NOT_TENANT_PARTITIONED.has(t.table)) excused.push(t);
  else missing.push(t);
}

console.log(`Schema files            ${files.length}`);
console.log(`Tenant tables           ${tenantTables.length}`);
console.log(`Leading tenant index    ${tenantTables.length - missing.length - excused.length}`);
console.log("");

if (excused.length > 0) {
  console.log("NOT TENANT-PARTITIONED — named, not hidden in an allowlist:");
  for (const t of excused.sort((a, b) => a.table.localeCompare(b.table)))
    console.log(`  SKIP  ${t.table}  — ${NOT_TENANT_PARTITIONED.get(t.table)}`);
  console.log("");
}

if (missing.length === 0) {
  console.log("OK — every tenant table declares an index leading with its tenant column.");
  process.exit(0);
}

console.error("NO LEADING TENANT INDEX — the RLS qual cannot be answered from an index:");
for (const t of missing.sort((a, b) => a.table.localeCompare(b.table))) {
  const declared = t.leadingColumns.size
    ? `leads with ${[...t.leadingColumns].sort().join(", ")}`
    : "declares no index at all";
  console.error(`  FAIL  ${t.table}  (${relative(BACKEND_ROOT, t.file)})  — ${declared}`);
}
console.error("");
console.error(`FAIL — ${missing.length} of ${tenantTables.length} tenant tables have no leading tenant index.`);
process.exit(1);
