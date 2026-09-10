/**
 * The DataScope boundary, as imports and call sites rather than as text classification.
 *
 * `check-scope-application.mjs` asked "was this string spent" by classifying source
 * text. ADR 0005 moved that question into the type: a DataScope now leaves the
 * resolver layer only inside a ScopedRead, and the only WHERE a ScopedRead builds
 * already carries the tenant predicate and the scope predicate. What a type cannot
 * check is who is allowed to reach past it, which is what this checks:
 *
 *   1. applyScope is internal to the access module.
 *   2. ScopedRead.of is confined to the resolver layer.
 *   3. Every rawScope() call site is declared here with a reason.
 *   4. No production file outside the resolver or grant-authoring layers declares a
 *      DataScope-typed value.
 *
 * Usage:  node src/scripts/check-scope-boundary.mjs [--self-test]
 * Exit:   0 clean · 1 a boundary is crossed · 2 the check itself is broken
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = resolve(SCRIPT_DIR, "../..");
const SRC_DIR = join(BACKEND_ROOT, "src");
const SPEC_RE = /\.(spec|e2e-spec)\.ts$/;

const rel = (file) => relative(BACKEND_ROOT, file).replace(/\\/g, "/");

/** The one module that may spend a DataScope into a predicate. */
const APPLY_SCOPE_OWNER = "src/modules/access/scoped-read.ts";

/**
 * The resolver layer: files whose job is to turn a permission into a ScopedRead.
 * A `*-scope.ts` file beside its module, or the access module itself.
 */
const isResolverLayer = (path) =>
  /(^|\/)[a-z0-9-]*scope\.ts$/.test(path) || path.startsWith("src/modules/access/");

/**
 * Where a DataScope is DATA rather than a filter.
 *
 * A grant row carries a scope column; RBAC administration reads, writes, validates
 * and renders that value, and none of those are a read to be scoped. The rule this
 * gate enforces is about *spending* a scope on a query, so the authoring surface is
 * outside it — and `express.d.ts` declares the field `PermissionGuard` writes, which
 * is where the value legitimately enters the process at all.
 */
const SCOPE_AUTHORING = [
  "src/@types/express.d.ts",
  "src/common/rbac/",
  "src/modules/rbac/",
  "src/modules/module-access/",
  "src/modules/delegations/",
];

const isScopeAuthoring = (path) => SCOPE_AUTHORING.some((prefix) => path.startsWith(prefix));

/**
 * Callers that branch on the scope VALUE because the thing they produce is not a
 * row predicate. Each is named, reasoned, and covered by a test. An unlisted
 * rawScope() call fails this gate.
 */
export const DECLARED_RAW_SCOPE = new Map([
  [
    "src/modules/support/core/support-realtime.service.ts",
    "An Ably capability is a channel wildcard or an explicit id list, never a SQL predicate.",
  ],
  [
    "src/modules/support/core/support-reports.controller.ts",
    "The agent-performance report narrows its GROUP BY subject, not its row set.",
  ],
  [
    "src/modules/dashboard/dashboard-project.service.ts",
    "all vs own/team picks an entirely different project-membership query shape (org-wide fetch vs member/manager lookup), not a row predicate.",
  ],
  [
    "src/modules/dashboard/dashboard-scope.ts",
    "Dashboard stats collapse attendance visibility to a boolean flag for the caller, not a row predicate.",
  ],
  [
    "src/modules/gdpr/gdpr.controller.ts",
    "Exporting another subject's data requires organisation-wide scope — an authorization gate on which subject may be read, not a row predicate.",
  ],
  [
    "src/modules/gdpr/gdpr.service.ts",
    "Exporting another subject's data requires organisation-wide scope — an authorization gate on which subject may be read, not a row predicate.",
  ],
  [
    "src/modules/hr/import/hr-export.controller.ts",
    "The requested export scope is persisted on the job row for a worker to replay later; it is stored data, not a filter.",
  ],
  [
    "src/modules/hr/import/hr-export-jobs.service.ts",
    "Compares the scope the requester still holds against the one persisted on the job, by rank.",
  ],
  [
    "src/modules/hr/import/hr-export-worker.service.ts",
    "Persists and audits the execution scope the worker ran under.",
  ],
  [
    "src/modules/hr/time/attendance-email-report.service.ts",
    "The audit trail records which scope produced the report; the report's own rows are scoped by predicate.",
  ],
  [
    "src/modules/timesheets/core/periods-read.service.ts",
    "Authorises one already-fetched period row in process, and treats team as a bypass where every list treats it as own — a pre-existing difference this migration preserved rather than silently unified.",
  ],
  [
    "src/modules/expenses/expenses.controller.ts",
    "Export filters are persisted on the job row for a background worker to replay outside the request.",
  ],
  [
    "src/modules/ai/core/ops-copilot-tools.ts",
    "The payroll copilot answers a different shape per scope — self rows, a team refusal, or an org summary — rather than filtering one query.",
  ],
  [
    "src/modules/ai/core/workspace-copilot-tools.ts",
    "An own-scoped member asking about another member's ticket stats is refused with a message, not narrowed to an empty result.",
  ],
]);

// -- scanning ----------------------------------------------------------------

export function walkTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith(".ts") && !SPEC_RE.test(entry.name)) out.push(full);
  }
  return out;
}

const IMPORTS_APPLY_SCOPE = /from\s+["'][^"']*\/apply-scope["']/;
const SCOPED_READ_OF = /\bScopedRead\.of\s*\(/;
const RAW_SCOPE = /\.rawScope\s*\(/;
/**
 * A single scope carried as a value: `scope: DataScope`, `Promise<DataScope>`.
 *
 * `Map<string, DataScope>` is deliberately NOT matched. That is the permission
 * catalogue a resolver reads FROM, not a resolved scope on its way to a query, and
 * every `PermissionScopeReader` in the codebase names it.
 */
const DECLARES_DATA_SCOPE = /:\s*DataScope\b|<\s*DataScope\s*>/;

export function analyseSource(src, path) {
  const findings = [];
  const lines = src.split("\n");

  if (IMPORTS_APPLY_SCOPE.test(src) && path !== APPLY_SCOPE_OWNER && !path.endsWith("/apply-scope.ts"))
    findings.push({ path, kind: "apply-scope-import", detail: `only ${APPLY_SCOPE_OWNER} may import applyScope` });

  lines.forEach((line, i) => {
    const at = { path, line: i + 1 };
    if (line.trim().startsWith("*") || line.trim().startsWith("//")) return;

    if (SCOPED_READ_OF.test(line) && !isResolverLayer(path))
      findings.push({ ...at, kind: "scoped-read-of", detail: "ScopedRead.of belongs in a *-scope.ts resolver" });

    if (RAW_SCOPE.test(line) && !DECLARED_RAW_SCOPE.has(path))
      findings.push({ ...at, kind: "undeclared-raw-scope", detail: "add this file to DECLARED_RAW_SCOPE with a reason" });

    // A file already declared as reading the raw value may also name its type; that follows from the declaration rather than being a second violation.
    if (
      DECLARES_DATA_SCOPE.test(line) &&
      !isResolverLayer(path) &&
      !isScopeAuthoring(path) &&
      !DECLARED_RAW_SCOPE.has(path)
    )
      findings.push({ ...at, kind: "data-scope-type", detail: "carry a ScopedRead, not a DataScope" });
  });

  return findings;
}

// -- self-test ---------------------------------------------------------------

if (args.includes("--self-test")) {
  const checks = {
    flagsApplyScopeImportOutsideTheOwner:
      analyseSource(`import { applyScope } from "../access/apply-scope";`, "src/modules/deals/deals.service.ts")
        .some((f) => f.kind === "apply-scope-import"),
    allowsApplyScopeInsideTheOwner:
      analyseSource(`import { applyScope } from "./apply-scope";`, APPLY_SCOPE_OWNER).length === 0,
    flagsScopedReadOfOutsideTheResolverLayer:
      analyseSource(`  const r = ScopedRead.of(orgId, userId, "all");`, "src/modules/deals/deals.service.ts")
        .some((f) => f.kind === "scoped-read-of"),
    allowsScopedReadOfInAResolver:
      analyseSource(`  return ScopedRead.of(u.orgId, u.userId, "all");`, "src/modules/deals/deals-scope.ts").length === 0,
    flagsUndeclaredRawScope:
      analyseSource(`  const s = read.rawScope("why");`, "src/modules/deals/deals.service.ts")
        .some((f) => f.kind === "undeclared-raw-scope"),
    allowsDeclaredRawScope:
      analyseSource(
        `  const s = read.rawScope("why");`,
        "src/modules/support/core/support-realtime.service.ts",
      ).length === 0,
    flagsADataScopeParameterOutsideTheResolverLayer:
      analyseSource(`  list(orgId: string, scope: DataScope) {`, "src/modules/deals/deals.service.ts")
        .some((f) => f.kind === "data-scope-type"),
    allowsADataScopeReturnInAResolver:
      analyseSource(`): Promise<DataScope> {`, "src/modules/hr/time/attendance-scope.ts").length === 0,
    allowsADataScopeOnAGrantRow:
      analyseSource(`  scope: DataScope;`, "src/modules/rbac/roles.service.ts").length === 0,
    allowsThePermissionCatalogueMap:
      analyseSource(
        `  resolveUserPermissions(orgId: string): Promise<ReadonlyMap<string, DataScope>>;`,
        "src/modules/hr/hub/hr-hub-capabilities.ts",
      ).length === 0,
    allowsADataScopeTypeInADeclaredRawFile:
      analyseSource(
        `export function shouldDeny(scope: DataScope): boolean {`,
        "src/modules/ai/core/ops-copilot-tools.ts",
      ).length === 0,
    stillFlagsADataScopeInAnOrdinaryService:
      analyseSource(`  scope: DataScope;`, "src/modules/hr/hub/hr-hub-capabilities.ts")
        .some((f) => f.kind === "data-scope-type"),
    ignoresACommentedMention:
      analyseSource(`  // scope: DataScope used to live here`, "src/modules/deals/deals.service.ts").length === 0,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(JSON.stringify({ selfTest: true, pass, checks }, null, 2) + "\n");
  process.exit(pass ? 0 : 1);
}

// -- run ---------------------------------------------------------------------

if (!existsSync(SRC_DIR)) {
  process.stderr.write(`Cannot read src: ${SRC_DIR}\n`);
  process.exit(2);
}

const files = walkTs(SRC_DIR);
const findings = files.flatMap((file) => analyseSource(readFileSync(file, "utf8"), rel(file)));

const scopedReads = files.filter((file) => /\bScopedRead\b/.test(readFileSync(file, "utf8"))).length;
if (scopedReads < 20) {
  process.stderr.write(
    `Only ${scopedReads} files reference ScopedRead. That is a broken pattern, not a clean codebase.\n`,
  );
  process.exit(2);
}

const declaredButUnused = [...DECLARED_RAW_SCOPE.keys()].filter(
  (path) => !existsSync(join(BACKEND_ROOT, path)) || !RAW_SCOPE.test(readFileSync(join(BACKEND_ROOT, path), "utf8")),
);

console.log(`Files carrying a ScopedRead   ${scopedReads}`);
console.log(`Declared rawScope escapes     ${DECLARED_RAW_SCOPE.size}`);
console.log("");

for (const [path, reason] of DECLARED_RAW_SCOPE) console.log(`  RAW   ${path}  — ${reason}`);
console.log("");

if (declaredButUnused.length > 0) {
  console.error("DECLARED BUT NO LONGER PRESENT — remove the entry rather than leaving it standing:");
  for (const path of declaredButUnused) console.error(`  STALE ${path}`);
  console.error("");
}

if (findings.length === 0 && declaredButUnused.length === 0) {
  console.log("OK — the DataScope boundary holds.");
  process.exit(0);
}

if (findings.length > 0) {
  console.error("BOUNDARY CROSSED:");
  for (const f of findings.sort((a, b) => a.path.localeCompare(b.path)))
    console.error(`  FAIL  ${f.path}${f.line ? `:${f.line}` : ""}  [${f.kind}] ${f.detail}`);
  console.error("");
}

console.error(`FAIL — ${findings.length + declaredButUnused.length} boundary violations.`);
process.exit(1);
