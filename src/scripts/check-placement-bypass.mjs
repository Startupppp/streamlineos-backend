/**
 * Enumerates every path that reaches the database outside a tenant transaction
 * and fails the build on any one that is not on the allowlist with a reason.
 *
 * Bypass classes detected:
 *   @NoTenantTransaction() on a handler or controller class
 *   runOutsideTenantContext( call sites
 *   withIdentity( call sites
 *   src/modules/cron/** files that access this.db without forEachOrg / runIn*TenantTransaction
 *   registerAfterCommit( callbacks whose body accesses this.db without a transaction wrapper
 *
 * Usage:  node src/scripts/check-placement-bypass.mjs [--self-test] [--root=<dir>]
 * Exit:   0 clean · 1 a bypass not on the allowlist · 2 broken pattern
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const SELF_TEST = args.includes("--self-test");
const ROOT_ARG = args.find((a) => a.startsWith("--root="))?.slice("--root=".length);

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_SRC = join(BACKEND_ROOT, "src");
const SCAN_ROOT = ROOT_ARG ? resolve(ROOT_ARG) : DEFAULT_SRC;
const EXTERNAL_ROOT = ROOT_ARG !== undefined;

const SPEC_RE = /\.(spec|e2e-spec)\.ts$/;
const MIN_BYPASS_SITES = 30;

// -- allowlists --------------------------------------------------------------

export const NO_TENANT_TRANSACTION_ALLOWLIST = new Map([
  [
    "src/modules/ai/**",
    "SSE streaming handlers: pipeTextStreamToResponse returns before the stream ends, so holding a request transaction open would commit while tools still run",
  ],
  [
    "src/modules/notifications/notifications.controller.ts",
    "SSE notification stream that consumes a short-lived token and never touches the database; no tenant context is needed",
  ],
  [
    "src/modules/organization/core/organization.controller.ts",
    "identity-scoped organization discovery and switching; each handler opens its own withIdentity or runInTenantTransaction before touching the database",
  ],
]);

export const CONTEXT_EXIT_ALLOWLIST = new Map([
  [
    "src/common/audit/audit.service.ts",
    "audit log dispatched outside the request transaction so a rolled-back mutation does not suppress the audit entry; write() re-opens withTenant when orgId is known",
  ],
  [
    "src/common/region/placement-lookup.ts",
    "placement is a control-plane read that runs before any tenant is known and must not be tied to a caller's tenant connection in a multi-region deployment",
  ],
  [
    "src/common/tenant/run-in-tenant-transaction.ts",
    "runInNewTenantTransaction implementation: deliberately escapes any ambient context before opening a fresh isolated tenant transaction",
  ],
  [
    "src/modules/crm/import/import-pump.ts",
    "import pump escapes the HTTP request transaction so each workflow step can open its own tenant transaction and steps are safe to replay on retry",
  ],
  [
    "src/modules/organization/setup/org-setup.service.ts",
    "post-setup work fires after the setup transaction commits via setImmediate; running outside the ambient context is the design",
  ],
  [
    "src/modules/organization/core/org-membership.service.ts",
    "exits the ambient admin transaction before opening a user-identity-scoped one so app.user_id cannot widen later RLS reads in the enclosing request",
  ],
]);

export const WITH_IDENTITY_ALLOWLIST = new Map([
  [
    "src/common/auth/jwt-auth.guard.ts",
    "pre-tenant: reads organization memberships to determine which org the request targets; org context is being established, not yet known",
  ],
  [
    "src/modules/users/users.service.ts",
    "pre-tenant: membership count for plan enforcement during sign-in; org context is not yet established",
  ],
  [
    "src/modules/auth/auth-tokens.service.ts",
    "pre-tenant token refresh and session resumption; the org context is being derived from the token, not yet known",
  ],
  [
    "src/modules/organization/core/account-organization-index.service.ts",
    "the account-to-organization discovery projection answers which organizations an account may enter, so it necessarily runs before one is chosen; its RLS policy admits rows by app.user_id and a read on the pool would silently return none",
  ],
  [
    "src/modules/organization/setup/org-setup.service.ts",
    "creates the first org membership under user identity, before the new org's tenant context exists",
  ],
  [
    "src/modules/organization/core/org-lifecycle.service.ts",
    "org listing, switching, and restoration run under user identity before the target org's tenant context is known",
  ],
  [
    "src/modules/organization/core/org-membership.service.ts",
    "membership switch reads under user identity to exit the ambient admin transaction before the switch completes",
  ],
  [
    "src/modules/organization/core/org-profile.service.ts",
    "lists all orgs a user belongs to, which is a cross-org identity read that cannot run under a single org's tenant context",
  ],
]);

export const CRON_BYPASS_ALLOWLIST = new Map([
  [
    "src/modules/cron/cron-org-purge-worker.service.ts",
    "purge worker selects from the global organizations table (no RLS policy) using FOR UPDATE SKIP LOCKED; the only cron service that must run without a per-org tenant GUC",
  ],
]);

export const AFTER_COMMIT_DB_ALLOWLIST = new Map([]);

// -- helpers -----------------------------------------------------------------

export function balanced(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return null;
}

function toRelPath(absPath) {
  return relative(BACKEND_ROOT, absPath).replace(/\\/g, "/");
}

export function matchesPattern(filePath, pattern) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(prefix + "/");
  }
  return filePath === pattern;
}

export function allowlistReason(filePath, allowlist) {
  for (const [pattern, reason] of allowlist) {
    if (matchesPattern(filePath, pattern)) return reason;
  }
  return null;
}

function validateAllowlists() {
  for (const [kind, list] of [
    ["no-tenant-transaction", NO_TENANT_TRANSACTION_ALLOWLIST],
    ["context-exit", CONTEXT_EXIT_ALLOWLIST],
    ["with-identity", WITH_IDENTITY_ALLOWLIST],
    ["cron-bypass", CRON_BYPASS_ALLOWLIST],
    ["after-commit-db", AFTER_COMMIT_DB_ALLOWLIST],
  ]) {
    for (const [pattern, reason] of list) {
      if (!reason || !reason.trim()) {
        process.stderr.write(`BROKEN ALLOWLIST: ${kind} entry "${pattern}" has no reason\n`);
        process.exit(2);
      }
    }
  }
}

function resolveAllowlist(finding) {
  if (finding.kind === "no-tenant-transaction")
    return allowlistReason(finding.file, NO_TENANT_TRANSACTION_ALLOWLIST);
  if (finding.kind === "context-exit")
    return allowlistReason(finding.file, CONTEXT_EXIT_ALLOWLIST);
  if (finding.kind === "with-identity")
    return allowlistReason(finding.file, WITH_IDENTITY_ALLOWLIST);
  if (finding.kind === "cron-bypass")
    return allowlistReason(finding.file, CRON_BYPASS_ALLOWLIST);
  if (finding.kind === "after-commit-db")
    return allowlistReason(finding.file, AFTER_COMMIT_DB_ALLOWLIST);
  return null;
}

// -- analysis ----------------------------------------------------------------

export function findAnnotationSites(src, filePath) {
  const lines = src.split("\n");
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith("//") || t.startsWith("*")) continue;
    if (lines[i].includes("@NoTenantTransaction()"))
      results.push({ file: filePath, line: i + 1, kind: "no-tenant-transaction" });
  }
  return results;
}

export function findContextExitSites(src, filePath) {
  const lines = src.split("\n");
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith("//") || t.startsWith("*")) continue;
    if (lines[i].includes("runOutsideTenantContext("))
      results.push({ file: filePath, line: i + 1, kind: "context-exit" });
  }
  return results;
}

export function findIdentitySites(src, filePath) {
  const lines = src.split("\n");
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith("//") || t.startsWith("*")) continue;
    if (lines[i].includes("withIdentity("))
      results.push({ file: filePath, line: i + 1, kind: "with-identity" });
  }
  return results;
}

export function isCronBypass(src) {
  return /\bthis\.db\b/.test(src) && !/forEachOrg|runIn(?:New)?TenantTransaction/.test(src);
}

export function findAfterCommitDbSites(src, filePath) {
  const needle = "registerAfterCommit(";
  const results = [];
  let idx = 0;

  while (true) {
    const pos = src.indexOf(needle, idx);
    if (pos === -1) break;

    const line = src.slice(0, pos).split("\n").length;
    const body = balanced(src, pos + needle.length - 1);

    if (body && /\bthis\.db\b/.test(body) && !/runIn(?:New)?TenantTransaction|withTenant\b/.test(body))
      results.push({ file: filePath, line, kind: "after-commit-db" });

    idx = pos + needle.length;
  }

  return results;
}

// -- self-test ---------------------------------------------------------------

if (SELF_TEST) {
  const aiFile = "src/modules/ai/core/controllers/some-ai.controller.ts";
  const unknownFile = "src/modules/billing/billing.controller.ts";
  const placementFile = "src/common/region/placement-lookup.ts";
  const jwtFile = "src/common/auth/jwt-auth.guard.ts";

  const annotationSrc = "@NoTenantTransaction()\nasync stream() {}";
  const contextExitSrc = "return runOutsideTenantContext(async () => { return 1; });";
  const withIdentitySrc = "const rows = await withIdentity(this.db, userId, (tx) => tx.select().from(t));";

  const cronBypassSrc = "async run() {\n  const rows = await this.db.select().from(organizations);\n}";
  const cronSafeSrc =
    "async run() {\n  await forEachOrg(this.db, 'sweep', async (tx) => { await this.db.select().from(orgs); });\n}";

  const nakedHookSrc = [
    "registerAfterCommit(async () => {",
    "  await this.db.update(someTable).set({ x: 1 }).where(eq(someTable.id, id));",
    "});",
  ].join("\n");

  const guardedHookSrc = [
    "registerAfterCommit(async () => {",
    "  await runInNewTenantTransaction(this.db, orgId, async (tx) => {",
    "    await tx.update(someTable).set({ x: 1 }).where(eq(someTable.id, id));",
    "  });",
    "});",
  ].join("\n");

  const emptyReasonAllowlist = new Map([["src/foo/bar.ts", ""]]);
  let emptyReasonDetected = false;
  for (const [, reason] of emptyReasonAllowlist) {
    if (!reason || !reason.trim()) { emptyReasonDetected = true; break; }
  }

  const annotationInUnknown = findAnnotationSites(annotationSrc, unknownFile);
  const annotationInAi = findAnnotationSites(annotationSrc, aiFile);
  const contextExitInPlacement = findContextExitSites(contextExitSrc, placementFile);
  const contextExitInUnknown = findContextExitSites(contextExitSrc, unknownFile);
  const withIdentityInJwt = findIdentitySites(withIdentitySrc, jwtFile);
  const withIdentityInUnknown = findIdentitySites(withIdentitySrc, unknownFile);
  const nakedSites = findAfterCommitDbSites(nakedHookSrc, unknownFile);
  const guardedSites = findAfterCommitDbSites(guardedHookSrc, unknownFile);

  const checks = {
    annotationFoundInSource: annotationInUnknown.length === 1,
    annotationAllowedForAiGlob: allowlistReason(aiFile, NO_TENANT_TRANSACTION_ALLOWLIST) !== null,
    annotationNotAllowedForUnknownFile: allowlistReason(unknownFile, NO_TENANT_TRANSACTION_ALLOWLIST) === null,
    annotationInAiFileNotFlagged: annotationInAi.length === 1 && allowlistReason(aiFile, NO_TENANT_TRANSACTION_ALLOWLIST) !== null,
    contextExitFoundInSource: contextExitInPlacement.length === 1,
    contextExitAllowlistedWithReason: allowlistReason(placementFile, CONTEXT_EXIT_ALLOWLIST) !== null,
    contextExitNotAllowlistedForUnknown: allowlistReason(unknownFile, CONTEXT_EXIT_ALLOWLIST) === null,
    contextExitInUnknownIsFlagged: contextExitInUnknown.length === 1,
    withIdentityFoundInSource: withIdentityInJwt.length === 1,
    withIdentityAllowlistedWithReason: allowlistReason(jwtFile, WITH_IDENTITY_ALLOWLIST) !== null,
    withIdentityNotAllowlistedForUnknown: allowlistReason(unknownFile, WITH_IDENTITY_ALLOWLIST) === null,
    withIdentityInUnknownIsFlagged: withIdentityInUnknown.length === 1,
    cronBypassDetectedWhenNoGuard: isCronBypass(cronBypassSrc),
    cronBypassNotFlaggedWhenGuardPresent: !isCronBypass(cronSafeSrc),
    afterCommitDbFlaggedWhenNaked: nakedSites.length === 1,
    afterCommitDbCleanWhenGuarded: guardedSites.length === 0,
    emptyReasonInAllowlistIsDetected: emptyReasonDetected,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

// -- run ---------------------------------------------------------------------

validateAllowlists();

if (!existsSync(SCAN_ROOT)) {
  process.stderr.write(`Cannot read scan root: ${SCAN_ROOT}\n`);
  process.exit(2);
}

function walkTs(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkTs(full));
    else if (entry.name.endsWith(".ts") && !SPEC_RE.test(entry.name)) results.push(full);
  }
  return results;
}

const findings = [];

for (const file of walkTs(SCAN_ROOT)) {
  const rel = toRelPath(file);
  const src = readFileSync(file, "utf8");
  const isCron = rel.includes("/modules/cron/");

  for (const f of findAnnotationSites(src, rel)) findings.push(f);
  for (const f of findContextExitSites(src, rel)) findings.push(f);
  for (const f of findIdentitySites(src, rel)) findings.push(f);
  for (const f of findAfterCommitDbSites(src, rel)) findings.push(f);

  if (isCron && isCronBypass(src))
    findings.push({ file: rel, line: 1, kind: "cron-bypass" });
}

if (!EXTERNAL_ROOT && findings.length < MIN_BYPASS_SITES) {
  process.stderr.write(
    `Found only ${findings.length} bypass sites. That is a broken pattern, not a clean codebase.\n`,
  );
  process.exit(2);
}

const excused = findings.filter((f) => resolveAllowlist(f) !== null);
const violations = findings.filter((f) => resolveAllowlist(f) === null);

const count = (kind) => findings.filter((f) => f.kind === kind).length;

console.log(`Bypass sites found       ${findings.length}`);
console.log(`  @NoTenantTransaction   ${count("no-tenant-transaction")}`);
console.log(`  runOutsideTenantCtx    ${count("context-exit")}`);
console.log(`  withIdentity           ${count("with-identity")}`);
console.log(`  cron direct db         ${count("cron-bypass")}`);
console.log(`  registerAfterCommit    ${count("after-commit-db")}`);
console.log("");

if (excused.length > 0) {
  console.log("ALLOWLISTED — each has a reason:");
  for (const f of excused)
    console.log(`  SKIP  [${f.kind}]  ${f.file}:${f.line}  — ${resolveAllowlist(f)}`);
  console.log("");
}

if (violations.length === 0) {
  console.log("OK — every database bypass is on the allowlist with a reason.");
  process.exit(0);
}

console.error("DATABASE BYPASS NOT ALLOWLISTED:");
for (const f of violations.sort((a, b) =>
  `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`),
))
  console.error(`  FAIL  [${f.kind}]  ${f.file}:${f.line}`);
console.error("");
console.error(`FAIL — ${violations.length} of ${findings.length} bypass site(s) not on the allowlist.`);
process.exit(1);
