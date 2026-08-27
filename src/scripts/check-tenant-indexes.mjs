/**
 * Every tenant table must declare an index LEADING with its tenant column.
 *
 * Under RLS the policy's `org_id = app.current_org_id()` is not leakproof, so an
 * index that does not supply org_id is refused outright and the read becomes a
 * sequential scan -- an isolation cost, not a tuning preference. Reads the
 * Drizzle schema, so it needs no database and can gate every commit.
 *
 * Usage:  node src/scripts/check-tenant-indexes.mjs [--self-test]
 * Exit:   0 clean · 1 a table has none · 2 the parser found implausibly few
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

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

// Parse every pgTable declaration in one schema source file
export function parseTables(src, filePath) {
  const tables = [];
  const decl = /export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*pgTable\(/g;

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
    findsAllSevenTenantTables: parsed.length === 7,
    ignoresNonTenantTable: !byName.has("global_catalog"),
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
