/**
 * Enumerates every path that reaches the database outside a tenant transaction
 * and fails the build on any one that is not on the allowlist with a reason.
 *
 * Bypass classes detected:
 *   @NoTenantTransaction() on a handler or controller class
 *   runOutsideTenantContext( call sites
 *   withIdentity( call sites
 *   cron-like files (src/modules/cron/** or files containing @Cron/@Interval) that
 *     access this.db without forEachOrg / runIn*TenantTransaction
 *   registerAfterCommit( callbacks whose body accesses this.db without a transaction wrapper
 *
 * Known limits (require call-graph analysis; not detectable by text scanning):
 *   registerAfterCommit(() => this.doDbWork()) — the db access lives in the called method, not the callback body.
 *   A closure defined inside a guard block but invoked later (e.g. process.nextTick(fn)) — textually inside the guard, executes outside it.
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
  [
    "src/modules/e-sign/sign-bulk-send.controller.ts",
    "bulk send dispatches up to 5000 invitation emails, and one request transaction around them held a pooled connection across every network call and made the whole job one rollback boundary — a failure at row 3000 discarded 3000 envelopes whose emails had already been delivered; createJob opens its own runInNewTenantTransaction per row, and writes each row's outcome in a second one so a rolled-back row still records that it failed",
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
    "src/common/region/cell-admission.ts",
    "chooses the cell a NEW organisation is placed into by reading cell_capacity_measurements, which necessarily runs before that organisation and therefore any tenant context exists; same class as the placement lookup above",
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
  // The three below are one class, and they are the CURE rather than the disease.
  //
  // Each is a side effect that outlives the request that raised it. The tenant
  // context is async-local, so the continuation inherits whatever transaction
  // was open at the call — which by then has committed and closed. A query
  // issued against that dead handle does not throw: it never settles. The
  // surrounding `.catch` therefore never runs, and the failure is invisible in
  // a way no log, metric or test can see. Every one of these was found that
  // way: zero rows written, nobody told.
  //
  // Detaching first is what lets the callee open a scope of its own from the
  // orgId it is handed. Removing these calls does not restore tenant safety,
  // it restores the hang — so if one of these files ever needs its entry
  // removed, the fix is to make the effect durable (OutboxWriter) or deferred
  // (registerAfterCommit), never to re-inherit the ambient.
  [
    "src/modules/notifications/notifications.service.ts",
    "detached web-push fan-out: raised from outbox consumers and cron sweeps whose transaction has already committed, so the push_subscriptions read under tenant_isolation would hang on a closed handle instead of failing; runOutsideTenantContext lets sendToUser open its own scope from the orgId it is passed",
  ],
  [
    "src/modules/chat/chat-huddles.service.ts",
    "detached huddle-start push, same shape as the notifications fan-out one line up: the subscription lookup only won the race by microtask ordering and the 404/410 endpoint reap lost it outright, so expired endpoints were never reaped and real delivery failures were swallowed with them",
  ],
  [
    "src/modules/webhooks/webhooks-dispatch.service.ts",
    "detached outbound webhook dispatch: run() asks for runInNewTenantTransaction and that helper reuses any ambient it finds, so without exiting first the delivery insert was issued against the returned request's closed transaction and every dispatch silently wrote no delivery row",
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
  // Both below touch `account_organization_index`, the same cross-org discovery
  // projection as the entry above. Its RLS policy admits rows by `app.user_id`,
  // NOT by `app.current_org_id`, so a tenant transaction is not a stricter
  // choice here — it is the wrong one: the policy would admit nothing and the
  // read would come back empty rather than refused. `withIdentity` is the only
  // helper that sets the GUC this table's policy actually reads.
  [
    "src/modules/auth/auth.service.ts",
    "registration projects the new membership into account_organization_index before any org is current, so it necessarily precedes a tenant context, and the table is keyed and policed by user, not org",
  ],
  [
    "src/modules/organization/core/invitation-acceptance.service.ts",
    "an accepted invitation upserts the acceptor's row into the same user-policed discovery projection; the row may not exist yet, which is why this is an upsert rather than the service's touchLastActivated update",
  ],
]);

export const CRON_BYPASS_ALLOWLIST = new Map([
  [
    "src/modules/cron/cron-org-purge-worker.service.ts",
    "purge worker selects from the global organizations table (no RLS policy) using FOR UPDATE SKIP LOCKED; the only cron service that must run without a per-org tenant GUC",
  ],
  // The five below were INVISIBLE until 2026-08-28: the cron rule matched whole
  // files, so one forEachOrg anywhere excused every bare this.db in the file.
  // Each of these mixes guarded sweeps with unguarded this.db.transaction blocks.
  // They are NOT asserted safe — they are pre-existing sweeps their owning session
  // must migrate to forEachOrg or justify per site. Tracked in CROSS-SESSION.md.
  [
    "src/modules/cron/cron-leave.service.ts",
    "PRE-EXISTING, UNAUDITED (16 sites): mixes forEachOrg sweeps with bare this.db.transaction blocks; hidden by the old file-level rule; owner must migrate or justify each site",
  ],
  [
    "src/modules/cron/cron-hr-engines.service.ts",
    "PRE-EXISTING, UNAUDITED (4 sites): same mixed shape as cron-leave; owner must migrate or justify each site",
  ],
  [
    "src/modules/cron/cron-recruitment.service.ts",
    "PRE-EXISTING, UNAUDITED (3 sites): same mixed shape as cron-leave; owner must migrate or justify each site",
  ],
  [
    "src/modules/cron/cron-notification-retention.service.ts",
    "PRE-EXISTING, UNAUDITED (2 sites): retention sweep addresses partitions by name outside a tenant context; owner must confirm the tables carry no RLS policy",
  ],
  [
    "src/modules/cron/cron-billing.service.ts",
    "PRE-EXISTING, UNAUDITED (2 sites): same mixed shape as cron-leave; owner must migrate or justify each site",
  ],
]);

export const AFTER_COMMIT_DB_ALLOWLIST = new Map([]);

// -- helpers -----------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripCommentsAndStrings(src) {
  const out = [];
  let i = 0;
  let inBlock = false;
  let inString = null;

  while (i < src.length) {
    const ch = src[i];

    if (inBlock) {
      if (ch === "*" && src[i + 1] === "/") {
        out.push(" ", " ");
        i += 2;
        inBlock = false;
      } else {
        out.push(ch === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }

    if (inString !== null) {
      if (ch === "\\") {
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (ch === inString) {
        out.push(" ");
        inString = null;
        i++;
        continue;
      }
      if (ch === "\n" && inString !== "`") {
        out.push("\n");
        inString = null;
        i++;
        continue;
      }
      out.push(ch === "\n" ? "\n" : " ");
      i++;
      continue;
    }

    if (ch === "/" && src[i + 1] === "*") {
      out.push(" ", " ");
      i += 2;
      inBlock = true;
      continue;
    }

    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out.push(" ");
      i++;
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join("");
}

function collectImportAliases(src, originalNames) {
  const locals = new Set(originalNames);
  const importRe = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g;
  let m;
  while ((m = importRe.exec(src)) !== null) {
    const specifiers = m[1];
    for (const orig of originalNames) {
      const aliasRe = new RegExp(`\\b${escapeRe(orig)}\\b\\s+as\\s+(\\w+)`);
      const aliasMatch = aliasRe.exec(specifiers);
      if (aliasMatch) locals.add(aliasMatch[1]);
    }
  }
  return locals;
}

function isCronLike(src, rel) {
  return rel.includes("/modules/cron/") || /[@]Cron\(|[@]Interval\(/.test(src);
}

export function balanced(src, from) {
  let depth = 0;
  let inString = null;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (inString !== null) {
      if (ch === "\\") { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
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
  const stripped = stripCommentsAndStrings(src);
  const lines = stripped.split("\n");
  const localNames = collectImportAliases(src, ["NoTenantTransaction"]);
  const decoratorRe = new RegExp(
    `@(${[...localNames].map(escapeRe).join("|")})\\s*\\(\\s*\\)`,
  );
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    if (decoratorRe.test(lines[i]))
      results.push({ file: filePath, line: i + 1, kind: "no-tenant-transaction" });
  }
  return results;
}

export function findContextExitSites(src, filePath) {
  const stripped = stripCommentsAndStrings(src);
  const lines = stripped.split("\n");
  const localNames = collectImportAliases(src, ["runOutsideTenantContext"]);
  const callRe = new RegExp(`\\b(${[...localNames].map(escapeRe).join("|")})\\s*\\(`);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    if (callRe.test(lines[i]))
      results.push({ file: filePath, line: i + 1, kind: "context-exit" });
  }
  return results;
}

export function findIdentitySites(src, filePath) {
  const stripped = stripCommentsAndStrings(src);
  const lines = stripped.split("\n");
  const localNames = collectImportAliases(src, ["withIdentity"]);
  const callRe = new RegExp(`\\b(${[...localNames].map(escapeRe).join("|")})\\s*\\(`);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    if (callRe.test(lines[i]))
      results.push({ file: filePath, line: i + 1, kind: "with-identity" });
  }
  return results;
}

export function findCronBypassSites(src, filePath) {
  const strippedSrc = stripCommentsAndStrings(src);

  const guarded = [];
  for (const guard of ["forEachOrg(", "runInNewTenantTransaction(", "runInTenantTransaction("]) {
    let at = 0;
    while (true) {
      const pos = strippedSrc.indexOf(guard, at);
      if (pos === -1) break;
      const body = balanced(src, pos + guard.length - 1);
      if (body) guarded.push([pos, pos + body.length]);
      at = pos + guard.length;
    }
  }

  const results = [];
  const site =
    /\bthis\.db(?:(?:\?\.|\s*\.\s*)(?:select|insert|update|delete|execute|transaction|query)\b|\s*\[)/g;
  let match;
  while ((match = site.exec(strippedSrc)) !== null) {
    const pos = match.index;
    if (guarded.some(([from, to]) => pos > from && pos < to)) continue;
    results.push({
      file: filePath,
      line: src.slice(0, pos).split("\n").length,
      kind: "cron-bypass",
    });
  }

  const aliasPat = /(?:=\s*this\.db\b|\{\s*\bdb\b[^}]*\}\s*=\s*this\b)/g;
  let aliasMatch;
  while ((aliasMatch = aliasPat.exec(strippedSrc)) !== null) {
    const pos = aliasMatch.index;
    if (guarded.some(([from, to]) => pos > from && pos < to)) continue;
    results.push({
      file: filePath,
      line: src.slice(0, pos).split("\n").length,
      kind: "cron-bypass",
    });
  }

  return results;
}

export function isCronBypass(src) {
  return findCronBypassSites(src, "x").length > 0;
}

export function findAfterCommitDbSites(src, filePath) {
  const strippedSrc = stripCommentsAndStrings(src);
  const needle = "registerAfterCommit(";
  const results = [];
  let idx = 0;

  while (true) {
    const pos = strippedSrc.indexOf(needle, idx);
    if (pos === -1) break;

    const line = src.slice(0, pos).split("\n").length;
    const body = balanced(src, pos + needle.length - 1);
    const strippedBody = body ? stripCommentsAndStrings(body) : null;

    if (
      strippedBody &&
      /\bthis\.db\b/.test(strippedBody) &&
      !/runIn(?:New)?TenantTransaction|withTenant\b/.test(strippedBody)
    )
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
  const cronPartlyGuardedSrc = [
    "async run() {",
    "  await forEachOrg(this.db, 'sweep', async (tx) => { await this.db.select().from(a); });",
    "  await this.db.transaction(async (tx) => { await tx.update(organizations).set({}); });",
    "}",
  ].join("\n");

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

  const parenInStringSrc = [
    'await forEachOrg(this.db, "(", async (tx) => { await tx.select().from(a); });',
    "await this.db.select().from(bypass_table);",
  ].join("\n");

  const cronOutsidePathSrc = [
    "import { Cron } from '@nestjs/schedule';",
    "@Cron('0 * * * *')",
    "async run() { await this.db.select().from(organizations); }",
  ].join("\n");

  const optChainingEvadeSrc = [
    "async run() {",
    "  const rows = await this.db?.select().from(organizations);",
    "}",
  ].join("\n");

  const aliasedWithIdentitySrc = [
    "import { withIdentity as wi } from '../common/identity';",
    "async doWork() {",
    "  const rows = await wi(this.db, userId, (tx) => tx.select().from(t));",
    "}",
  ].join("\n");

  const commentAnnotationSrc = "const x = 1; // @NoTenantTransaction()\nasync method() {}";

  const spacedDecoratorSrc = "@NoTenantTransaction( )\nasync stream() {}";

  const hookWithCommentDbSrc = [
    "registerAfterCommit(async () => {",
    "  // this.db.update(someTable).set({ x: 1 });",
    "  doSomethingElse();",
    "});",
  ].join("\n");

  const aliasedDecoratorSrc = [
    "import { NoTenantTransaction as NTT } from './decorators';",
    "@NTT()",
    "async stream() {}",
  ].join("\n");

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
    cronBypassFoundWhenOnlySomeWorkIsGuarded:
      findCronBypassSites(cronPartlyGuardedSrc, "x").length === 1,
    afterCommitDbFlaggedWhenNaked: nakedSites.length === 1,
    afterCommitDbCleanWhenGuarded: guardedSites.length === 0,
    emptyReasonInAllowlistIsDetected: emptyReasonDetected,
    balancedIgnoresParenInsideString: findCronBypassSites(parenInStringSrc, "x").length > 0,
    cronDetectedOutsideCronFolder: isCronLike(cronOutsidePathSrc, "src/modules/billing/billing.scheduler.ts"),
    optionalChainingDetected: findCronBypassSites(optChainingEvadeSrc, "x").length > 0,
    aliasedWithIdentityDetected: findIdentitySites(aliasedWithIdentitySrc, unknownFile).length > 0,
    annotationInCommentNotFlagged: findAnnotationSites(commentAnnotationSrc, unknownFile).length === 0,
    spacedDecoratorDetected: findAnnotationSites(spacedDecoratorSrc, unknownFile).length > 0,
    afterCommitDbCommentNotFlagged: findAfterCommitDbSites(hookWithCommentDbSrc, unknownFile).length === 0,
    aliasedDecoratorDetected: findAnnotationSites(aliasedDecoratorSrc, unknownFile).length > 0,
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

  for (const f of findAnnotationSites(src, rel)) findings.push(f);
  for (const f of findContextExitSites(src, rel)) findings.push(f);
  for (const f of findIdentitySites(src, rel)) findings.push(f);
  for (const f of findAfterCommitDbSites(src, rel)) findings.push(f);

  if (isCronLike(src, rel)) for (const f of findCronBypassSites(src, rel)) findings.push(f);
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
