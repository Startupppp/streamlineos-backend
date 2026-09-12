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
 * CLASSIFICATION (both modes)
 *   Every FK lands in exactly one named bucket — none are silently absent:
 *   • ACTIONABLE        — needs (org_id, child_id) → (org_id, id) composite FK
 *   • EXCL: CRM         — child or parent is a CRM table (AR-02 scope exclusion)
 *   • EXCL: Inventory   — child or parent is Inventory (AR-02 scope exclusion)
 *   • EXCL: platform-global — child or parent is a registered platform-global table
 *
 *   A tenant column is `org_id` OR `organization_id`. Matching only `org_id` hid 81 tables
 *   and 4 real single-column violations from BOTH modes until this was widened.
 *
 * EXCLUSION POLICY
 *   CRM and Inventory are excluded from AR-02 scope (PRD-IN-SCOPE.md §4) — this is
 *   explicit, named, never a silent global ignore.  A FK between non-CRM/Inv tables
 *   cannot be silently excluded: fix it, or register the table as platform-global.
 *   An earlier "EXCL: In-migration" bucket excused 17 constraints as covered by migrations
 *   0934–0937; 0935, 0936 and 0937 were never written, so that exclusion protected nothing.
 *
 * TARGET CAVEAT
 *   The default target (scratch_boot_a) is a shared scratch database that other sessions
 *   reset and cold-replay. A half-applied chain reports a large actionable count that reads
 *   like a release failure but is only a statement about that database, so the run warns when
 *   drizzle.__replay holds fewer entries than the journal. Use TENANT_RELATIONSHIP_DB_URL to
 *   point at a fully bootstrapped database.
 *
 * WHICH DATABASE ANSWERED
 *   With TENANT_RELATIONSHIP_DB_URL unset the target fell back to DIRECT_DATABASE_URL and
 *   then DATABASE_URL, which in this repository is the shared REMOTE branch, and the report
 *   named only `current_database()` — so a remote scratch_boot_a and a local one printed the
 *   same line. Every run now prints host:port/database and the variable that supplied it, and
 *   a non-loopback target reached through the FALLBACK chain is INCONCLUSIVE (exit 2) rather
 *   than a number. A remote target chosen deliberately through TENANT_RELATIONSHIP_DB_URL is
 *   still allowed, as is TENANT_RELATIONSHIP_ALLOW_REMOTE=1.
 *
 * Usage:  node src/scripts/check-tenant-relationships.mjs [--db-only|--static-only|--self-test]
 * Exit:   0 clean · 1 violations found · 2 parser/connection error, or a target this gate
 *         will not measure blind
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

const JOURNAL_ENTRY_COUNT = (() => {
  try {
    return JSON.parse(readFileSync(join(BACKEND_ROOT, "migrations", "meta", "_journal.json"), "utf8")).entries.length;
  } catch {
    return 0;
  }
})();

// ---------------------------------------------------------------------------
// Exclusion sets — all explicit, none silent
// ---------------------------------------------------------------------------

// CRM tables: name prefix OR tables identified from schema/crm/ source.
// Tables whose SQL name does NOT start with crm_ but live in the CRM module.
// `credit_notes` and `vendor_credits` (schema/accounting/finance-ar-ap.ts) and `enterprise_quotes`
// (schema/billing/billing.ts) were listed here and are NOT CRM. Because CRM is excluded from this
// release they were skipped in both modes, hiding their foreign keys behind a scope exclusion they
// never belonged to. An exclusion keyed on a table name rather than a schema path widens itself.
const CRM_TABLE_NAMES = new Set([
  "clients", "leads", "deals", "contacts", "quotes", "pipelines", "pipeline_stages",
  "activities", "campaigns", "campaign_recipients", "quote_items", "contact_notes",
  "contact_tags", "deal_activities", "deal_approvals", "deal_meetings",
  "lead_activities", "lead_emails", "lead_notes", "lead_tasks",
  "client_accounts", "client_onboarding_items",
  "client_opportunities", "commissions", "csat_surveys", "quote_line_items",
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

// Platform-global tables: they carry an organization identifier but are not tenant-scoped in the
// RBAC sense. Registered with the same names the RLS verifier uses so the two gates cannot disagree.
// This replaced an "EXCL: In-migration" bucket that excused 17 constraints as covered by migrations
// 0934-0937 -- 0935, 0936 and 0937 were never written, so that exclusion protected nothing.
const PLATFORM_GLOBAL_TABLES = new Set([
  "organization_lifecycle_sagas", "organization_placement", "organization_reservations",
  "organization_relocations", "placement_decisions", "noisy_neighbour_reviews",
  "organization_relocation_checksums", "organization_saga_steps",
]);
function isPlatformGlobal(name) {
  return PLATFORM_GLOBAL_TABLES.has(name);
}

const CONSTRAINT_EXCEPTIONS = new Map([
  [
    "fk_subscription_purchases_coupon",
    "coupons.org_id is nullable by design — org_id IS NULL is what marks a StreamlineOS platform " +
      "promotion (promotionRowSchema types orgId as z.null(); /platform/promotions creates exactly " +
      "those rows). Under MATCH SIMPLE a composite (org_id, coupon_id) -> (org_id, id) FK compares a " +
      "purchase's real org_id against NULL, matches nothing, and would reject every platform-promotion " +
      "purchase. The tenant boundary here is held by the application path and proved by " +
      "coupon-tenant-isolation.spec.ts + billing-purchase-binding.spec.ts (2 suites / 22 tests, " +
      "including cross-tenant receipt substitution).",
  ],
]);
function constraintException(name) {
  const reason = CONSTRAINT_EXCEPTIONS.get(name);
  return typeof reason === "string" && reason.trim().length > 0 ? reason : null;
}

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

  if (resolveTarget(process.env) === null) {
    let dotenv;
    try { dotenv = await import("dotenv"); } catch { dotenv = null; }
    if (dotenv) dotenv.config({ path: resolve(BACKEND_ROOT, ".env") });
  }

  const resolved = resolveTarget(process.env);
  if (!resolved) return null;

  // The refusal below, and the label printed with every result, exist because the
  // fallback chain used to be silent. With TENANT_RELATIONSHIP_DB_URL unset this
  // resolves DIRECT_DATABASE_URL and then DATABASE_URL, which in this repo is the
  // shared remote branch — and the report said only `pg_catalog (scratch_boot_a)`,
  // a database NAME. A remote scratch_boot_a and a local one printed identically,
  // so "measured locally" was an assumption the output could never contradict.
  const refusal = remoteFallbackRefusal(resolved, process.env);
  if (refusal && !SELF_TEST) return { refused: refusal };

  const cleanUrl = resolved.url;
  // Safety: never touch neondb or cell2
  if (/\/neondb(\?|$)/.test(cleanUrl) || /\/cell2(\?|$)/.test(cleanUrl)) {
    if (SELF_TEST) return null;
    const scratchUrl = cleanUrl.replace(/\/neondb(\?|$)/, "/scratch_boot_a$1");
    return runQuery(postgres, scratchUrl, { ...resolved, url: scratchUrl, rewritten: true });
  }
  return runQuery(postgres, cleanUrl, resolved);
}

/** Which variable answered, so the report can say where the target came from. */
export function resolveTarget(env) {
  for (const name of ["TENANT_RELATIONSHIP_DB_URL", "DIRECT_DATABASE_URL", "DATABASE_URL"]) {
    const raw = env[name];
    if (raw) return { url: String(raw).replace(/'/g, ""), source: name };
  }
  return null;
}

export function safeLabel(url) {
  try {
    const u = new URL(url);
    const database = u.pathname.replace(/^\//, "").split("?")[0] || "?";
    return `${u.hostname || "?"}:${u.port || "5432"}/${database}`;
  } catch {
    return "<unparseable url>";
  }
}

export function isLoopbackHost(url) {
  try {
    const host = new URL(url).hostname;
    return host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * A remote target reached through the DEDICATED variable is a deliberate choice and
 * is allowed. A remote target reached through the fallback chain is an accident, so
 * it is INCONCLUSIVE (exit 2), never a pass — the same rule the mid-bootstrap guard
 * below already follows. Returns null when the target is fine.
 */
export function remoteFallbackRefusal(resolved, env) {
  if (resolved === null) return null;
  if (isLoopbackHost(resolved.url)) return null;
  if (resolved.source === "TENANT_RELATIONSHIP_DB_URL") return null;
  if (env.TENANT_RELATIONSHIP_ALLOW_REMOTE === "1") return null;
  return (
    `INCONCLUSIVE — the target resolved to "${safeLabel(resolved.url)}" from ${resolved.source}, ` +
    `which is not a loopback host and was not chosen for this gate. ` +
    `Set TENANT_RELATIONSHIP_DB_URL to the database you mean to measure, ` +
    `or TENANT_RELATIONSHIP_ALLOW_REMOTE=1 to accept this one.`
  );
}

const MIN_TENANT_TABLES = 400;

async function runQuery(postgres, url, resolved = null) {
  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {}, connect_timeout: 10, idle_timeout: 15 });
  try {
    const [{ tenant_tables }] = await sql`
      SELECT count(*)::int AS tenant_tables
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid
            AND a.attname IN ('org_id', 'organization_id')
            AND a.attnum > 0
            AND NOT a.attisdropped
        )
    `;
    if (tenant_tables < MIN_TENANT_TABLES) return { vacuous: true, tenant_tables };

    // The default target is a shared scratch database that other sessions reset and cold-replay.
    // A half-applied chain reports a large actionable count that looks like a release failure but
    // is only a statement about that database, so say so rather than let the number stand alone.
    // Two ledgers exist: replay-chain-cold.mjs writes drizzle.__replay, db-bootstrap.mjs writes
    // drizzle.__drizzle_migrations. Reading only the first made this guard inert against every
    // database built by db:bootstrap, which is the path the release evidence actually uses.
    const ledgerCounts = [];
    for (const relation of ["drizzle.__replay", "drizzle.__drizzle_migrations"]) {
      const [row] = await sql.unsafe(
        `SELECT count(*)::int AS applied FROM ${relation}`,
      ).catch(() => [undefined]);
      if (row) ledgerCounts.push(row.applied);
    }
    const midBootstrap = ledgerCounts.length > 0 ? Math.max(...ledgerCounts) : null;
    const [{ target }] = await sql`SELECT current_database() AS target`;

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

    const result = { total: rows.length, actionable: [], excl_crm: [], excl_inv: [], excl_migrated: [], excl_named: [] };
    for (const r of rows) {
      if (isPlatformGlobal(r.child) || isPlatformGlobal(r.parent)) { result.excl_migrated.push(r); continue; }
      if (isExcluded(r.child) || isExcluded(r.parent)) {
        if (isCrmTable(r.child) || isCrmTable(r.parent)) result.excl_crm.push(r);
        else result.excl_inv.push(r);
        continue;
      }
      const reason = constraintException(r.constraint_name);
      if (reason !== null) { result.excl_named.push({ ...r, reason }); continue; }
      result.actionable.push(r);
    }
    result.midBootstrap = midBootstrap;
    result.target = target;
    result.targetLabel = safeLabel(url);
    result.targetSource = resolved?.source ?? "unknown";
    result.targetRewritten = resolved?.rewritten === true;
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
    if (/\w+\s*:\s*\w+\s*\(\s*["'](?:org_id|organization_id)["']/.test(body))
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

// Detect inline .references(() => table.col) calls, including the self-referencing
// .references((): AnyPgColumn => table.col) form a bare `()\s*=>` pattern could not see.
function extractInlineReferences(src) {
  const blocks = [];
  const re = /\b(\w+)\s*:\s*\w+\s*\([^)]*\)[^,;]*\.references\s*\(\s*\(\s*\)\s*(?::\s*[A-Za-z_$][\w$<>.\[\]|\s]*?)?=>\s*(\w+)\.(\w+)/g;
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

// SQL table names whose tenant column is filled by a database trigger and is deliberately
// absent from the Drizzle model. Their composite FKs are verified in pg_catalog mode.
const TRIGGER_MANAGED_TENANT_TABLES = new Set([
  "onboarding_template_steps",
  "support_ticket_messages",
]);

// Drizzle symbol name -> SQL table name, so a parent can be classified by the same
// CRM/Inventory/platform-global name sets the pg_catalog mode uses. Comparing a symbol
// against a set of SQL names silently classifies nothing.
function buildSymbolToSqlMap(files) {
  const map = new Map();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/export\s+const\s+(\w+)\s*=\s*(?:pgTable|\w+\.table)\s*\(\s*["']([^"']+)["']/g))
      map.set(m[1], m[2]);
  }
  return map;
}

function parentIsOutOfScope(parentSym, parentSqlName, allTenantTables) {
  if (GLOBAL_CATALOG_SYMBOLS.has(parentSym)) return true;
  if (!parentSqlName) return false;
  if (isCrmTable(parentSqlName) || isInvTable(parentSqlName)) return true;
  if (isPlatformGlobal(parentSqlName)) return true;
  if (TRIGGER_MANAGED_TENANT_TABLES.has(parentSqlName)) return true;
  return !allTenantTables.has(parentSqlName);
}

function parseStaticViolations(src, filePath, allTenantTables, symbolToSql) {

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
    if (crmImports.has(parentSym)) continue;
    if (parentIsOutOfScope(parentSym, symbolToSql?.get(parentSym) ?? null, allTenantTables)) continue;
    violations.push({ tableName, constraintName: name ?? "(auto-named)", filePath, kind: "explicit" });
  }

  // Inline .references() calls
  for (const { propName, targetTable, targetField, bodyStart } of extractInlineReferences(src)) {
    if (propName === "orgId" || propName === "organizationId") continue;
    const tableName = findEnclosingTableName(src, bodyStart);
    if (!tableName) continue;
    if (!tenantTablesHere.has(tableName) && !allTenantTables.has(tableName)) continue;
    if (crmImports.has(targetTable)) continue;
    if (parentIsOutOfScope(targetTable, symbolToSql?.get(targetTable) ?? null, allTenantTables)) continue;
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

  const fixtureAnnotatedInlineRef = `
export const inlineChild = pgTable("inline_child", {
  orgId: text("org_id").notNull(),
  parentTblId: integer("parent_tbl_id").references((): AnyPgColumn => parentTbl.id, { onDelete: "set null" }),
}, (table) => [
  unique("uniq_inline_child_org_id").on(table.orgId, table.id),
]);
`;

  const fixtureAccountingNotCrm = `
export const creditNotes = pgTable("credit_notes", {
  orgId: text("org_id").notNull(),
  parentTblId: integer("parent_tbl_id").references(() => parentTbl.id, { onDelete: "cascade" }),
}, (table) => [
  unique("uniq_credit_notes_org_id").on(table.orgId, table.id),
]);
`;

  const badExplicit = parseStaticViolations(fixtureExplicitBad, "fixture/bad.ts", allTenant);
  const badInline = parseStaticViolations(fixtureInlineRef, "fixture/inline.ts", allTenant);
  const badAnnotatedInline = parseStaticViolations(fixtureAnnotatedInlineRef, "fixture/annotated.ts", allTenant);
  const accountingNotCrm = parseStaticViolations(
    fixtureAccountingNotCrm,
    "src/db/schema/accounting/finance-ar-ap.ts",
    new Set([...allTenant, "credit_notes"]),
  );
  const good = parseStaticViolations(fixtureGoodComposite, "fixture/good.ts", allTenant);
  const globalRef = parseStaticViolations(fixtureGlobalRef, "fixture/global.ts", allTenant);
  const crmFile = parseStaticViolations(fixtureCrmFile, "src/db/schema/crm/excluded.ts", allTenant);

  const checks = {
    detects_explicit_single_col_violation: badExplicit.length === 1,
    explicit_violation_table_name_correct: badExplicit[0]?.tableName === "bad_table",
    detects_inline_references_violation: badInline.length === 1,
    inline_violation_table_name_correct: badInline[0]?.tableName === "inline_child",
    detects_return_type_annotated_inline_reference: badAnnotatedInline.length === 1,
    accounting_credit_notes_is_not_excluded_as_crm: accountingNotCrm.length === 1,
    ignores_composite_fk: good.length === 0,
    named_exception_is_recognised:
      constraintException("fk_subscription_purchases_coupon") !== null,
    named_exception_carries_a_reason:
      String(constraintException("fk_subscription_purchases_coupon")).includes("platform promotion"),
    unknown_constraint_is_not_excepted:
      constraintException("fk_subscription_purchases_org") === null,
    exception_is_keyed_on_constraint_not_table:
      constraintException("coupons") === null && constraintException("subscription_purchases") === null,
    coupons_is_not_registered_platform_global:
      !isPlatformGlobal("coupons"),
    empty_reason_would_not_except:
      (() => {
        CONSTRAINT_EXCEPTIONS.set("fk_selftest_blank", "   ");
        const verdict = constraintException("fk_selftest_blank") === null;
        CONSTRAINT_EXCEPTIONS.delete("fk_selftest_blank");
        return verdict;
      })(),
    ignores_global_user_ref: globalRef.length === 0,
    crm_file_path_excluded: crmFile.length === 0,
  };

  // Target resolution. These exist because the fallback chain silently reached the
  // shared remote branch and the report could not say so.
  const LOCAL = "postgres://u@127.0.0.1:5432/scratch_gates_head?sslmode=disable";
  const REMOTE = "postgres://u:pw@ep-orange-mode-a1b2.us-east-2.aws.neon.tech/scratch_boot_a";
  const dedicated = resolveTarget({ TENANT_RELATIONSHIP_DB_URL: LOCAL, DATABASE_URL: REMOTE });
  const fellBack = resolveTarget({ DATABASE_URL: REMOTE });
  const viaDirect = resolveTarget({ DIRECT_DATABASE_URL: REMOTE, DATABASE_URL: LOCAL });
  Object.assign(checks, {
    dedicated_variable_wins_over_fallbacks:
      dedicated?.url === LOCAL && dedicated?.source === "TENANT_RELATIONSHIP_DB_URL",
    fallback_names_the_variable_that_answered: fellBack?.source === "DATABASE_URL",
    direct_url_precedes_database_url: viaDirect?.source === "DIRECT_DATABASE_URL",
    no_variable_set_resolves_to_null: resolveTarget({}) === null,
    remote_via_fallback_is_refused: remoteFallbackRefusal(fellBack, {}) !== null,
    remote_via_fallback_refusal_names_host_and_database:
      String(remoteFallbackRefusal(fellBack, {})).includes(
        "ep-orange-mode-a1b2.us-east-2.aws.neon.tech:5432/scratch_boot_a",
      ),
    refusal_never_prints_the_password: !String(remoteFallbackRefusal(fellBack, {})).includes("pw@"),
    remote_via_dedicated_variable_is_allowed:
      remoteFallbackRefusal({ url: REMOTE, source: "TENANT_RELATIONSHIP_DB_URL" }, {}) === null,
    remote_via_fallback_allowed_on_explicit_opt_in:
      remoteFallbackRefusal(fellBack, { TENANT_RELATIONSHIP_ALLOW_REMOTE: "1" }) === null,
    opt_in_must_be_exactly_one:
      remoteFallbackRefusal(fellBack, { TENANT_RELATIONSHIP_ALLOW_REMOTE: "true" }) !== null,
    loopback_via_fallback_is_allowed:
      remoteFallbackRefusal(resolveTarget({ DATABASE_URL: LOCAL }), {}) === null,
    localhost_by_name_is_loopback: isLoopbackHost("postgres://localhost:5432/x"),
    remote_host_is_not_loopback: !isLoopbackHost(REMOTE),
    unparseable_url_is_not_loopback: !isLoopbackHost("not a url"),
    safe_label_hides_credentials: !safeLabel(REMOTE).includes("pw"),
    safe_label_is_host_port_database:
      safeLabel(LOCAL) === "127.0.0.1:5432/scratch_gates_head",
  });

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

  if (catalogResult?.refused) {
    console.error(`check-tenant-relationships: ${catalogResult.refused}`);
    console.error("");
    console.error("Nothing was measured. A number produced against a database you did not choose is");
    console.error("not evidence, and this gate will not print one.");
    process.exit(2);
  }

  if (catalogResult?.vacuous) {
    console.error(
      `check-tenant-relationships: vacuity guard — the target has only ${catalogResult.tenant_tables} tenant table(s) (expected >= ${MIN_TENANT_TABLES}).`,
    );
    console.error(
      `An unbootstrapped database has no tenant FKs to violate, so "zero actionable" here would prove nothing.`,
    );
    console.error(`Bootstrap it first, or point TENANT_RELATIONSHIP_DB_URL at a bootstrapped database.`);
    process.exit(2);
  }

  if (catalogResult) {
    const { total, actionable, excl_crm, excl_inv, excl_migrated } = catalogResult;
    const excl_named = catalogResult.excl_named ?? [];
    const excl_total = excl_crm.length + excl_inv.length + excl_migrated.length + excl_named.length;

    console.log(`Mode                   pg_catalog (${catalogResult.target ?? "unknown target"})`);
    console.log(`Target                 ${catalogResult.targetLabel ?? "unknown"}  (from ${catalogResult.targetSource ?? "unknown"}${catalogResult.targetRewritten ? ", rewritten off neondb" : ""})`);
    console.log(`Ledger rows on target  ${catalogResult.midBootstrap ?? "none found"} of ${JOURNAL_ENTRY_COUNT} journal entries`);
    console.log(`Total single-col FKs   ${total}`);
    console.log(`EXCL: CRM              ${excl_crm.length} (child or parent is a CRM table — AR-02 scope exclusion)`);
    console.log(`EXCL: Inventory        ${excl_inv.length} (child or parent is Inventory — AR-02 scope exclusion)`);
    console.log(`EXCL: platform-global  ${excl_migrated.length} (child or parent is a registered platform-global table)`);
    console.log(`EXCL: named exception  ${excl_named.length} (constraint-specific, reasons below)`);
    console.log(`Actionable             ${actionable.length}`);
    console.log("");
    for (const r of excl_named) {
      console.log(`NAMED EXCEPTION  ${r.child_schema}.${r.child} → ${r.parent_schema}.${r.parent}  (${r.constraint_name})`);
      console.log(`  ${r.reason}`);
      console.log("");
    }

    if (typeof catalogResult.midBootstrap === "number" && catalogResult.midBootstrap < JOURNAL_ENTRY_COUNT) {
      console.error(
        `
TARGET IS MID-BOOTSTRAP — this number is not release evidence.
` +
        `  The target's migration ledger holds ${catalogResult.midBootstrap} of ${JOURNAL_ENTRY_COUNT} journal entries,
` +
        `  so the chain is only partly present and constraints later in it have not been created yet.
` +
        `  Point TENANT_RELATIONSHIP_DB_URL at a fully bootstrapped database, or re-run once the replay finishes.`,
      );
      // Exit 2 (this script's existing "cannot run" code), NOT 0 or 1. Mid-bootstrap
      // means constraints later in the chain have not been created yet, so BOTH a pass
      // and a fail are meaningless -- the answer is "cannot determine", and saying so
      // is the only honest option. Exiting 1 here made a stale target look identical to
      // a real regression (627 "violations" that were entirely an artefact of the
      // target sitting at 573 of 667), which is how a gate teaches people to ignore it.
      // Exiting 0 would be worse: a real violation could then hide behind a stale target.
      process.exit(2);
    }
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

  const symbolToSql = buildSymbolToSqlMap(walkTs(SCHEMA_DIR));
  const violations = [];
  for (const f of files)
    violations.push(...parseStaticViolations(readFileSync(f, "utf8"), f, allTenantTables, symbolToSql));

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
