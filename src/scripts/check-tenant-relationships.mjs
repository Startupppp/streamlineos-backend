/**
 * check-tenant-relationships.mjs  (AR-02 gate, pg_catalog-backed)
 *
 * WHAT IT CHECKS
 * Every FK where BOTH child and parent are tenant-owned (carry org_id or organization_id) must use a
 * COMPOSITE (org_id, child_id) → (org_id, id) constraint.  A single-column FK lets
 * a row in org A reference a parent in org B.
 *
 * PRIMARY MODE — pg_catalog
 *   Connects to the scratch_boot_a database (DATABASE_URL with neondb replaced by
 *   scratch_boot_a, or TENANT_RELATIONSHIP_DB_URL override).  Queries pg_constraint
 *   directly: no static parsing, no blind spots from .references() vs foreignKey({}).
 *   NEVER connects to neondb or cell2.
 *
 * FALLBACK MODE — static analysis
 *   When no DB is reachable, parses both explicit `foreignKey({columns:[...]})` blocks
 *   AND inline `.references(() => tbl.col)` calls.
 *   Fails CLOSED (exit 2) if the parser sees fewer than 50 tenant tables — a broken
 *   parser must not be mistaken for a clean schema.
 *
 * CLASSIFICATION (both modes)
 *   Every FK lands in exactly one named bucket — none are silently absent:
 *   • Actionable            — needs (org_id, child_id) → (org_id, id) composite FK
 *   • EXCL: CRM             — child or parent is a CRM table (AR-02 scope exclusion)
 *   • EXCL: Inventory       — child or parent is Inventory (AR-02 scope exclusion)
 *   • EXCL: PLATFORM   — child or parent is a registered platform-global table
 *   • EXCL: global-catalog  — parent has no org_id column in Drizzle (global/non-tenant table)
 *   • EXCL: trigger-managed — parent org_id is DB-trigger-managed; composite FK exists in catalog
 *
 * TENANT-TABLE DEFINITION (static mode)
 *   A table is "tenant-owned" when its Drizzle pgTable() body defines a column whose
 *   SQL name is "org_id" or "organization_id" — the pattern `propName: typeFn("org_id"`.
 *   This aligns with the pg_catalog mode, which queries
 *   pg_attribute.attname IN ('org_id', 'organization_id'). Matching only "org_id" hid 81 tables
 *   and 4 real single-column tenant relationships from both modes.
 *
 * TRIGGER_MANAGED_TENANT_TABLES
 *   SQL table names whose org_id is populated by a DB trigger, intentionally absent from
 *   the Drizzle model.  Composite FKs verified in pg_catalog (scratch_boot_a):
 *     fk_onboarding_tasks_template_step_id_org
 *     fk_support_message_mentions_message_id_org
 *     fk_support_ticket_attachments_message_id_org
 *   Do not extend this set without catalog confirmation from scratch_boot_a.
 *
 * EXCLUSION POLICY
 *   CRM and Inventory are excluded from AR-02 scope (PRD-IN-SCOPE.md §4) — this is
 *   explicit, named, never a silent global ignore.  A FK between non-CRM/Inv tables
 *   cannot be silently excluded: add it to GLOBAL_CATALOG_SYMBOLS with a rationale, or fix it.
 *   GLOBAL_CATALOG_SYMBOLS is reserved for symbols that cannot be resolved via the schema
 *   symbol map (e.g. external imports).  Prefer "parent not in allTenantTables" over new
 *   entries here — a new global table is handled automatically by the rule.
 *
 * Usage:  node src/scripts/check-tenant-relationships.mjs [--db-only|--static-only|--self-test]
 * Exit:   0 clean · 1 violations found · 2 parser/connection error
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const SELF_TEST = args.includes("--self-test");
const DB_ONLY = args.includes("--db-only");
const STATIC_ONLY = args.includes("--static-only");

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const SCHEMA_DIR = join(BACKEND_ROOT, "src", "db", "schema");

// ---------------------------------------------------------------------------
// Exclusion sets — all explicit, none silent
// ---------------------------------------------------------------------------

const CRM_TABLE_NAMES = new Set([
  "clients", "leads", "deals", "contacts", "quotes", "pipelines", "pipeline_stages",
  "activities", "campaigns", "campaign_recipients", "quote_items", "contact_notes",
  "contact_tags", "deal_activities", "deal_approvals", "deal_meetings",
  "lead_activities", "lead_emails", "lead_notes", "lead_tasks",
  "enterprise_quotes", "client_accounts", "client_onboarding_items",
  "client_opportunities", "commissions", "csat_surveys", "quote_line_items",
  "vendor_credits", "credit_notes",
]);

const INV_TABLE_NAMES = new Set(["inv_items"]);

function isCrmTable(name) {
  return name.startsWith("crm_") || CRM_TABLE_NAMES.has(name);
}
function isInvTable(name) {
  return name.startsWith("inv_") || INV_TABLE_NAMES.has(name);
}
function isExcluded(name) {
  return isCrmTable(name) || isInvTable(name);
}

// Platform-global tables: not tenant-scoped in the RBAC sense even though they carry an
// organization identifier. Registered here with the same names the RLS verifier uses so the two
// gates cannot disagree about what is tenant-owned.
const PLATFORM_GLOBAL_TABLES = new Set([
  "organization_lifecycle_sagas", "organization_placement", "organization_reservations",
  "organization_relocations", "placement_decisions", "noisy_neighbour_reviews",
  "organization_relocation_checksums", "organization_saga_steps",
]);
function isPlatformGlobal(name) {
  return PLATFORM_GLOBAL_TABLES.has(name);
}

// SQL table names whose org_id is populated by a DB trigger, intentionally absent
// from the Drizzle model by design.  Composite FKs verified in pg_catalog mode.
// Do not extend without querying scratch_boot_a to confirm the composite FK exists.
const TRIGGER_MANAGED_TENANT_TABLES = new Set([
  "onboarding_template_steps",
  "support_ticket_messages",
]);

// Drizzle symbol names for tables that cannot be resolved via the schema symbol map
// (e.g. external imports).  Prefer "parent not in allTenantTables" over new entries
// here — it handles new global tables automatically.
const GLOBAL_CATALOG_SYMBOLS = new Set([
  "organizations", "users", "billingProducts", "billingPlans",
  "billingPriceVersions", "billingPlanEntitlements", "modulesCatalog", "systemRoles",
]);

// ---------------------------------------------------------------------------
// pg_catalog mode
// ---------------------------------------------------------------------------

async function runCatalogMode() {
  let postgres;
  try {
    const m = await import("postgres");
    postgres = m.default ?? m;
  } catch {
    return null;
  }

  let dotenv;
  try { dotenv = await import("dotenv"); } catch { dotenv = null; }
  if (dotenv) dotenv.config({ path: resolve(BACKEND_ROOT, ".env") });

  const rawUrl = process.env.TENANT_RELATIONSHIP_DB_URL
    || process.env.DIRECT_DATABASE_URL
    || process.env.DATABASE_URL;
  if (!rawUrl) return null;

  const cleanUrl = rawUrl.replace(/'/g, "");
  if (/\/neondb(\?|$)/.test(cleanUrl) || /\/cell2(\?|$)/.test(cleanUrl)) {
    if (SELF_TEST) return null;
    const scratchUrl = cleanUrl.replace(/\/neondb(\?|$)/, "/scratch_boot_a$1");
    return runQuery(postgres, scratchUrl);
  }
  return runQuery(postgres, cleanUrl);
}

async function runQuery(postgres, url) {
  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {}, connect_timeout: 10, idle_timeout: 15 });
  try {
    const rows = await sql`
      WITH tenant AS (
        SELECT c.oid, c.relname, n.nspname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r'
          AND EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid
              AND a.attname IN ('org_id', 'organization_id')
              AND a.attnum > 0
              AND NOT a.attisdropped
          )
      )
      SELECT
        cn.nspname  AS child_schema,
        ct.relname  AS child,
        pn.nspname  AS parent_schema,
        pt.relname  AS parent,
        con.conname AS constraint_name
      FROM pg_constraint con
      JOIN tenant ct ON ct.oid = con.conrelid
      JOIN pg_namespace cn ON cn.oid = (SELECT relnamespace FROM pg_class WHERE oid = con.conrelid)
      JOIN tenant pt ON pt.oid = con.confrelid
      JOIN pg_namespace pn ON pn.oid = (SELECT relnamespace FROM pg_class WHERE oid = con.confrelid)
      WHERE con.contype = 'f'
        AND array_length(con.conkey, 1) = 1
      ORDER BY child_schema, child, parent, con.conname
    `;

    const result = { total: rows.length, actionable: [], excl_crm: [], excl_inv: [], excl_migrated: [] };
    for (const r of rows) {
      if (isPlatformGlobal(r.child) || isPlatformGlobal(r.parent)) { result.excl_migrated.push(r); continue; }
      if (isExcluded(r.child) || isExcluded(r.parent)) {
        if (isCrmTable(r.child) || isCrmTable(r.parent)) result.excl_crm.push(r);
        else result.excl_inv.push(r);
        continue;
      }
      result.actionable.push(r);
    }
    return result;
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------
// Static analysis helpers (fallback + self-test)
// ---------------------------------------------------------------------------

function balancedSlice(src, from) {
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

function parseTenantTableNames(src) {
  const names = new Set();
  const decl = /(?:pgTable|\w+\.table)\s*\(/g;
  for (const m of src.matchAll(decl)) {
    const open = m.index + m[0].length - 1;
    const body = balancedSlice(src, open);
    if (!body) continue;
    const nameMatch = body.match(/^\(\s*["']([^"']+)["']/s);
    if (!nameMatch) continue;
    // Only count a table as tenant-owned when its body DEFINES a tenant column — the pattern
    // propName: typeFn("org_id"). Both spellings count, matching the pg_catalog mode's
    // attname IN ('org_id', 'organization_id'). A table whose tenant column appears only as a
    // constraint name, an index name or a foreignKey foreignColumns reference is not tenant-owned.
    if (/\w+\s*:\s*\w+\s*\(\s*["'](?:org_id|organization_id)["']/.test(body))
      names.add(nameMatch[1]);
  }
  return names;
}

// Build a map: Drizzle symbol name → SQL table name, scanning all schema files.
// Used to resolve parent symbols in static mode for CRM/INV/global/trigger classification.
function buildSymbolToSqlMap(files) {
  const map = new Map();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const re = /\bconst\s+(\w+)\s*=\s*(?:pgTable|\w+\.table)\s*\(\s*["']([^"']+)["']/g;
    for (const m of src.matchAll(re)) {
      if (!map.has(m[1])) map.set(m[1], m[2]);
    }
  }
  return map;
}

function isExcludedFilePath(filePath) {
  const n = filePath.replace(/\\/g, "/");
  return n.includes("/schema/crm/") || n.includes("/schema/inventory/");
}

function parseCrmInventoryImports(src) {
  const excluded = new Set();
  const re = /import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) {
    const path = m[2].replace(/\\/g, "/");
    if (path.includes("/crm/") || path.includes("/inventory/")) {
      for (const s of m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0].trim()))
        if (s) excluded.add(s);
    }
  }
  return excluded;
}

function extractForeignKeyBlocks(src) {
  const blocks = [];
  const fkRe = /\bforeignKey\s*\(/g;
  for (const m of src.matchAll(fkRe)) {
    const open = m.index + m[0].length - 1;
    const body = balancedSlice(src, open);
    if (!body) continue;
    const cm = body.match(/\bcolumns\s*:\s*\[([^\]]*)\]/s);
    const fm = body.match(/\bforeignColumns\s*:\s*\[([^\]]*)\]/s);
    if (!cm || !fm) continue;
    const columns = cm[1].split(",").map((s) => s.trim()).filter(Boolean);
    const foreignCols = fm[1].split(",").map((s) => s.trim()).filter(Boolean);
    const nm = body.match(/\bname\s*:\s*["']([^"']+)["']/);
    blocks.push({ columns, foreignCols, name: nm ? nm[1] : null, bodyStart: m.index, kind: "explicit" });
  }
  return blocks;
}

function extractInlineReferences(src) {
  const blocks = [];
  const re = /\b(\w+)\s*:\s*\w+\s*\([^)]*\)[^,;]*\.references\s*\(\s*\(\s*\)\s*=>\s*(\w+)\.(\w+)/g;
  for (const m of src.matchAll(re)) {
    blocks.push({ propName: m[1], targetTable: m[2], targetField: m[3], bodyStart: m.index, kind: "inline" });
  }
  return blocks;
}

function colContainsTenantKey(cols) {
  return cols.some((c) => {
    const bare = c.replace(/\w+\./, "");
    return bare === "orgId" || bare === "organizationId" ||
      c.includes("orgId") || c.includes("organizationId");
  });
}

function findEnclosingTableName(src, offset) {
  const before = src.slice(0, offset);
  const re = /(?:pgTable|\w+\.table)\s*\(\s*["']([^"']+)["']/g;
  let last = null;
  for (const m of before.matchAll(re)) last = m;
  return last ? last[1] : null;
}

function foreignColOwnerSymbol(colExpr) {
  const i = colExpr.indexOf(".");
  return i >= 0 ? colExpr.slice(0, i).trim() : colExpr.trim();
}

// Classify a parent symbol into exactly one named bucket.
// Resolution order: GLOBAL_CATALOG_SYMBOLS → import-path CRM/INV → SQL-name CRM/INV/trigger/global → actionable.
// An unresolvable symbol (not in symbolToSqlMap and not in GLOBAL_CATALOG_SYMBOLS) is treated as
// actionable — deny by default.
function classifyParent(parentSym, parentSqlName, crmImports, allTenantTables) {
  if (GLOBAL_CATALOG_SYMBOLS.has(parentSym)) return "excl_global";
  if (crmImports.has(parentSym)) return "excl_crm";
  if (!parentSqlName) return "actionable";
  if (isPlatformGlobal(parentSqlName)) return "excl_global";
  if (isCrmTable(parentSqlName)) return "excl_crm";
  if (isInvTable(parentSqlName)) return "excl_inv";
  if (TRIGGER_MANAGED_TENANT_TABLES.has(parentSqlName)) return "excl_trigger";
  if (!allTenantTables.has(parentSqlName)) return "excl_global";
  return "actionable";
}

// Returns named buckets: { actionable, excl_crm, excl_inv, excl_global, excl_trigger }.
// Every FK from a tenant-owned child lands in exactly one bucket — none are silently absent.
// symbolToSqlMap: Drizzle symbol name → SQL table name (from buildSymbolToSqlMap).
function parseStaticViolations(src, filePath, allTenantTables, symbolToSqlMap) {
  const result = { actionable: [], excl_crm: [], excl_inv: [], excl_global: [], excl_trigger: [] };
  if (isExcludedFilePath(filePath)) return result;
  const tenantTablesHere = parseTenantTableNames(src);
  const crmImports = parseCrmInventoryImports(src);

  for (const { columns, foreignCols, name, bodyStart } of extractForeignKeyBlocks(src)) {
    if (columns.length !== 1) continue;
    if (colContainsTenantKey(columns)) continue;
    const tableName = findEnclosingTableName(src, bodyStart);
    if (!tableName) continue;
    if (!tenantTablesHere.has(tableName) && !allTenantTables.has(tableName)) continue;
    const parentSym = foreignColOwnerSymbol(foreignCols[0] ?? "");
    const parentSqlName = symbolToSqlMap?.get(parentSym) ?? null;
    const bucket = classifyParent(parentSym, parentSqlName, crmImports, allTenantTables);
    result[bucket].push({ tableName, constraintName: name ?? "(auto-named)", filePath, kind: "explicit" });
  }

  for (const { propName, targetTable, bodyStart } of extractInlineReferences(src)) {
    if (propName === "orgId" || propName === "organizationId") continue;
    const tableName = findEnclosingTableName(src, bodyStart);
    if (!tableName) continue;
    if (!tenantTablesHere.has(tableName) && !allTenantTables.has(tableName)) continue;
    const parentSqlName = symbolToSqlMap?.get(targetTable) ?? null;
    const bucket = classifyParent(targetTable, parentSqlName, crmImports, allTenantTables);
    result[bucket].push({
      tableName,
      constraintName: `(inline .references on ${propName})`,
      filePath,
      kind: "inline",
    });
  }
  return result;
}

function walkTs(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkTs(full));
    else if (entry.name.endsWith(".ts") && !/\.spec\.ts$/.test(entry.name))
      results.push(full);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (SELF_TEST) {
  // ── parseTenantTableNames checks ──────────────────────────────────────────

  const tnHasOrgIdColDef = parseTenantTableNames(`
export const tbl = pgTable("has_org_id_col", {
  id: integer("id").primaryKey(),
  orgId: text("org_id").notNull(),
}, () => []);
`);

  const tnOrgIdInFkRef = parseTenantTableNames(`
export const tbl = pgTable("org_id_in_fk_ref", {
  id: integer("id").primaryKey(),
  fid: integer("fid"),
}, (t) => [
  foreignKey({ columns: [t.fid], foreignColumns: [parent["org_id"], parent.id] }),
]);
`);

  const tnOrgIdAsConstraintName = parseTenantTableNames(`
export const tbl = pgTable("org_id_as_constraint_name", {
  id: integer("id").primaryKey(),
}, (t) => [
  unique("org_id").on(t.id),
]);
`);

  const tnOrganizationIdColDef = parseTenantTableNames(`
export const tbl = pgTable("has_organization_id", {
  organizationId: text("organization_id").notNull(),
}, () => []);
`);

  // ── parseStaticViolations fixtures ───────────────────────────────────────

  // allTenant: SQL table names the static mode considers tenant-owned
  const allTenant = new Set([
    "bad_table", "good_table", "ok_global_ref", "parent_tbl", "child_tbl",
    "inline_child", "real_tenant_child", "real_tenant_parent",
    "crm_non_crm_path_child", "global_parent_child", "trigger_child",
  ]);

  // symbolMap: Drizzle symbol → SQL name (covers all parent symbols used in fixtures)
  const symbolMap = new Map([
    ["parentTbl", "parent_tbl"],
    ["realTenantParent", "real_tenant_parent"],
    ["deals", "deals"],
    ["creditNotes", "credit_notes"],
    ["marketplaceApps", "marketplace_apps"],
    ["onboardingTemplateSteps", "onboarding_template_steps"],
  ]);

  // Existing fixture: explicit single-col FK from a tenant table → ACTIONABLE
  const fixtureExplicitBad = `
export const badTable = pgTable("bad_table", {
  orgId: text("org_id").notNull(),
  parentId: integer("parent_id"),
}, (table) => [
  foreignKey({ columns: [table.parentId], foreignColumns: [parentTbl.id] }).onDelete("set null"),
  unique("uniq_bad_org_id").on(table.orgId, table.id),
]);
`;

  // Existing fixture: inline .references() from tenant → tenant → ACTIONABLE
  const fixtureInlineRef = `
export const inlineChild = pgTable("inline_child", {
  orgId: text("org_id").notNull(),
  parentTblId: integer("parent_tbl_id").references(() => parentTbl.id, { onDelete: "cascade" }),
}, (table) => [
  unique("uniq_inline_child_org_id").on(table.orgId, table.id),
]);
`;

  // Existing fixture: composite FK → NOT actionable
  const fixtureGoodComposite = `
export const goodTable = pgTable("good_table", {
  orgId: text("org_id").notNull(),
  parentId: integer("parent_id"),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.parentId], foreignColumns: [table.orgId, table.id], name: "fk_good_org_parent" }),
  unique("uniq_good_org_id").on(table.orgId, table.id),
]);
`;

  // Existing fixture: ref to users (GLOBAL_CATALOG_SYMBOLS) → EXCL: global-catalog
  const fixtureGlobalRef = `
export const okGlobalRef = pgTable("ok_global_ref", {
  orgId: text("org_id").notNull(),
  userId: text("user_id").references(() => users.id),
}, (table) => [
  unique("uniq_ok_org_id").on(table.orgId, table.id),
]);
`;

  // Existing fixture: CRM file path → excluded entirely
  const fixtureCrmFile = `
export const crmTable = pgTable("crm_excluded", {
  orgId: text("org_id").notNull(),
  clientId: integer("client_id"),
}, (table) => [
  foreignKey({ columns: [table.clientId], foreignColumns: [table.id] }),
  unique("uniq_crm_excl_org_id").on(table.orgId, table.id),
]);
`;

  // NEW: child has no org_id column (only "org_id" in a foreignKey foreignColumns ref)
  // → child not tenant-owned → NOT actionable (regression test for Class 3 fix)
  const fixtureChildNoOrgIdCol = `
export const orgIdInFkRef = pgTable("org_id_in_fk_ref", {
  id: integer("id").primaryKey(),
  fid: integer("fid"),
}, (t) => [
  foreignKey({ columns: [t.fid], foreignColumns: [parentTbl["org_id"], parentTbl.id] }),
]);
`;

  // NEW: both child and parent have org_id as column defs → ACTIONABLE (regression safety)
  const fixtureBothTenantActionable = `
export const realTenantChild = pgTable("real_tenant_child", {
  orgId: text("org_id").notNull(),
  parentId: integer("parent_id").references(() => realTenantParent.id),
}, () => []);
`;

  // NEW: CRM parent imported from non-CRM barrel path → EXCL: CRM (Class 2 fix)
  const fixtureCrmParentNonCrmPath = `
import { creditNotes } from "../../accounting";
export const crm_non_crm_path_child_tbl = pgTable("crm_non_crm_path_child", {
  orgId: text("org_id").notNull(),
  creditNoteId: integer("credit_note_id").references(() => creditNotes.id),
}, () => []);
`;

  // NEW: parent has no org_id in Drizzle → EXCL: global-catalog (Class 1 fix)
  const fixtureGlobalParentNoOrgId = `
export const globalParentChild = pgTable("global_parent_child", {
  orgId: text("org_id").notNull(),
  appId: integer("app_id").references(() => marketplaceApps.id),
}, () => []);
`;

  // NEW: parent is trigger-managed (not in Drizzle, but has org_id in DB) → EXCL: trigger-managed (Class 4)
  const fixtureTriggerManagedParent = `
export const triggerChild = pgTable("trigger_child", {
  orgId: text("org_id").notNull(),
  stepId: integer("step_id").references(() => onboardingTemplateSteps.id),
}, () => []);
`;

  const badExplicit = parseStaticViolations(fixtureExplicitBad, "fixture/bad.ts", allTenant, symbolMap);
  const badInline = parseStaticViolations(fixtureInlineRef, "fixture/inline.ts", allTenant, symbolMap);
  const good = parseStaticViolations(fixtureGoodComposite, "fixture/good.ts", allTenant, symbolMap);
  const globalRef = parseStaticViolations(fixtureGlobalRef, "fixture/global.ts", allTenant, symbolMap);
  const crmFile = parseStaticViolations(fixtureCrmFile, "src/db/schema/crm/excluded.ts", allTenant, symbolMap);
  const childNoOrgId = parseStaticViolations(fixtureChildNoOrgIdCol, "fixture/no_org_id.ts", allTenant, symbolMap);
  const bothTenant = parseStaticViolations(fixtureBothTenantActionable, "fixture/both_tenant.ts", allTenant, symbolMap);
  const crmNonPath = parseStaticViolations(fixtureCrmParentNonCrmPath, "fixture/crm_non_path.ts", allTenant, symbolMap);
  const globalNoOrg = parseStaticViolations(fixtureGlobalParentNoOrgId, "fixture/global_no_org.ts", allTenant, symbolMap);
  const triggerManaged = parseStaticViolations(fixtureTriggerManagedParent, "fixture/trigger.ts", allTenant, symbolMap);

  const checks = {
    // ── parseTenantTableNames ────────────────────────────────────────────
    tenant_names_org_id_col_def_detected:
      tnHasOrgIdColDef.has("has_org_id_col"),
    tenant_names_org_id_in_fk_ref_not_detected:
      !tnOrgIdInFkRef.has("org_id_in_fk_ref"),
    tenant_names_org_id_as_constraint_name_not_detected:
      !tnOrgIdAsConstraintName.has("org_id_as_constraint_name"),
    tenant_names_organization_id_col_def_detected:
      tnOrganizationIdColDef.has("has_organization_id"),

    // ── parseStaticViolations — existing checks ──────────────────────────
    detects_explicit_single_col_violation:
      badExplicit.actionable.length === 1,
    explicit_violation_table_name_correct:
      badExplicit.actionable[0]?.tableName === "bad_table",
    detects_inline_references_violation:
      badInline.actionable.length === 1,
    inline_violation_table_name_correct:
      badInline.actionable[0]?.tableName === "inline_child",
    ignores_composite_fk:
      good.actionable.length === 0,
    ignores_global_user_ref:
      globalRef.actionable.length === 0 && globalRef.excl_global.length === 1,
    crm_file_path_excluded:
      Object.values(crmFile).every((a) => a.length === 0),

    // ── parseStaticViolations — new checks ───────────────────────────────
    child_no_org_id_col_not_actionable:
      childNoOrgId.actionable.length === 0 && Object.values(childNoOrgId).every((a) => a.length === 0),
    both_tenant_tables_still_actionable:
      bothTenant.actionable.length === 1 && bothTenant.actionable[0]?.tableName === "real_tenant_child",
    crm_parent_from_non_crm_path_excl_crm:
      crmNonPath.excl_crm.length === 1 && crmNonPath.actionable.length === 0,
    global_parent_no_org_id_excl_global:
      globalNoOrg.excl_global.length === 1 && globalNoOrg.actionable.length === 0,
    trigger_managed_parent_excl_trigger:
      triggerManaged.excl_trigger.length === 1 && triggerManaged.actionable.length === 0,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Real run
// ---------------------------------------------------------------------------

async function main() {
  let catalogResult = null;
  let usedMode = "static";

  if (!STATIC_ONLY) {
    try {
      catalogResult = await runCatalogMode();
      if (catalogResult) usedMode = "pg_catalog";
    } catch (e) {
      process.stderr.write(`[warn] pg_catalog connection failed: ${e.message}\n`);
    }
  }

  if (catalogResult) {
    const { total, actionable, excl_crm, excl_inv, excl_migrated } = catalogResult;

    console.log(`Mode                   pg_catalog (scratch_boot_a)`);
    console.log(`Total single-col FKs   ${total}`);
    console.log(`EXCL: CRM              ${excl_crm.length} (child or parent is a CRM table — AR-02 scope exclusion)`);
    console.log(`EXCL: Inventory        ${excl_inv.length} (child or parent is Inventory — AR-02 scope exclusion)`);
    console.log(`EXCL: platform-global  ${excl_migrated.length} (child or parent is a platform-global table registered above)`);
    console.log(`Actionable             ${actionable.length}`);
    console.log("");

    if (actionable.length === 0) {
      console.log("OK — zero actionable single-column tenant FKs.");
      process.exit(0);
    }

    console.error(`FAIL — ${actionable.length} single-column tenant FK(s) need composite (org_id, child_id) → (org_id, id):`);
    for (const r of actionable)
      console.error(`  ${r.child_schema}.${r.child} → ${r.parent_schema}.${r.parent}  (${r.constraint_name})`);
    console.error("");
    console.error(`Run these against scratch_boot_a — CRM, Inventory and platform-global relationships are named above.`);
    process.exit(1);
  }

  // Static fallback
  if (!existsSync(SCHEMA_DIR)) {
    process.stderr.write(`Cannot read schema dir: ${SCHEMA_DIR}\n`);
    process.exit(2);
  }

  const allFiles = walkTs(SCHEMA_DIR);
  const files = allFiles.filter((f) => !isExcludedFilePath(f));

  if (files.length < 20) {
    process.stderr.write(`Only ${files.length} schema files found — wrong directory.\n`);
    process.exit(2);
  }

  const allTenantTables = new Set();
  for (const f of files)
    for (const name of parseTenantTableNames(readFileSync(f, "utf8")))
      allTenantTables.add(name);

  if (allTenantTables.size < 50) {
    process.stderr.write(`Parsed only ${allTenantTables.size} tenant tables — broken parser or wrong dir.\n`);
    process.exit(2);
  }

  // Build symbol map from ALL files (including CRM/INV) to resolve parent symbols.
  const symbolToSqlMap = buildSymbolToSqlMap(allFiles);

  const totals = { actionable: [], excl_crm: [], excl_inv: [], excl_global: [], excl_trigger: [] };
  for (const f of files) {
    const r = parseStaticViolations(readFileSync(f, "utf8"), f, allTenantTables, symbolToSqlMap);
    for (const key of Object.keys(totals))
      totals[key].push(...r[key]);
  }

  const { actionable, excl_crm, excl_inv, excl_global, excl_trigger } = totals;

  console.log(`Mode                   static (no DB — inline .references() violations MAY be missed)`);
  console.log(`Schema files           ${files.length}`);
  console.log(`Tenant tables          ${allTenantTables.size}`);
  console.log(`EXCL: CRM              ${excl_crm.length} (child or parent is a CRM table — AR-02 scope exclusion)`);
  console.log(`EXCL: Inventory        ${excl_inv.length} (child or parent is Inventory — AR-02 scope exclusion)`);
  console.log(`EXCL: global-catalog   ${excl_global.length} (parent has no org_id column in Drizzle)`);
  console.log(`EXCL: trigger-managed  ${excl_trigger.length} (parent org_id is DB-trigger-managed; composite FK verified in catalog)`);
  console.log(`Actionable             ${actionable.length}`);
  console.log("");

  if (actionable.length === 0) {
    if (!DB_ONLY && !STATIC_ONLY) {
      console.log("WARN — static analysis: zero actionable violations, but pg_catalog was unreachable.");
      console.log("       Run with a DB connection to get the authoritative count.");
      process.exit(2);
    }
    console.log("OK — static analysis: zero actionable single-column tenant FKs.");
    process.exit(0);
  }

  console.error("FAIL — single-column tenant FKs between tenant-owned tables:");
  for (const v of actionable.sort((a, b) => a.tableName.localeCompare(b.tableName))) {
    console.error(`  FAIL  table=${v.tableName}  (${v.kind})  ${v.constraintName}`);
    console.error(`        file: ${relative(BACKEND_ROOT, v.filePath)}`);
  }
  console.error("");
  console.error(`FAIL — ${actionable.length} violation(s). Connect to scratch_boot_a for authoritative count.`);
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e.message}\n`);
  process.exit(2);
});
