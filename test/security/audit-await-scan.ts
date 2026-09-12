import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A durable audit write must be awaited, and the scan has to survive the write
 * being extracted into a helper.
 *
 * Until 2026-09-11 both audit gates matched `await this.audit.logCritical(`
 * against a service's own text and nothing else. When the six org-hierarchy
 * services moved their identical `logCritical` call into `recordOrgUnitAudit`
 * (`modules/organization/hierarchy/org-unit-crud.ts`), every one of them scanned
 * as having ZERO critical audit calls — the gate reported a missing audit write
 * where the write is still made and still awaited. That is a hole in the scan,
 * not in the code: any audited mutation could be made invisible to both gates by
 * a refactor nobody would think to flag. This is the same hole, and the same
 * one-hop fix, that `classifyBulkMethod` needed in `bulk-id-handling.ts`.
 *
 * So the scan follows ONE hop: into a module-level function the service imports
 * from a relative module, which itself performs the audit write. Both hops must
 * await — a helper that fires and forgets is counted as an unawaited write at
 * every call site that reaches it, so extracting the call can never launder it.
 */

/**
 * `await this.audit.logCritical(` / `audit.logCritical(` — with or without the await.
 *
 * A tail `return` counts as awaited and `void` does not, because the property the
 * gate defends is that the write's failure reaches the caller and the response
 * does not complete before the write does. `return exportWorkLogsCsv(...)`
 * (`work-logs.service.ts:294`) satisfies that; `void x()` and a bare `x();` do not.
 */
/*
  Any receiver, not just `this`. A split moved three of these onto a deps
  object — `await deps.audit.logCritical(` — and a pattern anchored at
  `audit.` matched from there, leaving the `await` outside the match. The
  scan then read three awaited writes as three unawaited ones, which is the
  failure this gate exists to raise, reported against code that is correct.
*/
const CRITICAL_CALL_RE = /(await\s+|return\s+)?(?:\b[A-Za-z_$][\w$]*\.)*\baudit\.logCritical\s*\(/g;

/** `this.audit.log(` — the best-effort variant, which swallows its own failures. */
const BEST_EFFORT_LOG_RE = /(?:\b[A-Za-z_$][\w$]*\.)*\baudit\.log\s*\(/;

/** `import { a, b as c } from "./x"` — the only import form a helper arrives through. */
const NAMED_IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

/**
 * A top-level `function f(` or `const f = (` declaration, anchored at column 0 so
 * a nested closure never opens a new slice and a helper's body cannot be credited
 * with an `await` that belongs to the function declared after it.
 */
const DECLARATION_RE =
  /^(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:async\s*)?\(/gm;

export interface AuditAwaitReport {
  /** `this.audit.logCritical(...)` written in the service itself. */
  readonly direct: number;
  readonly directAwaited: number;
  /** Calls that reach the audit write through one hop into an imported helper. */
  readonly delegated: number;
  readonly delegatedAwaited: number;
  /** The imported helpers found to perform an audit write, in call order. */
  readonly helpers: readonly string[];
  /** The service, or a helper it delegates to, uses the fire-and-forget `audit.log(`. */
  readonly bestEffortLog: boolean;
}

export type HelperResolver = (specifier: string) => string | undefined;

export function totalAuditWrites(report: AuditAwaitReport): number {
  return report.direct + report.delegated;
}

export function awaitedAuditWrites(report: AuditAwaitReport): number {
  return report.directAwaited + report.delegatedAwaited;
}

interface CallCount {
  readonly total: number;
  readonly awaited: number;
}

function countCriticalCalls(source: string): CallCount {
  let total = 0;
  let awaited = 0;
  for (const match of source.matchAll(CRITICAL_CALL_RE)) {
    total += 1;
    if (match[1] !== undefined) awaited += 1;
  }
  return { total, awaited };
}

interface DeclarationSlice {
  readonly name: string;
  readonly exported: boolean;
  readonly body: string;
}

function declarationSlices(source: string): DeclarationSlice[] {
  const starts: { name: string; exported: boolean; index: number }[] = [];
  for (const match of source.matchAll(DECLARATION_RE)) {
    const name = match[2] ?? match[4];
    if (name === undefined) continue;
    starts.push({
      name,
      exported: (match[1] ?? match[3]) !== undefined,
      index: match.index ?? 0,
    });
  }
  return starts.map((start, position) => ({
    name: start.name,
    exported: start.exported,
    body: source.slice(start.index, starts[position + 1]?.index ?? source.length),
  }));
}

/** Every exported function in a module that itself writes a critical audit entry. */
export function auditWritingExports(
  helperSource: string,
): Map<string, { readonly awaitsWrite: boolean; readonly bestEffortLog: boolean }> {
  const writers = new Map<string, { awaitsWrite: boolean; bestEffortLog: boolean }>();
  for (const slice of declarationSlices(helperSource)) {
    if (!slice.exported) continue;
    const calls = countCriticalCalls(slice.body);
    if (calls.total === 0) continue;
    writers.set(slice.name, {
      awaitsWrite: calls.awaited === calls.total,
      bestEffortLog: BEST_EFFORT_LOG_RE.test(slice.body),
    });
  }
  return writers;
}

interface ImportedSymbol {
  readonly local: string;
  readonly exported: string;
  readonly specifier: string;
}

function importedSymbols(source: string): ImportedSymbol[] {
  const symbols: ImportedSymbol[] = [];
  for (const match of source.matchAll(NAMED_IMPORT_RE)) {
    const specifier = match[2] ?? "";
    if (!specifier.startsWith(".")) continue;
    for (const clause of (match[1] ?? "").split(",")) {
      const cleaned = clause.trim().replace(/^type\s+/, "");
      if (cleaned === "") continue;
      const [exported, local] = cleaned.split(/\s+as\s+/);
      if (exported === undefined) continue;
      symbols.push({ local: local ?? exported, exported, specifier });
    }
  }
  return symbols;
}

function countHelperCalls(source: string, local: string): CallCount {
  /*
    A call to the helper, not the service method that shares its name. The
    bare word boundary matched `async updateEngagement(` — the declaration —
    so each subject counted one call more than it makes, and the awaited
    ratio read as half what it is.
  */
  const callRe = new RegExp(
    `(await\\s+|return\\s+)?(?<![.\\w$])(?<!\\bfunction\\s)(?<!\\basync\\s)${local}\\s*\\(`,
    "g",
  );
  let total = 0;
  let awaited = 0;
  for (const match of source.matchAll(callRe)) {
    total += 1;
    if (match[1] !== undefined) awaited += 1;
  }
  return { total, awaited };
}

/**
 * The audit writes a service makes, directly or through one hop, and how many of
 * them are awaited. `resolveHelper` returns the source of a relative module, so
 * the analysis is a pure function of text and the self-tests can feed it a tree
 * that does not exist on disk.
 */
export function scanAuditAwaits(
  source: string,
  resolveHelper: HelperResolver,
): AuditAwaitReport {
  const direct = countCriticalCalls(source);
  const helperSources = new Map<string, string>();
  let delegated = 0;
  let delegatedAwaited = 0;
  let helperBestEffort = false;
  const helpers: string[] = [];

  for (const symbol of importedSymbols(source)) {
    if (!helperSources.has(symbol.specifier)) {
      const resolved = resolveHelper(symbol.specifier);
      if (resolved === undefined) continue;
      helperSources.set(symbol.specifier, resolved);
    }
    const writer = auditWritingExports(
      helperSources.get(symbol.specifier) ?? "",
    ).get(symbol.exported);
    if (writer === undefined) continue;

    const calls = countHelperCalls(source, symbol.local);
    if (calls.total === 0) continue;
    helpers.push(symbol.local);
    delegated += calls.total;
    if (writer.awaitsWrite) delegatedAwaited += calls.awaited;
    if (writer.bestEffortLog) helperBestEffort = true;
  }

  return {
    direct: direct.total,
    directAwaited: direct.awaited,
    delegated,
    delegatedAwaited,
    helpers,
    bestEffortLog: BEST_EFFORT_LOG_RE.test(source) || helperBestEffort,
  };
}

/** The on-disk form: relative specifiers resolve against the scanned file. */
export function scanServiceAuditAwaits(absolutePath: string): AuditAwaitReport {
  const source = readFileSync(absolutePath, "utf8");
  const base = dirname(absolutePath);
  return scanAuditAwaits(source, (specifier) => {
    for (const candidate of [
      join(base, `${specifier}.ts`),
      join(base, specifier, "index.ts"),
    ])
      if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    return undefined;
  });
}
