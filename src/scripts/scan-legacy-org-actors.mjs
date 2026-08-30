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

const HRMS_PHASE1_BARREL = "hrms-phase1-sql-managed.ts";

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
  const tableDecl = /export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*pgTable\(/g;

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
        if (/pgTable/.test(line) || /^\s*\{/.test(line)) break;
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
    entries.push(...parseFile(filePath));
  }
  return entries;
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

function printSummary(entries, totals) {
  console.log("\nLegacy Organization-Actor Scan");
  console.log("=".repeat(54));
  console.log(`Organizational (to migrate):   ${totals.byClass.organizational}`);
  console.log(`Bridge (person↔account links): ${totals.byClass.bridge}`);
  console.log(`Authentication (identity):     ${totals.byClass.authentication}`);
  console.log(`Unknown (manual review):       ${totals.byClass.unknown}`);
  console.log(`Total user_id FKs scanned:     ${entries.length}`);
  console.log("\nBy module (organizational count):");
  const modules = Object.entries(totals.byModule).sort((a, b) => b[1].organizational - a[1].organizational);
  for (const [mod, counts] of modules) {
    if (counts.organizational > 0 || counts.unknown > 0)
      console.log(`  ${mod.padEnd(22)} org=${counts.organizational}  unknown=${counts.unknown}`);
  }
  console.log("");
}

function selfTest(entries) {
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

  expectClass("hr_effective_dated_changes", "approved_by", "organizational");
  expectClass("hr_effective_dated_changes", "created_by", "organizational");
  expectClass("hr_reporting_lines", "created_by", "organizational");
  expectClass("organization_members", "user_id", "bridge");
  expectClass("hr_people", "user_id", "bridge");
  expectClass("organization_people", "user_id", "bridge");
  expectClass("user_sessions", "user_id", "authentication");
  expectClass("accounts", "user_id", "authentication");

  if (entries.length < 50) {
    failures.push(
      `Suspiciously few results: ${entries.length} — scanner may be broken (expected ≥50)`,
    );
  }

  if (failures.length > 0) {
    console.error("\nSELF-TEST FAILURES:");
    for (const f of failures) console.error(`  ✗  ${f}`);
    return false;
  }
  console.log(`Self-test passed (${entries.length} total FKs found, all known examples verified).`);
  return true;
}

const args = process.argv.slice(2);

const entries = scan();
const totals = summarize(entries);

if (args.includes("--self-test")) {
  printSummary(entries, totals);
  process.exitCode = selfTest(entries) ? 0 : 1;
} else if (args.includes("--emit-baseline")) {
  const payload = { capturedAt: new Date().toISOString(), totals, entries };
  mkdirSync(join(BACKEND_ROOT, "data"), { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2));
  printSummary(entries, totals);
  console.log(`Baseline written to ${BASELINE_PATH}`);
} else if (args.includes("--check")) {
  if (!existsSync(BASELINE_PATH)) {
    console.error(`Baseline file not found: ${BASELINE_PATH}`);
    console.error("Run --emit-baseline first.");
    process.exitCode = 2;
  } else {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    const baselineCount = baseline.totals.byClass.organizational;
    const currentCount = totals.byClass.organizational;
    printSummary(entries, totals);
    if (currentCount > baselineCount) {
      console.error(
        `RATCHET VIOLATION: organizational legacy-actor count rose from ${baselineCount} to ${currentCount}.`,
      );
      console.error("New organizational users.id FKs were added. Migrate them to OrganizationActor first.");
      process.exitCode = 1;
    } else {
      const delta = baselineCount - currentCount;
      console.log(
        `Ratchet OK: ${currentCount}/${baselineCount} remaining (${delta} migrated since baseline).`,
      );
    }
  }
} else if (args.includes("--catalog")) {
  await reportCatalogGap(entries);
} else {
  printSummary(entries, totals);
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
      SELECT t.relname AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN unnest(c.conkey) k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass
      ORDER BY 1, 2
    `;
    const known = new Set(sourceEntries.map((e) => `${e.table}.${e.column}`));
    const invisible = [...new Set(rows.map((r) => `${r.tbl}.${r.col}`))].filter(
      (key) => !known.has(key),
    );

    console.log(`pg_catalog users.id foreign keys : ${rows.length}`);
    console.log(`visible to the source scan       : ${sourceEntries.length}`);
    console.log(`INVISIBLE to the ratchet         : ${invisible.length}`);
    for (const key of invisible) console.log(`  ${key}`);
  } finally {
    await sql.end();
  }
}
