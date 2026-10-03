#!/usr/bin/env node
/**
 * check-authz-deny.mjs
 *
 * Every AUTHORIZATION-GATED handler must have a spec that asserts its DENY branch.
 *
 * WHY THIS GATE EXISTS
 * `check:route-classification` proves every handler DECLARES an exposure, and
 * `check:module-gate` / `check:scope-boundary` / `check:record-access` gate the
 * SOURCE side of authorization. Nothing asserted that a deny TEST exists. A gate
 * whose deny branch is never exercised is an assertion about the decorator, not
 * about the guard: the decorator can name a key nobody holds, the guard can be
 * bypassed by an earlier `@Public()`, a `@RequireModule` can name the wrong
 * module — and every one of those ships green, because the only test written is
 * the allow path.
 *
 * ─── THE POPULATION (derived, not listed) ────────────────────────────────────
 * Every HTTP handler in `src/**\/*.controller.ts`, parsed the way
 * `route-classification-report.mjs` parses them (decorator buffer, class flush,
 * handler-first resolution matching NestJS `Reflector.getAllAndOverride`).
 *
 * A handler is GATED when its effective declaration — handler decorators first,
 * then class decorators — carries one of the authorization decorators that
 * actually appear in `src/`:
 *
 *   @RequirePermission("<key>")   permission / scope requirement (PermissionGuard)
 *   @RequireModule("<id>")        plan module gate (ModuleGuard)
 *   @RequireOperatorGrant(...)    operator standing
 *
 * A handler whose effective declaration is `@Public()` or `@Universal()` is NOT
 * gated and is excluded: there is no deny branch to assert. `@AuthorizedInService`
 * is excluded for a stated reason — see EXCLUSIONS below.
 *
 * ─── THE ATTRIBUTION RULE ────────────────────────────────────────────────────
 * A gated handler is COVERED when at least one spec file satisfies BOTH halves:
 *
 *   (A) the file asserts a DENY. One of:
 *         · a 403 status assertion            `toBe(403)`, `.expect(403)`, `toEqual(403)`
 *         · a ForbiddenException ASSERTION    `toThrow(ForbiddenException)`,
 *                                             `rejects.toThrow(Forbidden…)`,
 *                                             `toBeInstanceOf(ForbiddenException)`
 *         · a cross-tenant 404                a 404 / NotFoundException assertion in a
 *                                             file that declares itself an isolation
 *                                             test (path or text says cross-tenant /
 *                                             tenant-isolation / BOLA / other org)
 *       The mere IMPORT of ForbiddenException is not a deny assertion — a service
 *       spec imports it to build a mock. It must appear inside a matcher.
 *
 *   (B) the file NAMES this handler, by one of two links:
 *
 *       ROUTE LINK   the file pairs the handler's HTTP verb with the handler's
 *                    full normalised route (`@Controller` prefix + method path,
 *                    `:id` / `{id}` / `${…}` all normalised to `*`). Pairs are read
 *                    from `.get("/x")`, `.post(\`/x/${id}\`)`, `callRoute("get", "/x")`
 *                    and from `"GET /x"` inside a string (test titles use it).
 *                    A verb used with a NON-literal path (`.get(path)`,
 *                    `callRoute("get", path)` — the `it.each(routes)` shape this
 *                    repo uses heavily) marks that verb INDIRECT, and an indirect
 *                    verb pairs with every route-shaped string literal in the file.
 *                    A HARD-CODED id segment does NOT link: `.delete("/x/abc")` does
 *                    not normalise to `/x/*`, because `/x/given` is just as often a
 *                    real sibling route and collapsing it would let one spec falsely
 *                    cover every parameterised handler on the same prefix. The rule
 *                    therefore UNDER-counts coverage rather than over-counting it,
 *                    which is the safe direction for a floor you walk down.
 *
 *       SYMBOL LINK  the file names the handler's controller class AND calls the
 *                    handler method (`.handlerName(`); or it names the service
 *                    class the handler delegates to AND calls that service method
 *                    (`return this.fooService.bar(` in the handler body →
 *                    `FooService` + `.bar(` in the spec).
 *
 * WHAT A READER CAN CHECK. `--why <route>` prints, for one handler, the exact
 * spec file and the exact link that covered it (or that nothing did). Every
 * COVERED verdict names a file; no verdict rests on a count.
 *
 * ─── WHAT THIS GATE DOES NOT CLAIM ───────────────────────────────────────────
 * It is STATIC, exactly like `check:tenant-isolation`. It proves a deny test
 * EXISTS and is attributable; it does not run it, and a spec that throws before
 * its first expectation still counts here. Execution proof is the jest suite.
 * Attribution is per FILE, not per `it()` block: a spec file that denies one
 * route and merely mentions another covers both. That looseness is stated rather
 * than hidden, and it is why the ratchet is a floor to walk down, not a score.
 *
 * ─── EXCLUSIONS, each with its reason ────────────────────────────────────────
 *   @Public()             no deny branch exists.
 *   @Universal()          authenticated but unkeyed by design (root CLAUDE.md §8);
 *                         there is no permission to withhold.
 *   @AuthorizedInService  the deny lives in a named service, not in a guard, so a
 *                         controller-level route test cannot observe it and the
 *                         SYMBOL link is the only one that could ever fire. Counting
 *                         30 handlers whose only reachable link is the weak one
 *                         would move the ratchet without measuring anything.
 *                         Reported as INFO, not gated.
 *
 * ─── VACUITY GUARDS ──────────────────────────────────────────────────────────
 *   fewer than MIN_CONTROLLERS controller files  -> exit 2
 *   fewer than MIN_GATED gated handlers          -> exit 2
 *   fewer than MIN_DENY_SPECS spec files asserting a deny -> exit 2
 * A broken walk that matches nothing would otherwise report 100% covered.
 *
 * Usage:
 *   node src/scripts/check-authz-deny.mjs
 *   node src/scripts/check-authz-deny.mjs --list          every gated handler + verdict
 *   node src/scripts/check-authz-deny.mjs --uncovered     only the uncovered set
 *   node src/scripts/check-authz-deny.mjs --why "GET /accounting/periods"
 *   node src/scripts/check-authz-deny.mjs --emit-baseline
 *   node src/scripts/check-authz-deny.mjs --self-test
 *
 * Exit codes:
 *   0 uncovered count is at or below the baseline ratchet
 *   1 uncovered count is ABOVE the ratchet (a new gated handler landed with no
 *     deny test), or the self-test failed
 *   2 the scan measured nothing
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LEDGER_PATH as MATRIX_LEDGER_PATH, freshness as matrixFreshness } from "./check-rbac-matrix-ledger.mjs";

const ARGV = process.argv.slice(2);
const SELF_TEST = ARGV.includes("--self-test");
const LIST = ARGV.includes("--list");
const UNCOVERED_ONLY = ARGV.includes("--uncovered");
const EMIT_BASELINE = ARGV.includes("--emit-baseline");
const WHY = (() => {
  const i = ARGV.indexOf("--why");
  return i !== -1 ? ARGV[i + 1] : null;
})();
const ROOT_OVERRIDE = (() => {
  const i = ARGV.indexOf("--root");
  return i !== -1 ? ARGV[i + 1] : null;
})();

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_ROOT = ROOT_OVERRIDE ? resolve(ROOT_OVERRIDE) : resolve(SCRIPT_DIR, "../..");
const BASELINE_PATH = join(SCRIPT_DIR, "baselines", "authz-deny.json");

const MIN_CONTROLLERS = 150;
const MIN_GATED = 800;
const MIN_DENY_SPECS = 50;

const HTTP_VERBS = ["get", "post", "put", "patch", "delete", "head", "options"];

// ─── decorators ──────────────────────────────────────────────────────────────

const PUBLIC_RE = /@Public\s*\(\s*\)/;
const UNIVERSAL_RE = /@Universal\s*\(\s*\)/;
const PERMISSION_RE = /@RequirePermission\s*\(/;
const MODULE_RE = /@RequireModule\s*\(/;
const OPERATOR_RE = /@RequireOperatorGrant\s*\(/;
const IN_SERVICE_RE = /@AuthorizedInService\s*\(\s*["'`][^"'`]/;
const HTTP_VERB_RE = /@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(/;
const CLASS_RE = /^(export\s+)?(abstract\s+)?class\s+(\w+)/;
const CONTROLLER_RE = /@Controller\s*\(\s*(?:\{[^}]*path\s*:\s*)?["'`]([^"'`]*)["'`]/;
const CONTROLLER_BARE_RE = /@Controller\s*\(\s*\)/;

const KEYWORDS = new Set([
  "if", "for", "while", "return", "throw", "catch", "switch", "case",
  "const", "let", "var", "new", "import", "export", "await", "try",
  "else", "default", "typeof", "instanceof", "void", "delete",
]);
const METHOD_RE = /^(?:async\s+)?(\w+)\s*[(<]/;

// ─── deny assertions ─────────────────────────────────────────────────────────

const MATCHER = "(?:toThrow|toThrowError|toBeInstanceOf|toThrowErrorMatchingSnapshot)";
const DENY_403_RE =
  /(?:toBe|toEqual|toStrictEqual)\s*\(\s*403\s*\)|\.expect\s*\(\s*403\s*\)|===\s*403\b|status\s*:\s*403\b/;
const DENY_FORBIDDEN_RE = new RegExp(`${MATCHER}\\s*\\(\\s*(?:new\\s+)?\\w*Forbidden\\w*`);
const DENY_MODULE_RE = new RegExp(`${MATCHER}\\s*\\(\\s*(?:new\\s+)?ModuleDisabledException`);
const DENY_402_RE = /(?:toBe|toEqual|toStrictEqual)\s*\(\s*402\s*\)|\.expect\s*\(\s*402\s*\)/;
const MODULE_GATE_CONTEXT_RE = /MODULE_NOT_ENABLED|ModuleGuard|REQUIRE_MODULE|RequireModule|moduleAvailability/;
const DENY_404_RE = new RegExp(
  `(?:toBe|toEqual|toStrictEqual)\\s*\\(\\s*404\\s*\\)|\\.expect\\s*\\(\\s*404\\s*\\)|${MATCHER}\\s*\\(\\s*(?:new\\s+)?\\w*NotFound\\w*`,
);
const ISOLATION_RE =
  /cross.?tenant|tenant.?isolation|\bbola\b|other\s+org|different\s+org|another\s+org|foreign\s+org|wrong\s+org|cross.?org|org.?isolation/i;

/**
 * The deny surfaces this codebase actually uses, as a SET — a spec can assert
 * more than one. `denyKinds` is intersected with the kinds the handler's own
 * gates can produce (see ADMISSIBLE_DENY), so a module-gate deny test does not
 * silently vouch for a permission gate that nothing exercises.
 */
export function denyKinds(text, relPath) {
  const kinds = new Set();
  if (DENY_403_RE.test(text)) kinds.add("403");
  if (DENY_FORBIDDEN_RE.test(text)) kinds.add("FORBIDDEN");
  if (DENY_MODULE_RE.test(text) || (DENY_402_RE.test(text) && MODULE_GATE_CONTEXT_RE.test(text)))
    kinds.add("MODULE-DENIED");
  if (DENY_404_RE.test(text) && (ISOLATION_RE.test(text) || ISOLATION_RE.test(relPath ?? "")))
    kinds.add("CROSS-TENANT-404");
  return kinds;
}

/** Which deny a handler's own gates are capable of producing. */
export const ADMISSIBLE_DENY = {
  permission: ["403", "FORBIDDEN", "CROSS-TENANT-404"],
  operator: ["403", "FORBIDDEN"],
  module: ["MODULE-DENIED"],
};

export function admissibleDeny(gateKinds) {
  const out = new Set();
  for (const g of gateKinds) for (const k of ADMISSIBLE_DENY[g] ?? []) out.add(k);
  return out;
}

// ─── route normalisation ─────────────────────────────────────────────────────

export function normalisePath(p) {
  if (typeof p !== "string") return null;
  let s = p.trim();
  if (!s.startsWith("/")) s = `/${s}`;
  s = s.replace(/\$\{[^}]*\}/g, "*");
  s = s.replace(/:[A-Za-z_$][\w$]*/g, "*");
  s = s.replace(/\{[^}/]*\}/g, "*");
  s = s.replace(/\/{2,}/g, "/");
  s = s.replace(/\?.*$/, "");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s.toLowerCase();
}

export function joinRoute(prefix, methodPath) {
  const a = prefix ? `/${prefix}` : "";
  const b = methodPath ? `/${methodPath}` : "";
  const joined = `${a}${b}`.replace(/\/{2,}/g, "/") || "/";
  return normalisePath(joined);
}

// ─── controller parsing ──────────────────────────────────────────────────────

function collapseMultilineDecorators(content) {
  const lines = content.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("@")) {
      out.push(line);
      continue;
    }
    let depth = 0;
    for (const ch of line) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    if (depth <= 0) {
      out.push(line);
      continue;
    }
    let joined = line.trimEnd();
    while (depth > 0 && i + 1 < lines.length) {
      i++;
      const next = lines[i].trim();
      joined += next;
      for (const ch of next) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
    }
    out.push(joined);
  }
  return out.join("\n");
}

function emptyDecorators() {
  return {
    isPublic: false,
    isUniversal: false,
    permissionKeys: [],
    moduleIds: [],
    isOperator: false,
    isInService: false,
    hasHttpVerb: false,
    verbs: [],
    paths: [],
  };
}

function readDecorator(trimmed, buf) {
  if (PUBLIC_RE.test(trimmed)) buf.isPublic = true;
  if (UNIVERSAL_RE.test(trimmed)) buf.isUniversal = true;
  if (OPERATOR_RE.test(trimmed)) buf.isOperator = true;
  if (IN_SERVICE_RE.test(trimmed)) buf.isInService = true;
  // Every argument: the decorator is variadic, and a deny case must deny all of a route's keys to refuse it.
  for (const call of trimmed.matchAll(/@RequirePermission\s*\(([^)]*)\)/g))
    for (const m of call[1].matchAll(/["'`]([^"'`]+)["'`]/g)) buf.permissionKeys.push(m[1]);
  if (PERMISSION_RE.test(trimmed) && buf.permissionKeys.length === 0) buf.permissionKeys.push("*");
  for (const m of trimmed.matchAll(/@RequireModule\s*\(\s*["'`]([^"'`]+)["'`]/g)) buf.moduleIds.push(m[1]);
  if (MODULE_RE.test(trimmed) && buf.moduleIds.length === 0) buf.moduleIds.push("*");
  const verb = trimmed.match(HTTP_VERB_RE);
  if (verb) {
    buf.hasHttpVerb = true;
    buf.verbs.push(verb[1].toLowerCase());
    const arg = trimmed.match(/@(?:Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*["'`]([^"'`]*)["'`]/);
    buf.paths.push(arg ? arg[1] : "");
  }
}

/**
 * The handler body, from the declaration line to the end of its brace block.
 * Used only to read the service method a handler delegates to.
 */
function readBody(lines, from) {
  let depth = 0;
  let started = false;
  const out = [];
  for (let i = from; i < lines.length && i < from + 60; i++) {
    out.push(lines[i]);
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") depth--;
    }
    if (started && depth <= 0) break;
  }
  return out.join("\n");
}

export function parseController(rawContent) {
  const content = collapseMultilineDecorators(rawContent);
  const lines = content.split("\n");
  const handlers = [];

  let classDecorators = emptyDecorators();
  let className = null;
  let prefix = "";
  let pending = emptyDecorators();
  let inClass = false;
  let depth = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    if (depth > 0) {
      for (const ch of trimmed) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      continue;
    }

    if (trimmed.startsWith("@")) {
      let d = 0;
      for (const ch of trimmed) {
        if (ch === "(") d++;
        else if (ch === ")") d--;
      }
      if (d > 0) depth = d;
      const ctrl = trimmed.match(CONTROLLER_RE);
      if (ctrl) prefix = ctrl[1];
      else if (CONTROLLER_BARE_RE.test(trimmed)) prefix = "";
      readDecorator(trimmed, pending);
      continue;
    }

    const cls = trimmed.match(CLASS_RE);
    if (cls) {
      classDecorators = { ...pending };
      className = cls[3];
      pending = emptyDecorators();
      inClass = true;
      continue;
    }

    if (inClass && pending.hasHttpVerb) {
      const m = trimmed.match(METHOD_RE);
      if (m && !KEYWORDS.has(m[1]) && m[1] !== "constructor") {
        const handlerHasClassification =
          pending.isPublic ||
          pending.isUniversal ||
          pending.isInService ||
          pending.permissionKeys.length > 0;
        const eff = handlerHasClassification ? pending : classDecorators;

        const gateKinds = [];
        if (!eff.isPublic && !eff.isUniversal) {
          if (eff.permissionKeys.length > 0) gateKinds.push("permission");
          if (pending.moduleIds.length > 0 || classDecorators.moduleIds.length > 0) gateKinds.push("module");
          if (eff.isOperator || pending.isOperator || classDecorators.isOperator) gateKinds.push("operator");
        }

        const body = readBody(lines, idx);
        const delegates = [];
        for (const d of body.matchAll(/this\.(\w+)\s*\.\s*(\w+)\s*\(/g))
          delegates.push({ prop: d[1], method: d[2] });

        for (let v = 0; v < pending.verbs.length; v++) {
          handlers.push({
            controller: className,
            method: m[1],
            verb: pending.verbs[v],
            route: joinRoute(prefix, pending.paths[v] ?? ""),
            permissionKeys: eff.permissionKeys.filter((k) => k !== "*"),
            moduleIds: [...pending.moduleIds, ...classDecorators.moduleIds].filter((k) => k !== "*"),
            gateKinds,
            isPublic: eff.isPublic,
            isUniversal: eff.isUniversal,
            isInService: eff.isInService,
            delegates,
          });
        }
      }
    }
    pending = emptyDecorators();
  }
  return handlers;
}

/** `constructor(private readonly fooService: FooService)` -> prop -> class name */
export function parseInjectedTypes(content) {
  const map = new Map();
  for (const m of content.matchAll(
    /(?:private|public|protected|readonly)\s+(?:readonly\s+)?(\w+)\s*:\s*([A-Z]\w*)/g,
  ))
    map.set(m[1], m[2]);
  return map;
}

// ─── spec parsing ────────────────────────────────────────────────────────────

/**
 * `.get(` is `map.get(` and `reflector.get(` far more often than it is an HTTP
 * verb, and treating those as HTTP is how a scanner ends up "covering" every GET
 * in a file that never made a request. A verb call counts only when the receiver
 * is a supertest agent: `request(app.getHttpServer()).get(…)` — i.e. the verb is
 * chained off a closing paren — or the call is `callRoute("get", …)`.
 */
const ROUTE_LITERAL_RE = /["'`](\/[A-Za-z0-9_\-./:*${}]+)["'`]/g;
const VERB_LITERAL_CALL_RE = new RegExp(
  `\\)\\s*\\.\\s*(${HTTP_VERBS.join("|")})\\s*\\(\\s*["'\`](/[^"'\`]*)["'\`]`,
  "g",
);
const VERB_VARIABLE_CALL_RE = new RegExp(
  `\\)\\s*\\.\\s*(${HTTP_VERBS.join("|")})\\s*\\(\\s*[A-Za-z_$]`,
  "g",
);
const CALLROUTE_LITERAL_RE = new RegExp(
  `\\(\\s*["'\`](${HTTP_VERBS.join("|")})["'\`]\\s*,\\s*["'\`](/[^"'\`]*)["'\`]`,
  "gi",
);
const CALLROUTE_VARIABLE_RE = new RegExp(
  `\\(\\s*["'\`](${HTTP_VERBS.join("|")})["'\`]\\s*,\\s*[A-Za-z_$]`,
  "gi",
);
const TUPLE_PAIR_RE = new RegExp(
  `\\[\\s*["'\`](${HTTP_VERBS.join("|")})["'\`]\\s*,\\s*["'\`](/[^"'\`]*)["'\`]`,
  "gi",
);
const TITLE_PAIR_RE = new RegExp(`\\b(${HTTP_VERBS.join("|")})\\s+(/[A-Za-z0-9_\\-./:*\${}]+)`, "gi");

export function scanSpec(text, relPath) {
  const deny = denyKinds(text, relPath);
  const pairs = new Set();
  const indirectVerbs = new Set();
  const routeLiterals = new Set();
  let m;

  VERB_LITERAL_CALL_RE.lastIndex = 0;
  while ((m = VERB_LITERAL_CALL_RE.exec(text)) !== null) {
    const p = normalisePath(m[2]);
    if (p) pairs.add(`${m[1].toLowerCase()} ${p}`);
  }
  CALLROUTE_LITERAL_RE.lastIndex = 0;
  while ((m = CALLROUTE_LITERAL_RE.exec(text)) !== null) {
    const p = normalisePath(m[2]);
    if (p && p.startsWith("/")) pairs.add(`${m[1].toLowerCase()} ${p}`);
  }
  TUPLE_PAIR_RE.lastIndex = 0;
  while ((m = TUPLE_PAIR_RE.exec(text)) !== null) {
    const p = normalisePath(m[2]);
    if (p && p.startsWith("/")) pairs.add(`${m[1].toLowerCase()} ${p}`);
  }
  TITLE_PAIR_RE.lastIndex = 0;
  while ((m = TITLE_PAIR_RE.exec(text)) !== null) {
    const p = normalisePath(m[2]);
    if (p) pairs.add(`${m[1].toLowerCase()} ${p}`);
  }
  VERB_VARIABLE_CALL_RE.lastIndex = 0;
  while ((m = VERB_VARIABLE_CALL_RE.exec(text)) !== null) indirectVerbs.add(m[1].toLowerCase());
  CALLROUTE_VARIABLE_RE.lastIndex = 0;
  while ((m = CALLROUTE_VARIABLE_RE.exec(text)) !== null) indirectVerbs.add(m[1].toLowerCase());
  ROUTE_LITERAL_RE.lastIndex = 0;
  while ((m = ROUTE_LITERAL_RE.exec(text)) !== null) {
    const p = normalisePath(m[1]);
    if (p && p !== "/") routeLiterals.add(p);
  }

  const symbols = new Set();
  for (const s of text.matchAll(/\b([A-Z]\w*(?:Controller|Service))\b/g)) symbols.add(s[1]);
  const calls = new Set();
  for (const c of text.matchAll(/\.\s*(\w+)\s*\(/g)) calls.add(c[1]);

  return { deny, pairs, indirectVerbs, routeLiterals, symbols, calls };
}

// ─── coverage ────────────────────────────────────────────────────────────────

export function coverageLink(handler, spec, injected) {
  const admissible = admissibleDeny(handler.gateKinds ?? ["permission"]);
  let matched = false;
  for (const k of spec.deny) if (admissible.has(k)) matched = true;
  if (!matched) return null;
  const key = `${handler.verb} ${handler.route}`;
  if (spec.pairs.has(key)) return `ROUTE ${key}`;
  if (spec.indirectVerbs.has(handler.verb) && spec.routeLiterals.has(handler.route))
    return `ROUTE-INDIRECT ${key}`;
  if (handler.controller && spec.symbols.has(handler.controller) && spec.calls.has(handler.method))
    return `SYMBOL ${handler.controller}.${handler.method}`;
  for (const d of handler.delegates) {
    const cls = injected?.get(d.prop);
    if (cls && spec.symbols.has(cls) && spec.calls.has(d.method)) return `DELEGATE ${cls}.${d.method}`;
  }
  return null;
}

const MATRIX_DENY_KIND = { "403": "403", "402": "MODULE-DENIED", "404": "CROSS-TENANT-404" };
const MATRIX_ROUTE_RE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?]+)/g;

export function matrixDenyIndex(ledger) {
  const index = new Map();
  for (const entry of ledger?.entries ?? []) {
    if (entry.kind !== "binding" || entry.status !== "proven" || entry.expected === "allow") continue;
    if (entry.expected === "404" && entry.tenant !== "other") continue;
    const kind = MATRIX_DENY_KIND[entry.expected];
    if (kind === undefined) continue;
    for (const match of String(entry.entry).matchAll(MATRIX_ROUTE_RE)) {
      const key = `${match[1].toLowerCase()} ${normalisePath(match[2])}`;
      const kinds = index.get(key) ?? new Map();
      kinds.set(kind, [...(kinds.get(kind) ?? []), entry.id]);
      index.set(key, kinds);
    }
  }
  return index;
}

export function matrixDenyLink(handler, index) {
  const kinds = index.get(`${handler.verb} ${handler.route}`);
  if (kinds === undefined) return null;
  const admissible = admissibleDeny(handler.gateKinds ?? ["permission"]);
  for (const [kind, ids] of kinds) if (admissible.has(kind)) return `MATRIX ${kind} ${ids[0]}`;
  return null;
}

// ─── walking ─────────────────────────────────────────────────────────────────

function walk(dir, test, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, test, out);
    else if (test(entry)) out.push(full);
  }
  return out;
}

const isController = (n) => n.endsWith(".controller.ts") && !/\.(spec|e2e-spec)\.ts$/.test(n);
const isSpec = (n) => /\.(spec|e2e-spec)\.ts$/.test(n);

function analyse(root) {
  const controllerFiles = walk(join(root, "src"), isController, []);
  const specFiles = [...walk(join(root, "src"), isSpec, []), ...walk(join(root, "test"), isSpec, [])];

  const handlers = [];
  for (const f of controllerFiles) {
    const src = readFileSync(f, "utf8");
    const injected = parseInjectedTypes(src);
    for (const h of parseController(src)) handlers.push({ ...h, file: relative(root, f), injected });
  }

  const specs = [];
  for (const f of specFiles) {
    const rel = relative(root, f);
    specs.push({ file: rel, ...scanSpec(readFileSync(f, "utf8"), rel) });
  }
  const denySpecs = specs.filter((s) => s.deny.size > 0);

  const gated = handlers.filter((h) => h.gateKinds.length > 0);
  const inService = handlers.filter((h) => h.gateKinds.length === 0 && h.isInService);

  for (const h of gated) {
    h.link = null;
    h.coveredBy = null;
    for (const s of denySpecs) {
      const link = coverageLink(h, s, h.injected);
      if (link) {
        h.link = link;
        h.coveredBy = s.file;
        break;
      }
    }
  }

  return { controllerFiles, specFiles, handlers, specs, denySpecs, gated, inService };
}

// ─── self-test ───────────────────────────────────────────────────────────────

function runSelfTest() {
  let failures = 0;
  let ran = 0;
  const assert = (label, cond) => {
    ran++;
    if (!cond) {
      console.error(`  FAIL ${label}`);
      failures++;
    }
  };

  // -- unit assertions on the classifier -------------------------------------

  const matrixFixture = {
    entries: [
      { kind: "binding", id: "deny@http", status: "proven", expected: "403", tenant: "same", entry: "GET /hr/items/:itemId -> X" },
      { kind: "binding", id: "foreign@http", status: "proven", expected: "404", tenant: "other", entry: "DELETE /hr/items/:itemId" },
      { kind: "binding", id: "same404@http", status: "proven", expected: "404", tenant: "same", entry: "POST /hr/items/:itemId" },
      { kind: "binding", id: "failed@http", status: "failed", expected: "403", tenant: "same", entry: "PATCH /hr/items/:itemId" },
      { kind: "binding", id: "allow@http", status: "proven", expected: "allow", tenant: "same", entry: "PUT /hr/items/:itemId" },
    ],
  };
  const matrixIndexFixture = matrixDenyIndex(matrixFixture);
  const permissionHandler = (verb) => ({ verb, route: "/hr/items/*", gateKinds: ["permission"] });
  assert("a proven matrix 403 covers a permission-gated handler", matrixDenyLink(permissionHandler("get"), matrixIndexFixture) === "MATRIX 403 deny@http");
  assert("a proven cross-tenant matrix 404 covers a permission-gated handler", matrixDenyLink(permissionHandler("delete"), matrixIndexFixture) !== null);
  assert("an in-tenant matrix 404 is not a deny", matrixDenyLink(permissionHandler("post"), matrixIndexFixture) === null);
  assert("a failed matrix binding covers nothing", matrixDenyLink(permissionHandler("patch"), matrixIndexFixture) === null);
  assert("a proven matrix allow covers nothing", matrixDenyLink(permissionHandler("put"), matrixIndexFixture) === null);
  assert("a matrix 403 does not vouch for a module gate", matrixDenyLink({ verb: "get", route: "/hr/items/*", gateKinds: ["module"] }, matrixIndexFixture) === null);

  assert("normalisePath maps :id to *", normalisePath("/hr/employees/:id") === "/hr/employees/*");
  assert("normalisePath maps a template hole to *", normalisePath("/hr/employees/${id}/pay") === "/hr/employees/*/pay");
  assert("normalisePath strips a trailing slash", normalisePath("/hr/employees/") === "/hr/employees");
  assert("joinRoute joins prefix and method path", joinRoute("accounting", "periods") === "/accounting/periods");
  assert("joinRoute handles an empty method path", joinRoute("accounting", "") === "/accounting");

  const kindsOf = (t, p) => [...denyKinds(t, p)];
  assert("a 403 status assertion is a deny", kindsOf("expect(res.status).toBe(403);").includes("403"));
  assert("a supertest .expect(403) is a deny", kindsOf(".expect(403)").includes("403"));
  assert(
    "a thrown ForbiddenException is a deny",
    kindsOf("await expect(svc.x()).rejects.toThrow(ForbiddenException);").includes("FORBIDDEN"),
  );
  assert(
    "a module-specific Forbidden exception is a deny",
    kindsOf("await expect(svc.x()).rejects.toThrow(ProjectsForbiddenTicketException);").includes("FORBIDDEN"),
  );
  assert(
    "an IMPORTED ForbiddenException is not a deny",
    kindsOf('import { ForbiddenException } from "@nestjs/common";\nconst e = new ForbiddenException();').length === 0,
  );
  assert(
    "a ModuleDisabledException assertion is a MODULE-DENIED",
    kindsOf("await expect(guard.canActivate(ctx)).rejects.toThrow(ModuleDisabledException);").includes("MODULE-DENIED"),
  );
  assert(
    "a 402 without module-gate context is not a MODULE-DENIED",
    kindsOf("expect(res.status).toBe(402);").length === 0,
  );
  assert(
    "a 404 inside an isolation file is a cross-tenant deny",
    kindsOf("expect(res.status).toBe(404);", "src/modules/x/x-tenant-isolation.spec.ts").includes("CROSS-TENANT-404"),
  );
  assert(
    "a 404 outside an isolation file is NOT a deny",
    kindsOf("expect(res.status).toBe(404);", "src/modules/x/x.service.spec.ts").length === 0,
  );
  assert(
    "a permission gate does not admit a MODULE-DENIED-only spec",
    coverageLink(
      { verb: "get", route: "/x", controller: "XController", method: "list", gateKinds: ["permission"], delegates: [] },
      scanSpec("await expect(guard.canActivate(ctx)).rejects.toThrow(ModuleDisabledException); const r = await request(app).get(\"/x\");", "a.spec.ts"),
      new Map(),
    ) === null,
  );
  assert(
    "a module gate DOES admit a MODULE-DENIED spec",
    coverageLink(
      { verb: "get", route: "/x", controller: "XController", method: "list", gateKinds: ["module"], delegates: [] },
      scanSpec("await expect(guard.canActivate(ctx)).rejects.toThrow(ModuleDisabledException);\nit(\"GET /x is blocked\", () => {});", "a.spec.ts"),
      new Map(),
    ) !== null,
  );
  assert(
    "a [verb, path] row of a route table in a 403 spec links that route",
    coverageLink(
      { verb: "get", route: "/x/*/items", controller: "XController", method: "list", gateKinds: ["permission"], delegates: [] },
      scanSpec('const routes = [["get", `/x/${ID}/items`], ["post", "/y"]];\nit.each(routes)("403 on %s %s", async (method, path) => { expect((await callRoute(method, path, token)).status).toBe(403); });', "a.e2e-spec.ts"),
      new Map(),
    ) !== null,
  );
  assert(
    "a [verb, path] row with a hard-coded id does not link the parameterised route",
    coverageLink(
      { verb: "get", route: "/x/*/items", controller: "XController", method: "list", gateKinds: ["permission"], delegates: [] },
      scanSpec('const routes = [["get", "/x/1/items"]];\nexpect(res.status).toBe(403);', "a.e2e-spec.ts"),
      new Map(),
    ) === null,
  );
  assert(
    "a map.get() is not an HTTP GET",
    scanSpec('const v = cache.get("/x"); expect(res.status).toBe(403);', "a.spec.ts").pairs.size === 0,
  );

  const ctrl = `
@Controller("accounting")
@RequireModule("accounting")
export class PeriodsController {
  constructor(private readonly periodsService: PeriodsService) {}

  @Get("periods")
  @RequirePermission("accounting:periods:read")
  list(@CurrentUser() user: AuthUser) {
    return this.periodsService.list(user.orgId);
  }

  @Post("periods")
  @RequirePermission("accounting:periods:manage")
  create(@Body() body: CreatePeriodDto) {
    return this.periodsService.create(body);
  }

  @Get("ping")
  @Public()
  ping() {
    return "ok";
  }

  @Get("me/periods")
  @Universal()
  mine() {
    return this.periodsService.mine();
  }
}
`;
  const parsed = parseController(ctrl);
  assert("every handler is parsed", parsed.length === 4);
  const list = parsed.find((h) => h.method === "list");
  const ping = parsed.find((h) => h.method === "ping");
  const mine = parsed.find((h) => h.method === "mine");
  assert("the gated GET resolves its full route", list?.route === "/accounting/periods");
  assert("the gated GET carries its permission key", list?.permissionKeys[0] === "accounting:periods:read");
  assert("the gated GET is gated", (list?.gateKinds ?? []).includes("permission"));
  assert("a class @RequireModule reaches the handler", (list?.gateKinds ?? []).includes("module"));
  assert("a @Public() handler is NOT gated", (ping?.gateKinds ?? []).length === 0);
  assert("a @Universal() handler is NOT gated", (mine?.gateKinds ?? []).length === 0);
  assert("the delegate service method is read from the body", list?.delegates?.some((d) => d.method === "list") === true);
  assert(
    "the injected service type is resolved",
    parseInjectedTypes(ctrl).get("periodsService") === "PeriodsService",
  );

  const routeSpec = scanSpec(
    `it("GET /accounting/periods returns 403 without the key", async () => {
       const res = await request(app.getHttpServer()).get("/accounting/periods");
       expect(res.status).toBe(403);
     });`,
    "src/modules/accounting/gl/periods.controller.spec.ts",
  );
  assert("a literal verb+path pair is read", routeSpec.pairs.has("get /accounting/periods"));
  assert("a route link covers the handler", coverageLink(list, routeSpec, new Map())?.startsWith("ROUTE ") === true);
  assert("a route link does not cover a different verb", coverageLink(parsed.find((h) => h.method === "create"), routeSpec, new Map()) === null);

  const eachSpec = scanSpec(
    `const gatedGetRoutes = ["/accounting/periods", "/accounting/journals"];
     it.each(gatedGetRoutes)("403 on GET %s", async (path) => {
       const res = await callRoute("get", path);
       expect(res.status).toBe(403);
     });`,
    "src/modules/accounting/gl/periods.controller.spec.ts",
  );
  assert("an it.each route table is linked indirectly", coverageLink(list, eachSpec, new Map())?.startsWith("ROUTE-INDIRECT") === true);
  assert(
    "an indirect GET table does not cover a POST handler",
    coverageLink(parsed.find((h) => h.method === "create"), eachSpec, new Map()) === null,
  );

  const symbolSpec = scanSpec(
    `describe("PeriodsController", () => {
       it("refuses without the key", async () => {
         await expect(controller.list(user)).rejects.toThrow(ForbiddenException);
       });
     });`,
    "src/modules/accounting/gl/periods.controller.spec.ts",
  );
  assert("a symbol link covers the handler", coverageLink(list, symbolSpec, new Map())?.startsWith("SYMBOL") === true);

  const delegateSpec = scanSpec(
    `describe("PeriodsService", () => {
       it("refuses a foreign org", async () => {
         await expect(service.list("other-org")).rejects.toThrow(ForbiddenException);
       });
     });`,
    "src/modules/accounting/gl/periods.service.spec.ts",
  );
  assert(
    "a delegate link covers the handler",
    coverageLink(list, delegateSpec, parseInjectedTypes(ctrl))?.startsWith("DELEGATE") === true,
  );

  const allowOnlySpec = scanSpec(
    `it("GET /accounting/periods returns 200 with the key", async () => {
       const res = await request(app.getHttpServer()).get("/accounting/periods");
       expect(res.status).toBe(200);
     });`,
    "src/modules/accounting/gl/periods.controller.spec.ts",
  );
  assert("a spec with no deny assertion covers nothing", coverageLink(list, allowOnlySpec, new Map()) === null);

  // -- end-to-end: a temp fixture tree, planted defect in and out -------------

  const tmp = join(BACKEND_ROOT, ".authz-deny-selftest");
  const write = (rel, body) => {
    const p = join(tmp, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  };
  rmSync(tmp, { recursive: true, force: true });

  write("src/modules/demo/demo.controller.ts", ctrl);
  write(
    "src/modules/demo/demo.controller.spec.ts",
    `describe("PeriodsController", () => {
       it("GET /accounting/periods returns 403 without accounting:periods:read", async () => {
         const res = await request(app.getHttpServer()).get("/accounting/periods");
         expect(res.status).toBe(403);
       });
       it("POST /accounting/periods returns 403 without accounting:periods:manage", async () => {
         const res = await request(app.getHttpServer()).post("/accounting/periods");
         expect(res.status).toBe(403);
       });
     });`,
  );

  const clean = analyse(tmp);
  assert("the fixture tree yields exactly 2 gated handlers", clean.gated.length === 2);
  assert(
    "both gated handlers are covered in the clean fixture",
    clean.gated.every((h) => h.link !== null),
  );

  write(
    "src/modules/demo/extra.controller.ts",
    `@Controller("payroll")
export class PayrollController {
  @Post("runs/:id/lock")
  @RequirePermission("payroll:runs:manage")
  lock(@Param("id") id: string) {
    return this.runsService.lock(id);
  }
}
`,
  );
  const planted = analyse(tmp);
  assert("the planted gated handler enters the population", planted.gated.length === 3);
  const uncovered = planted.gated.filter((h) => h.link === null);
  assert("the planted gated handler is UNCOVERED", uncovered.length === 1);
  assert(
    "the uncovered one is the planted route",
    uncovered[0]?.route === "/payroll/runs/*/lock" && uncovered[0]?.verb === "post",
  );

  write(
    "src/modules/demo/extra.controller.spec.ts",
    `it("POST /payroll/runs/:id/lock returns 403 without payroll:runs:manage", async () => {
       const res = await request(app.getHttpServer()).post("/payroll/runs/abc/lock");
       expect(res.status).toBe(403);
     });`,
  );
  const repaired = analyse(tmp);
  assert(
    "adding the deny test covers the planted handler",
    repaired.gated.filter((h) => h.link === null).length === 0,
  );

  rmSync(tmp, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`check-authz-deny self-test: ${failures} failed of ${ran}`);
    process.exit(1);
  }
  console.log(`check-authz-deny self-tests: ${ran} passed`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

// ─── run ─────────────────────────────────────────────────────────────────────

const { controllerFiles, specFiles, handlers, denySpecs, gated, inService } = analyse(BACKEND_ROOT);

if (controllerFiles.length < MIN_CONTROLLERS) {
  console.error(
    `INCONCLUSIVE — walked ${controllerFiles.length} controller files (floor ${MIN_CONTROLLERS}). The walk is broken; "every handler covered" would prove nothing.`,
  );
  process.exit(2);
}
if (gated.length < MIN_GATED) {
  console.error(
    `INCONCLUSIVE — found ${gated.length} authorization-gated handlers (floor ${MIN_GATED}). The decorator parser is broken.`,
  );
  process.exit(2);
}
if (denySpecs.length < MIN_DENY_SPECS) {
  console.error(
    `INCONCLUSIVE — found ${denySpecs.length} spec files asserting a deny (floor ${MIN_DENY_SPECS}). The deny matcher is broken.`,
  );
  process.exit(2);
}

const matrixLedger = existsSync(MATRIX_LEDGER_PATH) ? JSON.parse(readFileSync(MATRIX_LEDGER_PATH, "utf8")) : null;
const matrixState = ROOT_OVERRIDE ? "not consulted under --root" : matrixFreshness(matrixLedger);
const matrixIndex = matrixState === "fresh" ? matrixDenyIndex(matrixLedger) : new Map();
let matrixProven = 0;
for (const h of gated) {
  if (h.link !== null) continue;
  const link = matrixDenyLink(h, matrixIndex);
  if (link === null) continue;
  h.link = link;
  h.coveredBy = relative(BACKEND_ROOT, MATRIX_LEDGER_PATH);
  matrixProven++;
}

const covered = gated.filter((h) => h.link !== null);
const uncovered = gated.filter((h) => h.link === null);
const pct = Math.round((covered.length / gated.length) * 100);

if (WHY) {
  const want = WHY.trim().toLowerCase();
  const hits = gated.filter(
    (h) => `${h.verb} ${h.route}` === want || h.route === normalisePath(WHY) || `${h.controller}.${h.method}` === WHY,
  );
  if (hits.length === 0) {
    console.error(`No gated handler matches "${WHY}".`);
    process.exit(2);
  }
  for (const h of hits) {
    console.log(`${h.verb.toUpperCase()} ${h.route}   ${h.controller}.${h.method}`);
    console.log(`  file        ${h.file}`);
    console.log(`  gate        ${h.gateKinds.join("+")}  ${[...h.permissionKeys, ...h.moduleIds].join(", ")}`);
    console.log(h.link ? `  COVERED     ${h.link}\n  by          ${h.coveredBy}` : "  UNCOVERED   no spec asserts this handler's deny branch");
  }
  process.exit(0);
}

/**
 * The identity of one uncovered handler, in the baseline and in the comparison.
 *
 * Separators are normalised because `relative()` emits the HOST's, and the
 * committed baseline was measured on Windows: every one of its 2,196 entries
 * spells `src\modules\…`. Read verbatim on a POSIX host, not a single key
 * matched, so the "newly uncovered" set printed on a failure was the WHOLE
 * uncovered set — the report named 40 handlers that had been in the baseline
 * since it was written and said nothing about the ones that had just landed.
 * The count was right and the diagnosis was unusable.
 */
function handlerKey(h) {
  return `${h.verb.toUpperCase()} ${h.route}  ${h.controller}.${h.method}  (${String(h.file).replaceAll("\\", "/")})`;
}

/** The same normalisation applied to a line already written into the baseline. */
function normaliseBaselineKey(line) {
  return String(line).replaceAll("\\", "/");
}

if (EMIT_BASELINE) {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        note: "Authorization-gated handlers with NO attributable deny test. The ratchet is the count measured when this gate was written; it is a floor to walk down, never a score to hold. It may only go DOWN. A new gated handler that lands without a deny test pushes the count above it and fails CI.",
        measured: new Date().toISOString().slice(0, 10),
        gatedHandlers: gated.length,
        covered: covered.length,
        uncovered: uncovered.length,
        uncoveredRatchet: uncovered.length,
        uncoveredHandlers: uncovered.map(handlerKey).sort(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Baseline written to ${relative(BACKEND_ROOT, BASELINE_PATH)} — uncovered ${uncovered.length}`);
  process.exit(0);
}

console.log(`Controller files          ${controllerFiles.length}`);
console.log(`Spec files                ${specFiles.length}  ·  asserting a deny ${denySpecs.length}`);
console.log(`HTTP handlers             ${handlers.length}`);
console.log(`  — authorization-gated   ${gated.length}`);
console.log(`  — @AuthorizedInService  ${inService.length}  (INFO, not gated — see the header)`);
console.log(`Gated handlers with a DECLARED deny test  ${covered.length} / ${gated.length}  (${pct}%)`);
console.log(`  — covered only by a matrix-proven refusal  ${matrixProven}  (RBAC matrix ledger ${matrixState})`);
console.log("");
console.log("NOTE: this gate is static. It proves a deny test EXISTS and is attributable to the");
console.log("      handler; it does not run it. Attribution is per spec FILE, not per it() block.");
console.log("");

if (LIST || UNCOVERED_ONLY) {
  const rows = UNCOVERED_ONLY ? uncovered : gated;
  for (const h of rows.sort((a, b) => `${a.route}${a.verb}`.localeCompare(`${b.route}${b.verb}`)))
    console.log(
      `  ${(h.link ? "COVERED" : "UNCOVERED").padEnd(10)} ${h.verb.toUpperCase().padEnd(6)} ${h.route.padEnd(60)} ${h.controller}.${h.method}${h.link ? `   <- ${h.link}  [${h.coveredBy}]` : ""}`,
    );
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error(`FAIL — no baseline at ${relative(BACKEND_ROOT, BASELINE_PATH)}. Run --emit-baseline once and commit it.`);
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const ratchet = baseline.uncoveredRatchet;
if (typeof ratchet !== "number") {
  console.error(`FAIL — baseline ${relative(BACKEND_ROOT, BASELINE_PATH)} has no numeric uncoveredRatchet.`);
  process.exit(1);
}

if (uncovered.length > ratchet) {
  const known = new Set((baseline.uncoveredHandlers ?? []).map(normaliseBaselineKey));
  const fresh = uncovered.filter((h) => !known.has(handlerKey(h)));
  console.error(
    `\nFAIL — ${uncovered.length} authorization-gated handler(s) have no attributable deny test, ${uncovered.length - ratchet} above the ratchet of ${ratchet}.`,
  );
  console.error(
    "A gated handler whose deny branch is never asserted proves the decorator was typed, not that the guard denies.\n",
  );
  for (const h of (fresh.length > 0 ? fresh : uncovered).slice(0, 40))
    console.error(
      `  ${h.verb.toUpperCase().padEnd(6)} ${h.route.padEnd(60)} ${h.controller}.${h.method}   ${h.file}`,
    );
  if ((fresh.length > 0 ? fresh : uncovered).length > 40)
    console.error(`  … and ${(fresh.length > 0 ? fresh : uncovered).length - 40} more`);
  process.exit(1);
}

if (uncovered.length < ratchet)
  console.log(
    `Uncovered ${uncovered.length} is BELOW the ratchet of ${ratchet}. Lower uncoveredRatchet in ${relative(BACKEND_ROOT, BASELINE_PATH)} to ${uncovered.length} to bank it.`,
  );

console.log(
  `OK — uncovered ${uncovered.length} (ratchet ${ratchet}). No new authorization-gated handler landed without a deny test.`,
);
process.exit(0);
