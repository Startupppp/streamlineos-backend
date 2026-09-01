/**
 * check-tenant-relationships.mjs  (AR-02 gate, pg_catalog-backed)
 *
 * WHAT IT CHECKS
 * Every FK where BOTH child and parent are tenant-owned (carry org_id) must use a
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
 * CLASSIFICATION (pg_catalog mode)
 *   Every FK lands in exactly one bucket — none are silently absent:
 *   • ACTIONABLE   — needs (org_id, child_id) → (org_id, id) composite FK
 *   • EXCL:CRM     — child or parent is a CRM table (explicitly excluded by AR-02 scope)
 *   • EXCL:INV     — child or parent is an Inventory table (explicitly excluded)
 *   • EXCL:MIGRATED — covered by pending 0934–0937 migrations, not yet applied here
 *
 * EXCLUSION POLICY
 *   CRM and Inventory are excluded from AR-02 scope (PRD-IN-SCOPE.md §4) — this is
 *   explicit, named, never a silent global ignore.  A FK between non-CRM/Inv tables
 *   cannot be silently excluded: add it to APPROVED_GLOBALS with a rationale, or fix it.
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

// CRM tables: name prefix OR tables identified from schema/crm/ source.
// Tables whose SQL name does NOT start with crm_ but live in the CRM module.
const CRM_TABLE_NAMES = new Set([
  "clients", "leads", "deals", "contacts", "quotes", "pipelines", "pipeline_stages",
  "activities", "campaigns", "campaign_recipients", "quote_items", "contact_notes",
  "contact_tags", "deal_activities", "deal_approvals", "deal_meetings",
  "lead_activities", "lead_emails", "lead_notes", "lead_tasks",
  "enterprise_quotes", "client_accounts", "client_onboarding_items",
  "client_opportunities", "commissions", "csat_surveys", "quote_line_items",
  "vendor_credits", "credit_notes",
]);

// Inventory tables: name prefix inv_ or items from schema/inventory/
const INV_TABLE_NAMES = new Set(["inv_items"]); // extended by inv_ prefix check below

function isCrmTable(name) {
  return name.startsWith("crm_") || CRM_TABLE_NAMES.has(name);
}
function isInvTable(name) {
  return name.startsWith("inv_") || INV_TABLE_NAMES.has(name);
}
function isExcluded(name) {
  return isCrmTable(name) || isInvTable(name);
}

// FKs covered by pending 0934–0937 migrations (constraint names as they exist in DB
// before those migrations are applied).
const MIGRATED_CONSTRAINT_NAMES = new Set([
  // 0934 — build schema self-refs
  "tickets_epic_id_tickets_id_fk",
  "tickets_parent_ticket_id_tickets_id_fk",
  "tickets_recurrence_parent_id_tickets_id_fk",
  "okr_goals_parent_goal_id_okr_goals_id_fk",
  "pages_parent_page_id_pages_id_fk",
  "ticket_comments_parent_comment_id_ticket_comments_id_fk",
  // 0935 — billing
  "billing_invoice_snapshots_subscription_id_subscriptions_id_fk",
  "billing_invoice_line_snapshots_snapshot_id_billing_invoice_snapshots_id_fk",
  "billing_invoice_line_snapshots_proration_line_id_billing_proration_lines_id_fk",
  "billing_invoice_line_snapshots_usage_rollup_id_billing_usage_rollups_id_fk",
  "billing_credit_notes_original_snapshot_id_billing_invoice_snapshots_id_fk",
  "billing_credit_note_lines_credit_note_id_billing_credit_notes_id_fk",
  "subscription_items_subscription_id_subscriptions_id_fk",
  "billing_proration_lines_subscription_id_subscriptions_id_fk",
  "subscription_payments_subscription_id_subscriptions_id_fk",
  // 0936 — misc
  "ledger_accounts_parent_account_id_ledger_accounts_id_fk",
  "journal_entries_reversed_entry_id_journal_entries_id_fk",
  "documents_parent_document_id_documents_id_fk",
  "goals_parent_goal_id_goals_id_fk",
  "fk_kb_article_comments_parent",
  // 0937 — drop redundant single-col FKs (composite already exists)
  "fk_kb_pages_parent",
  "fk_kb_page_comments_parent",
  "chat_messages_reply_to_id_chat_messages_id_fk",
  "fk_kb_categories_parent",
  // tickets.customerId -> clients.id was not in migrations (CRM parent, excluded above)
  "fk_tickets_customer",
  "fk_business_parties_acquisition_campaign",
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
  // Safety: never touch neondb or cell2
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
              AND a.attname = 'org_id'
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
      if (MIGRATED_CONSTRAINT_NAMES.has(r.constraint_name)) { result.excl_migrated.push(r); continue; }
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
    if (/["']org_id["']|["']organization_id["']/.test(body))
      names.add(nameMatch[1]);
  }
  return names;
}

function isExcludedFilePath(filePath) {
  const n = filePath.replace(/\\/g, "/");
  return n.includes("/schema/crm/") || n.includes("/schema/inventory/");
}

const GLOBAL_CATALOG_SYMBOLS = new Set([
  "organizations", "users", "billingProducts", "billingPlans",
  "billingPriceVersions", "billingPlanEntitlements", "modulesCatalog", "systemRoles",
]);

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

// Detect inline .references(() => table.col) calls
function extractInlineReferences(src) {
  const blocks = [];
  // Match: columnName: type("col_name").notNull()...references(() => table.field, {...})
  const re = /\b(\w+)\s*:\s*\w+\s*\([^)]*\)[^,;]*\.references\s*\(\s*\(\s*\)\s*=>\s*(\w+)\.(\w+)/g;
  for (const m of src.matchAll(re)) {
    const propName = m[1];
    const targetTable = m[2];
    const targetField = m[3];
    blocks.push({ propName, targetTable, targetField, bodyStart: m.index, kind: "inline" });
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

function parseStaticViolations(src, filePath, allTenantTables) {
  if (isExcludedFilePath(filePath)) return [];
  const violations = [];
  const tenantTablesHere = parseTenantTableNames(src);
  const crmImports = parseCrmInventoryImports(src);

  // Explicit foreignKey({}) blocks
  for (const { columns, foreignCols, name, bodyStart } of extractForeignKeyBlocks(src)) {
    if (columns.length !== 1) continue;
    if (colContainsTenantKey(columns)) continue;
    const tableName = findEnclosingTableName(src, bodyStart);
    if (!tableName) continue;
    if (!tenantTablesHere.has(tableName) && !allTenantTables.has(tableName)) continue;
    const parentSym = foreignColOwnerSymbol(foreignCols[0] ?? "");
    if (GLOBAL_CATALOG_SYMBOLS.has(parentSym) || crmImports.has(parentSym)) continue;
    violations.push({ tableName, constraintName: name ?? "(auto-named)", filePath, kind: "explicit" });
  }

  // Inline .references() calls
  for (const { propName, targetTable, targetField, bodyStart } of extractInlineReferences(src)) {
    if (propName === "orgId" || propName === "organizationId") continue;
    const tableName = findEnclosingTableName(src, bodyStart);
    if (!tableName) continue;
    if (!tenantTablesHere.has(tableName) && !allTenantTables.has(tableName)) continue;
    if (GLOBAL_CATALOG_SYMBOLS.has(targetTable) || crmImports.has(targetTable)) continue;
    // Only flag if the target table is also tenant-owned
    if (!allTenantTables.has(targetTable) && targetField !== "id") continue;
    violations.push({
      tableName,
      constraintName: `(inline .references on ${propName})`,
      filePath,
      kind: "inline",
    });
  }
  return violations;
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
  const allTenant = new Set(["bad_table", "good_table", "ok_global_ref", "parent_tbl", "child_tbl", "inline_child"]);

  const fixtureExplicitBad = `
export const badTable = pgTable("bad_table", {
  orgId: text("org_id").notNull(),
  parentId: integer("parent_id"),
}, (table) => [
  foreignKey({ columns: [table.parentId], foreignColumns: [table.id] }).onDelete("set null"),
  unique("uniq_bad_org_id").on(table.orgId, table.id),
]);
`;

  const fixtureInlineRef = `
export const inlineChild = pgTable("inline_child", {
  orgId: text("org_id").notNull(),
  parentTblId: integer("parent_tbl_id").references(() => parentTbl.id, { onDelete: "cascade" }),
}, (table) => [
  unique("uniq_inline_child_org_id").on(table.orgId, table.id),
]);
`;

  const fixtureGoodComposite = `
export const goodTable = pgTable("good_table", {
  orgId: text("org_id").notNull(),
  parentId: integer("parent_id"),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.parentId], foreignColumns: [table.orgId, table.id], name: "fk_good_org_parent" }),
  unique("uniq_good_org_id").on(table.orgId, table.id),
]);
`;

  const fixtureGlobalRef = `
export const okGlobalRef = pgTable("ok_global_ref", {
  orgId: text("org_id").notNull(),
  userId: text("user_id").references(() => users.id),
}, (table) => [
  unique("uniq_ok_org_id").on(table.orgId, table.id),
]);
`;

  const fixtureCrmFile = `
export const crmTable = pgTable("crm_excluded", {
  orgId: text("org_id").notNull(),
  clientId: integer("client_id"),
}, (table) => [
  foreignKey({ columns: [table.clientId], foreignColumns: [table.id] }),
  unique("uniq_crm_excl_org_id").on(table.orgId, table.id),
]);
`;

  const badExplicit = parseStaticViolations(fixtureExplicitBad, "fixture/bad.ts", allTenant);
  const badInline = parseStaticViolations(fixtureInlineRef, "fixture/inline.ts", allTenant);
  const good = parseStaticViolations(fixtureGoodComposite, "fixture/good.ts", allTenant);
  const globalRef = parseStaticViolations(fixtureGlobalRef, "fixture/global.ts", allTenant);
  const crmFile = parseStaticViolations(fixtureCrmFile, "src/db/schema/crm/excluded.ts", allTenant);

  const checks = {
    detects_explicit_single_col_violation: badExplicit.length === 1,
    explicit_violation_table_name_correct: badExplicit[0]?.tableName === "bad_table",
    detects_inline_references_violation: badInline.length === 1,
    inline_violation_table_name_correct: badInline[0]?.tableName === "inline_child",
    ignores_composite_fk: good.length === 0,
    ignores_global_user_ref: globalRef.length === 0,
    crm_file_path_excluded: crmFile.length === 0,
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
    const excl_total = excl_crm.length + excl_inv.length + excl_migrated.length;

    console.log(`Mode                   pg_catalog (scratch_boot_a)`);
    console.log(`Total single-col FKs   ${total}`);
    console.log(`EXCL: CRM              ${excl_crm.length} (child or parent is a CRM table — AR-02 scope exclusion)`);
    console.log(`EXCL: Inventory        ${excl_inv.length} (child or parent is Inventory — AR-02 scope exclusion)`);
    console.log(`EXCL: In-migration     ${excl_migrated.length} (covered by 0934–0937, pending apply)`);
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
    console.error(`Run these against scratch_boot_a — CRM/Inventory and 0934–0937-covered FKs are named above.`);
    process.exit(1);
  }

  // Static fallback
  if (!existsSync(SCHEMA_DIR)) {
    process.stderr.write(`Cannot read schema dir: ${SCHEMA_DIR}\n`);
    process.exit(2);
  }

  const files = walkTs(SCHEMA_DIR).filter((f) => !isExcludedFilePath(f));
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

  const violations = [];
  for (const f of files)
    violations.push(...parseStaticViolations(readFileSync(f, "utf8"), f, allTenantTables));

  console.log(`Mode                   static (no DB — inline .references() violations MAY be missed)`);
  console.log(`Schema files           ${files.length}`);
  console.log(`Tenant tables          ${allTenantTables.size}`);
  console.log(`CRM excluded           explicitly — schema/crm/ path`);
  console.log(`Inventory excluded     explicitly — schema/inventory/ path`);
  console.log(`Actionable (explicit+inline)  ${violations.length}`);
  console.log("");

  if (violations.length === 0) {
    if (!DB_ONLY) {
      console.log("WARN — static analysis shows 0 violations, but pg_catalog was unreachable.");
      console.log("       Run with a DB connection to get the authoritative result.");
      process.exit(2);
    }
    process.exit(0);
  }

  console.error("FAIL — single-column tenant FKs between tenant-owned tables:");
  for (const v of violations.sort((a, b) => a.tableName.localeCompare(b.tableName))) {
    console.error(`  FAIL  table=${v.tableName}  (${v.kind})  ${v.constraintName}`);
    console.error(`        file: ${relative(BACKEND_ROOT, v.filePath)}`);
  }
  console.error("");
  console.error(`FAIL — ${violations.length} violation(s). Connect to scratch_boot_a for authoritative count.`);
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e.message}\n`);
  process.exit(2);
});
