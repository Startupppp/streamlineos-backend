import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BACKEND_ROOT, handlerBody, type HandlerRoute } from "./route-surface";

const SRC_ROOT = join(BACKEND_ROOT, "src");

export interface SourceMethod {
  readonly owner: string;
  readonly file: string;
  readonly name: string;
  readonly signature: string;
  readonly body: string;
}

/** Every class and standalone function in src/, indexed by the name callers use. */
export interface SourceIndex {
  readonly methodsByClass: ReadonlyMap<string, ReadonlyMap<string, SourceMethod>>;
  readonly functions: ReadonlyMap<string, SourceMethod>;
}

const CLASS_DECL_RE = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/;
const FUNCTION_DECL_RE = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/;
const MEMBER_RE =
  /^\s{2,}(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*[(<]/;

const SKIP_MEMBER = new Set([
  "constructor", "if", "for", "while", "switch", "return", "catch", "super",
]);

function* walkSource(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      yield* walkSource(full);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts") && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

let indexCache: SourceIndex | null = null;

export function buildSourceIndex(): SourceIndex {
  if (indexCache) return indexCache;
  const methodsByClass = new Map<string, Map<string, SourceMethod>>();
  const functions = new Map<string, SourceMethod>();

  for (const abs of walkSource(SRC_ROOT)) {
    const file = relative(BACKEND_ROOT, abs).replace(/\\/g, "/");
    const lines = readFileSync(abs, "utf8").split("\n");
    let currentClass: string | null = null;
    let classIndent = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      const klass = line.match(CLASS_DECL_RE);
      if (klass) {
        currentClass = klass[1] as string;
        classIndent = line.length - line.trimStart().length;
        if (!methodsByClass.has(currentClass)) methodsByClass.set(currentClass, new Map());
        continue;
      }
      if (currentClass && line.trimStart().startsWith("}") && line.length - line.trimStart().length === classIndent)
        currentClass = null;

      const fn = line.match(FUNCTION_DECL_RE);
      if (fn) {
        const { signature, body, end } = handlerBody(lines, i);
        const name = fn[1] as string;
        if (!functions.has(name)) functions.set(name, { owner: file, file, name, signature, body });
        i = end;
        continue;
      }

      if (!currentClass) continue;
      const member = line.match(MEMBER_RE);
      if (!member) continue;
      const name = member[1] as string;
      if (SKIP_MEMBER.has(name)) continue;
      const { signature, body, end } = handlerBody(lines, i);
      const bucket = methodsByClass.get(currentClass);
      if (bucket && !bucket.has(name)) bucket.set(name, { owner: currentClass, file, name, signature, body });
      i = end;
    }
  }

  indexCache = { methodsByClass, functions };
  return indexCache;
}

// --- tenant-binding evidence -------------------------------------------------

/** An org column bound inside a predicate — the only thing that makes a read tenant-safe. */
const ORG_PREDICATE_RE = [
  /\beq\s*\(\s*[\w.]*\.(orgId|organizationId)\s*,/,
  /\beq\s*\(\s*[\w.]+\s*,\s*(?:[\w.]*\b)?orgId\s*\)/,
  /\borgId\s*:\s*[\w.]*orgId\b/,
  /\.(orgId|organizationId)\s*,\s*orgId\b/,
  /\bcurrent_org_id\b/,
  /\bcurrentOrgId\b/,
];

/** Delegation that carries the tenant onward: another layer will bind it. */
const DELEGATION_RE = /\b(?:this\.\w+|[A-Za-z_$][\w$]*)\.\w+\s*\(\s*[^)]*\borgId\b/;

/** Helpers whose whole purpose is to re-assert the caller's access to one object. */
const ASSERTION_RE =
  /\b(?:assert(?:Organization|Org|Tenant|Project|Record|Entity|Workspace|Space|Channel|Deal|Ticket)?\w*(?:Access|Ownership|Membership|Actor|Scope|Visible|Readable)|ensure\w*(?:Access|Ownership|Scope)|requireOrg\w*|resolveScoped\w*|loadScoped\w*|getForRequester|scopedTo\w*)\s*\(/;

/** Explicit tenant transaction: the GUC is set, RLS binds the tenant in the database. */
const TENANT_TX_RE = /\b(?:runInTenantTransaction|runInNewTenantTransaction|withTenant|forEachOrg|tenantDb)\b/;

export type BindingVerdict =
  | "org-predicate"
  | "tenant-transaction"
  | "object-assertion"
  | "delegated"
  | "self-subject"
  | "unbound";

export interface MethodBinding {
  readonly verdict: BindingVerdict;
  readonly evidence: string;
  readonly resolved: string;
}

const SELF_SUBJECT_RE = /\b(?:userId|actorId|currentUser|user\.userId|subjectUserId)\b/;

function firstMatch(body: string, patterns: readonly RegExp[]): string | null {
  for (const re of patterns) {
    const m = body.match(re);
    if (m) return m[0];
  }
  return null;
}

export function classifyMethodBody(body: string): MethodBinding | null {
  const predicate = firstMatch(body, ORG_PREDICATE_RE);
  if (predicate) return { verdict: "org-predicate", evidence: predicate.trim(), resolved: "" };
  const tx = body.match(TENANT_TX_RE);
  if (tx) return { verdict: "tenant-transaction", evidence: tx[0], resolved: "" };
  const assertion = body.match(ASSERTION_RE);
  if (assertion) return { verdict: "object-assertion", evidence: assertion[0], resolved: "" };
  const delegation = body.match(DELEGATION_RE);
  if (delegation) return { verdict: "delegated", evidence: delegation[0].trim(), resolved: "" };
  return null;
}

/**
 * Follows a service call into its method and, when that method only forwards the
 * work, into the next one. Depth is capped: a chain this long that still shows no
 * tenant predicate is reported unbound so a human reads it, never assumed safe.
 */
export function classifyMethod(
  className: string,
  methodName: string,
  index: SourceIndex,
  depth = 0,
  seen = new Set<string>(),
): MethodBinding {
  const key = `${className}.${methodName}`;
  if (seen.has(key) || depth > 3)
    return { verdict: "unbound", evidence: "", resolved: key };
  seen.add(key);

  const klass = index.methodsByClass.get(className);
  const method = klass ? klass.get(methodName) : index.functions.get(methodName);
  if (!method) return { verdict: "unbound", evidence: "unresolved-method", resolved: key };

  const direct = classifyMethodBody(method.body);
  if (direct && direct.verdict !== "delegated")
    return { ...direct, resolved: `${key} (${method.file})` };

  for (const call of method.body.matchAll(/this\.(\w+)\.(\w+)\s*\(/g)) {
    const nextClass = resolveInjectedType(method.file, call[1] as string);
    if (!nextClass) continue;
    const nested = classifyMethod(nextClass, call[2] as string, index, depth + 1, seen);
    if (nested.verdict !== "unbound") return nested;
  }

  for (const call of method.body.matchAll(/this\.(\w+)\s*\(/g)) {
    const nested = classifyMethod(className, call[1] as string, index, depth + 1, seen);
    if (nested.verdict !== "unbound") return nested;
  }

  for (const call of method.body.matchAll(/(?<![\w.])([a-z][\w$]*)\s*\(/g)) {
    const fnName = call[1] as string;
    if (!index.functions.has(fnName)) continue;
    const nested = classifyMethod(fnName, fnName, index, depth + 1, seen);
    if (nested.verdict !== "unbound") return nested;
  }

  if (direct) return { ...direct, resolved: `${key} (${method.file})` };
  if (SELF_SUBJECT_RE.test(method.signature))
    return { verdict: "self-subject", evidence: "subject from token", resolved: `${key} (${method.file})` };
  return { verdict: "unbound", evidence: "", resolved: `${key} (${method.file})` };
}

const injectedCache = new Map<string, Map<string, string>>();

export function resolveInjectedType(file: string, property: string): string | null {
  let map = injectedCache.get(file);
  if (!map) {
    map = new Map<string, string>();
    const src = readFileSync(join(BACKEND_ROOT, file), "utf8");
    for (const m of src.matchAll(
      /(?:private|public|protected)\s+(?:readonly\s+)?(\w+)\s*:\s*([\w]+)/g,
    ))
      map.set(m[1] as string, m[2] as string);
    injectedCache.set(file, map);
  }
  return map.get(property) ?? null;
}

// --- route-level verdict -----------------------------------------------------

export interface RouteBinding {
  readonly route: HandlerRoute;
  readonly verdict: BindingVerdict;
  readonly evidence: string;
  readonly resolved: string;
  readonly tenantThreaded: boolean;
}

const TENANT_ARG_RE = /\b(?:orgId|organizationId|u\b|user\b|actor\b|ctx\b|currentUser\b|principal\b)/;

export function analyzeRoute(route: HandlerRoute, index: SourceIndex): RouteBinding {
  const tenantThreaded =
    route.serviceCalls.length === 0
      ? TENANT_ARG_RE.test(route.body)
      : route.serviceCalls.some((c) => TENANT_ARG_RE.test(c.args));

  const inline = classifyMethodBody(route.body);
  if (inline && inline.verdict !== "delegated")
    return { route, ...inline, resolved: `${route.controllerClass}.${route.handler}`, tenantThreaded };

  let best: MethodBinding | null = null;
  for (const call of route.serviceCalls) {
    const className = route.injected.get(call.property);
    if (!className) continue;
    const verdict = classifyMethod(className, call.method, index);
    if (verdict.verdict !== "unbound") return { route, ...verdict, tenantThreaded };
    best = best ?? verdict;
  }

  for (const call of route.body.matchAll(/this\.(\w+)\s*\(/g)) {
    const verdict = classifyMethod(route.controllerClass, call[1] as string, index);
    if (verdict.verdict !== "unbound") return { route, ...verdict, tenantThreaded };
  }
  if (inline) return { route, ...inline, resolved: `${route.controllerClass}.${route.handler}`, tenantThreaded };
  return {
    route,
    verdict: "unbound",
    evidence: best?.evidence ?? "",
    resolved: best?.resolved ?? `${route.controllerClass}.${route.handler}`,
    tenantThreaded,
  };
}
