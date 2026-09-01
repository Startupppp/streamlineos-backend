/**
 * scan-legacy-org-actors.mjs
 *
 * Enumerates every column that references users.id in an ORGANIZATIONAL role
 * (assignee, approver, author, creator, owner, etc.) across all Drizzle schema
 * files. Classifies them as:
 *
 *   organizational — actor references (created_by, approved_by, etc.)
 *   bridge         — person-to-account links (user_id on membership tables)
 *   authentication — identity infrastructure (user_id on auth tables)
 *   unknown        — needs manual review
 *
 * ACTIONABLE = organizational that are NOT allowlisted as historical-display-only
 * and NOT in an excluded module (CRM, Inventory). The allowlist lives beside this
 * script in actor-classification-allowlist.json. Every entry is validated for
 * staleness at startup — an entry referencing a column no longer in the Drizzle
 * schema or KNOWN_RAW_SQL_ACTOR_FKS causes an immediate hard failure so allowlist
 * drift is caught before CI can pass on a false zero.
 *
 * Usage:
 *   node src/scripts/scan-legacy-org-actors.mjs               # print summary
 *   node src/scripts/scan-legacy-org-actors.mjs --emit-baseline  # write JSON
 *   node src/scripts/scan-legacy-org-actors.mjs --check          # ratchet gate
 *   node src/scripts/scan-legacy-org-actors.mjs --self-test      # verify scanner
 *
 * Exit codes: 0 clean · 1 violation / self-test failure · 2 baseline missing
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const SCHEMA_DIR = join(BACKEND_ROOT, "src", "db", "schema");
const BASELINE_PATH = join(BACKEND_ROOT, "data", "legacy-actor-baseline.json");
const ALLOWLIST_PATH = join(SCRIPT_DIR, "actor-classification-allowlist.json");

const HRMS_PHASE1_BARREL = "hrms-phase1-sql-managed.ts";

/**
 * Modules excluded from the ACTIONABLE count because they are out of scope for
 * the current actor-contraction program (CRM and Inventory have separate tracks).
 * These entries are still scanned and appear in the organisational total; they
 * are simply not counted against the ACTIONABLE gate.
 */
const EXCLUDED_MODULES_FROM_SCOPE = new Set(["crm", "inventory"]);

/**
 * Two users.id FKs that are structurally global and must never be counted in
 * the organizational ratchet:
 *   organizations.purge_scheduled_by — platform-admin only; schedules a GDPR
 *     erasure job; the table has no org_id so no membership lookup is possible.
 *   subprocessors.updated_by — platform-legal record (DPA sub-processor list);
 *     no org_id, updated by Anthropic ops staff, not by org members.
 */
const EXCLUDED_GLOBAL_FKS = new Set([
  "organizations.purge_scheduled_by",
  "subprocessors.updated_by",
  "hrms_migration_profiles.changed_by_platform_user_id",
  // Retired by 0916_support_remaining_actor_drop.sql.  The bootstrap
  // migration (0000) remains in the repository for chain reproducibility, so
  // exclude these historical users FKs from the live actor inventory.
  "support_tickets.assignee_id",
  "support_tickets.created_by",
]);

/**
 * users.id FKs that exist ONLY in the live database via raw-SQL migrations and
 * have no matching Drizzle pgTable / schema.table() declaration. The source-file
 * scan is structurally blind to them; this list is the canonical supplement so
 * the ratchet total matches reality without requiring a DB connection in CI.
 *
 * Maintain this list whenever a raw-SQL migration adds or removes a users.id FK.
 * Validate with: node src/scripts/scan-legacy-org-actors.mjs --catalog
 *
 * Groups: accounting (ap/ar/bank/gl) · crm commissions · hr extras ·
 *         payroll extras · inventory advanced tables
 */
const KNOWN_RAW_SQL_ACTOR_FKS = [
  { table: "ap_allocations", column: "created_by", module: "accounting" },
  { table: "ap_documents", column: "created_by", module: "accounting" },
  { table: "ap_documents", column: "posted_by", module: "accounting" },
  { table: "ap_payments", column: "created_by", module: "accounting" },
  { table: "ar_allocations", column: "created_by", module: "accounting" },
  { table: "ar_documents", column: "created_by", module: "accounting" },
  { table: "ar_documents", column: "posted_by", module: "accounting" },
  { table: "ar_receipts", column: "created_by", module: "accounting" },
  { table: "bank_matches", column: "matched_by", module: "accounting" },
  { table: "bank_statements", column: "imported_by", module: "accounting" },
  { table: "bank_statements", column: "reconciled_by", module: "accounting" },
  { table: "gl_books", column: "created_by", module: "accounting" },
  { table: "gl_document_attachments", column: "uploaded_by", module: "accounting" },
  { table: "gl_fx_rates", column: "created_by", module: "accounting" },
  { table: "gl_journals", column: "posted_by_user_id", module: "accounting" },
  { table: "gl_parties", column: "created_by", module: "accounting" },
  { table: "gl_periods", column: "locked_by", module: "accounting" },
  { table: "crm_commission_accrual_parts", column: "user_id", module: "crm" },
  { table: "crm_commission_accrual_snapshots", column: "user_id", module: "crm" },
  { table: "crm_commission_assignments", column: "user_id", module: "crm" },
  { table: "crm_commission_earnings", column: "approved_by", module: "crm" },
  { table: "crm_commission_earnings", column: "user_id", module: "crm" },
  { table: "crm_commission_plan_versions", column: "created_by", module: "crm" },
  { table: "crm_commission_plans", column: "created_by", module: "crm" },
  { table: "learning_paths", column: "created_by", module: "hr" },
  { table: "expense_export_jobs", column: "requested_by", module: "payroll" },
  { table: "inv_ai_feedback", column: "user_id", module: "inventory" },
  { table: "inv_ai_insights", column: "acknowledged_by", module: "inventory" },
  { table: "inv_allocation_overrides", column: "actor_user_id", module: "inventory" },
  { table: "inv_audit_export_jobs", column: "created_by", module: "inventory" },
  { table: "inv_channel_snapshot_diffs", column: "resolved_by", module: "inventory" },
  { table: "inv_compliance_documents", column: "created_by", module: "inventory" },
  { table: "inv_customer_return_lines", column: "inspected_by", module: "inventory" },
  { table: "inv_customer_shelf_life_rules", column: "created_by", module: "inventory" },
  { table: "inv_demand_forecasts", column: "generated_by", module: "inventory" },
  { table: "inv_grns", column: "posted_by", module: "inventory" },
  { table: "inv_inspection_plan_versions", column: "created_by", module: "inventory" },
  { table: "inv_inspection_plans", column: "created_by", module: "inventory" },
  { table: "inv_landed_cost_vouchers", column: "applied_by", module: "inventory" },
  { table: "inv_landed_cost_vouchers", column: "created_by", module: "inventory" },
  { table: "inv_pick_list_lines", column: "exception_owner_id", module: "inventory" },
  { table: "inv_pick_list_lines", column: "exception_reported_by", module: "inventory" },
  { table: "inv_pick_list_lines", column: "exception_resolved_by", module: "inventory" },
  { table: "inv_pick_lists", column: "assigned_to", module: "inventory" },
  { table: "inv_proposal_overrides", column: "created_by", module: "inventory" },
  { table: "inv_putaway_tasks", column: "assigned_to", module: "inventory" },
  { table: "inv_putaway_tasks", column: "created_by", module: "inventory" },
];

const BRIDGE_TABLES = new Set([
  "organization_members",
  "hr_people",
  "organization_people",
  "workers",
]);

const AUTH_TABLES = new Set([
  "users",
  "accounts",
  "user_sessions",
  "mfa_backup_codes",
  "magic_link_tokens",
  "email_otp_codes",
  "verification_tokens",
  "password_resets",
  "refresh_tokens",
  "webauthn_credentials",
  "passkeys",
]);

function classifyColumn(columnDb, tableDb) {
  if (AUTH_TABLES.has(tableDb)) return "authentication";
  if (BRIDGE_TABLES.has(tableDb)) return "bridge";
  return "organizational";
}

function moduleFromFile(filePath) {
  const rel = relative(SCHEMA_DIR, filePath);
  const parts = rel.split(sep);
  return parts.length === 1 ? "common" : parts[0];
}

function* walkSchemaFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      yield* walkSchemaFiles(join(dir, entry.name));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts") &&
      entry.name !== HRMS_PHASE1_BARREL &&
      entry.name !== "index.ts"
    ) {
      yield join(dir, entry.name);
    }
  }
}

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

const USERS_ID_REF = /\.references\s*\(\s*\(\s*\)\s*=>\s*users\.id/g;

function parseFile(filePath) {
  const src = readFileSync(filePath, "utf8");
  if (!src.includes("users.id")) return [];

  const module = moduleFromFile(filePath);
  const results = [];
  const tableDecl = /export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:pgTable|[A-Za-z_$][A-Za-z0-9_$]*\.table)\(/g;

  for (const tableMatch of src.matchAll(tableDecl)) {
    const open = tableMatch.index + tableMatch[0].length - 1;
    const body = callBody(src, open);
    if (!body) continue;

    const nameMatch = body.match(/^\(\s*\n?\s*["']([^"']+)["']/s);
    if (!nameMatch) continue;
    const tableDb = nameMatch[1];

    for (const refMatch of body.matchAll(USERS_ID_REF)) {
      const refPos = refMatch.index;
      const before = body.slice(0, refPos);
      const lines = before.split("\n");

      let jsName = null;
      let dbName = null;

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const col = line.match(
          /^\s{2,8}([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(?:text|uuid|integer|serial|boolean|timestamp|date|varchar|char|numeric|decimal|real|double|bigint|smallint|jsonb|json|pgEnum)\s*\(\s*["']([^"']+)["']/,
        );
        if (col) {
          jsName = col[1];
          dbName = col[2];
          break;
        }
        if (/(?:pgTable|\w+\.table)\(/.test(line) || /^\s*\{/.test(line)) break;
      }

      if (!jsName || !dbName) continue;

      results.push({
        table: tableDb,
        column: dbName,
        jsName,
        class: classifyColumn(dbName, tableDb),
        module,
        file: relative(BACKEND_ROOT, filePath).replace(/\\/g, "/"),
      });
    }
  }

  return results;
}

function scan() {
  const entries = [];
  for (const filePath of walkSchemaFiles(SCHEMA_DIR)) {
    for (const entry of parseFile(filePath)) {
      if (!EXCLUDED_GLOBAL_FKS.has(`${entry.table}.${entry.column}`))
        entries.push(entry);
    }
  }
  for (const { table, column, module } of KNOWN_RAW_SQL_ACTOR_FKS) {
    if (!EXCLUDED_GLOBAL_FKS.has(`${table}.${column}`))
      entries.push({ table, column, jsName: column, class: "organizational", module, file: "raw-sql-migration" });
  }
  return entries;
}

/**
 * Load the allowlist from actor-classification-allowlist.json.
 * Returns a Set of "table.column" keys classified as historical-display-only.
 * Returns an empty Set if the file does not exist.
 */
function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return new Set();
  const data = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
  return new Set((data.entries ?? []).map((e) => `${e.table}.${e.column}`));
}

/**
 * Validate that every allowlist entry references a column that actually appears
 * in the scan (Drizzle-source or KNOWN_RAW_SQL_ACTOR_FKS). Returns an array of
 * stale keys (present in allowlist but absent from scan). A non-empty result is
 * a hard failure: an allowlist entry that no longer exists is silently hiding a
 * regression — it must be removed.
 */
function validateAllowlist(allEntries, allowlistSet) {
  const knownKeys = new Set(allEntries.map((e) => `${e.table}.${e.column}`));
  const stale = [];
  for (const key of allowlistSet) {
    if (!knownKeys.has(key)) stale.push(key);
  }
  return stale;
}

/**
 * ACTIONABLE entries: organizational FKs that are NOT:
 *   - in an excluded module (CRM / Inventory — separate program track)
 *   - in the allowlist (confirmed historical-display-only)
 * These are the authority-bearing relationships that must migrate to
 * organization_members.id.
 */
function computeActionable(allEntries, allowlistSet) {
  return allEntries.filter(
    (e) =>
      e.class === "organizational" &&
      !EXCLUDED_MODULES_FROM_SCOPE.has(e.module) &&
      !allowlistSet.has(`${e.table}.${e.column}`),
  );
}

function summarize(entries) {
  const byClass = { organizational: 0, bridge: 0, authentication: 0, unknown: 0 };
  const byModule = {};
  for (const e of entries) {
    byClass[e.class] = (byClass[e.class] ?? 0) + 1;
    if (!byModule[e.module]) byModule[e.module] = { organizational: 0, bridge: 0, authentication: 0, unknown: 0 };
    byModule[e.module][e.class] = (byModule[e.module][e.class] ?? 0) + 1;
  }
  return { byClass, byModule };
}

function printSummary(entries, totals, actionableEntries) {
  console.log("\nLegacy Organization-Actor Scan");
  console.log("=".repeat(54));
  console.log(`Organizational (legacy total):  ${totals.byClass.organizational}`);
  console.log(`  – CRM/Inventory (out of scope): ${entries.filter((e) => e.class === "organizational" && EXCLUDED_MODULES_FROM_SCOPE.has(e.module)).length}`);
  console.log(`  – Allowlisted display-only:     ${totals.byClass.organizational - entries.filter((e) => e.class === "organizational" && EXCLUDED_MODULES_FROM_SCOPE.has(e.module)).length - actionableEntries.length}`);
  console.log(`  – ACTIONABLE (must migrate):    ${actionableEntries.length}`);
  console.log(`Bridge (person↔account links): ${totals.byClass.bridge}`);
  console.log(`Authentication (identity):     ${totals.byClass.authentication}`);
  console.log(`Unknown (manual review):       ${totals.byClass.unknown}`);
  console.log(`Total user_id FKs scanned:     ${entries.length}`);
  console.log("\nBy module (actionable count):");
  const byModuleActionable = {};
  for (const e of actionableEntries) {
    byModuleActionable[e.module] = (byModuleActionable[e.module] ?? 0) + 1;
  }
  const modules = Object.entries(byModuleActionable).sort((a, b) => b[1] - a[1]);
  for (const [mod, count] of modules) {
    console.log(`  ${mod.padEnd(22)} actionable=${count}`);
  }
  console.log("");
}

function selfTest(entries, allowlistSet) {
  const failures = [];

  const find = (table, column) =>
    entries.find((e) => e.table === table && e.column === column);

  const expectClass = (table, column, expected) => {
    const entry = find(table, column);
    if (!entry) {
      failures.push(`MISSING  ${table}.${column} (expected class=${expected})`);
      return;
    }
    if (entry.class !== expected)
      failures.push(
        `WRONG CLASS  ${table}.${column}: got ${entry.class}, expected ${expected}`,
      );
  };

  expectClass("hr_cases", "assigned_to", "organizational");
  expectClass("hr_wellness_checkins", "user_id", "organizational");
  expectClass("hr_reporting_lines", "created_by", "organizational");
  expectClass("organization_members", "user_id", "bridge");
  expectClass("hr_people", "user_id", "bridge");
  expectClass("organization_people", "user_id", "bridge");
  expectClass("user_sessions", "user_id", "authentication");
  expectClass("accounts", "user_id", "authentication");

  expectClass("tickets", "assignee_id", "organizational");
  expectClass("tickets", "reporter_id", "organizational");
  expectClass("ticket_comment_mentions", "mentioned_user_id", "organizational");
  expectClass("bugs", "created_by", "organizational");
  expectClass("projects", "manager_id", "organizational");

  expectClass("ap_documents", "posted_by", "organizational");
  expectClass("crm_commission_plans", "created_by", "organizational");
  expectClass("inv_pick_lists", "assigned_to", "organizational");

  if (entries.length < 600) {
    failures.push(
      `Suspiciously few results: ${entries.length} — scanner may be broken (expected ≥600; build schema tables may be missed)`,
    );
  }

  const actionableEntries = computeActionable(entries, allowlistSet);

  const expectActionable = (table, column) => {
    const inActionable = actionableEntries.some((e) => e.table === table && e.column === column);
    if (!inActionable)
      failures.push(`ACTIONABLE MISS  ${table}.${column} — should be ACTIONABLE (authority-bearing, not allowlisted) but is not`);
  };

  const expectNotActionable = (table, column) => {
    const inActionable = actionableEntries.some((e) => e.table === table && e.column === column);
    if (inActionable)
      failures.push(`FALSE ACTIONABLE  ${table}.${column} — should NOT be ACTIONABLE (allowlisted as display-only) but is`);
  };

  expectActionable("fin_approval_policies", "approver_user_id");
  expectActionable("journal_entries", "created_by");
  expectActionable("projects", "manager_id");
  expectNotActionable("support_tickets", "assignee_id");
  expectNotActionable("support_tickets", "created_by");
  expectActionable("kb_spaces", "created_by_id");

  expectNotActionable("fin_approval_requests", "requested_by");
  expectNotActionable("journal_entries", "approved_by");
  expectNotActionable("enterprise_quotes", "approver_id");
  expectNotActionable("support_ticket_activity", "user_id");
  expectNotActionable("hr_reporting_lines", "created_by");

  const staleTest = validateAllowlist(entries, new Set(["__no_such_table__.__no_such_col__"]));
  if (staleTest.length !== 1 || staleTest[0] !== "__no_such_table__.__no_such_col__") {
    failures.push("STALE-ALLOWLIST DETECTION failed — validateAllowlist did not detect a synthetic stale entry");
  }

  if (failures.length > 0) {
    console.error("\nSELF-TEST FAILURES:");
    for (const f of failures) console.error(`  ✗  ${f}`);
    return false;
  }
  console.log(
    `Self-test passed (${entries.length} total FKs found, ${actionableEntries.length} actionable, all known examples verified).`,
  );
  return true;
}

const args = process.argv.slice(2);

const entries = scan();
const totals = summarize(entries);

const allowlistSet = loadAllowlist();

const staleKeys = validateAllowlist(entries, allowlistSet);
if (staleKeys.length > 0) {
  console.error("ALLOWLIST STALE — these entries reference columns no longer in the scan:");
  for (const key of staleKeys) console.error(`  stale: ${key}`);
  console.error("Remove stale entries from actor-classification-allowlist.json before proceeding.");
  process.exit(1);
}

const actionableEntries = computeActionable(entries, allowlistSet);

if (args.includes("--self-test")) {
  printSummary(entries, totals, actionableEntries);
  process.exitCode = selfTest(entries, allowlistSet) ? 0 : 1;
} else if (args.includes("--emit-baseline")) {
  const payload = {
    capturedAt: new Date().toISOString(),
    totals,
    actionableCount: actionableEntries.length,
    entries,
  };
  mkdirSync(join(BACKEND_ROOT, "data"), { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2));
  printSummary(entries, totals, actionableEntries);
  console.log(`Baseline written to ${BASELINE_PATH}`);
} else if (args.includes("--check")) {
  if (!existsSync(BASELINE_PATH)) {
    console.error(`Baseline file not found: ${BASELINE_PATH}`);
    console.error("Run --emit-baseline first.");
    process.exitCode = 2;
  } else {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    if (typeof baseline.actionableCount !== "number") {
      console.error("Baseline predates the ACTIONABLE gate — re-run --emit-baseline to regenerate.");
      process.exitCode = 2;
    } else {
      const baselineActionable = baseline.actionableCount;
      const currentActionable = actionableEntries.length;
      printSummary(entries, totals, actionableEntries);
      if (currentActionable > baselineActionable) {
        console.error(
          `RATCHET VIOLATION: ACTIONABLE legacy-actor count rose from ${baselineActionable} to ${currentActionable}.`,
        );
        console.error("New authority-bearing users.id FKs were added. Migrate them to organization_members.id first,");
        console.error("or classify them as display-only in actor-classification-allowlist.json with a justification.");
        process.exitCode = 1;
      } else {
        const delta = baselineActionable - currentActionable;
        console.log(
          `Ratchet OK: ${currentActionable}/${baselineActionable} actionable remaining (${delta} migrated since baseline).`,
        );
      }
    }
  }
} else if (args.includes("--catalog")) {
  await reportCatalogGap(entries);
} else {
  printSummary(entries, totals, actionableEntries);
}

/**
 * The source scan is the CI ratchet because CI has no database, but it can only
 * see tables that have a Drizzle declaration. Tables created by raw SQL — the
 * accounting ap_/ar_/bank_ family and the CRM commission set among them — carry
 * organizational users.id references the ratchet is structurally blind to, so
 * the source count is a floor rather than the migration burden. This mode names
 * the difference against pg_catalog so it is a known quantity, not a surprise.
 */
async function reportCatalogGap(sourceEntries) {
  const { default: postgres } = await import("postgres");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set; --catalog needs a reachable database.");
    process.exitCode = 2;
    return;
  }

  const sql = postgres(url, { prepare: false, max: 1, ssl: "require", onnotice: () => {} });
  try {
    const rows = await sql`
      SELECT DISTINCT t.relname AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN unnest(c.conkey) k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass
      ORDER BY 1, 2
    `;
    const catalogKeys = new Set(rows.map((r) => `${r.tbl}.${r.col}`));
    const sourceKeys = new Set(sourceEntries.filter((e) => e.file !== "raw-sql-migration").map((e) => `${e.table}.${e.column}`));
    const staticRawKeys = new Set(KNOWN_RAW_SQL_ACTOR_FKS.map((e) => `${e.table}.${e.column}`));
    const allKnownKeys = new Set([...sourceKeys, ...staticRawKeys, ...EXCLUDED_GLOBAL_FKS]);

    const stillInvisible = [...catalogKeys].filter((key) => !allKnownKeys.has(key));
    const sourceOnly = [...sourceKeys].filter((key) => !catalogKeys.has(key));
    const staticNotInCatalog = [...staticRawKeys].filter((key) => !catalogKeys.has(key));

    console.log(`pg_catalog users.id foreign keys     : ${catalogKeys.size}`);
    console.log(`visible to the Drizzle source scan   : ${sourceKeys.size}`);
    console.log(`covered by KNOWN_RAW_SQL_ACTOR_FKS   : ${staticRawKeys.size}`);
    console.log(`excluded as global (non-org) FKs     : ${EXCLUDED_GLOBAL_FKS.size}`);
    console.log(`STILL INVISIBLE (needs list update)  : ${stillInvisible.length}`);
    console.log(`source-only (Drizzle, no DB FK yet)  : ${sourceOnly.length}`);
    console.log(`static list entries not in catalog   : ${staticNotInCatalog.length}`);
    if (stillInvisible.length > 0) {
      console.log("\nStill invisible — add to KNOWN_RAW_SQL_ACTOR_FKS or EXCLUDED_GLOBAL_FKS:");
      for (const key of stillInvisible) console.log(`  ${key}`);
    }
    if (staticNotInCatalog.length > 0) {
      console.log("\nIn static list but not in catalog — FK may have been contracted:");
      for (const key of staticNotInCatalog) console.log(`  ${key}`);
    }
  } finally {
    await sql.end();
  }
}
