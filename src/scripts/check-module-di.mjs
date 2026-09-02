#!/usr/bin/env node
/**
 * check-module-di.mjs
 *
 * Finds @Module() metadata that NestJS rejects at boot.
 *
 * THE REFERENCE DEFECT
 * StorageModule imported AvScannerModule and then wrote
 * `exports: [StorageService, AvScanner]` — exporting the provider TOKEN rather
 * than the module that provides it. Nest throws at bootstrap:
 * "cannot export a provider that is not part of the currently processed module".
 * The API never starts. tsc, madge, knip and the whole unit suite are green,
 * because nothing in that toolchain builds the injector.
 *
 * THE RULE
 * Every entry in `exports` must be either
 *   (a) provided by this module — a bare class in `providers`, or the `provide:`
 *       token of a custom provider object, or
 *   (b) a module listed in `imports` (re-exporting a module is legal;
 *       re-exporting someone else's provider token is not).
 * Anything else is a boot failure.
 *
 * DETECTION STRATEGY
 * 1. Walk every *.module.ts under src (Node.js filesystem, no shell glob —
 *    a quoted glob returns nothing on Windows and the scan passes vacuously).
 * 2. Extract the @Module({...}) object with a brace-balanced scan that ignores
 *    braces inside strings, template literals and comments.
 * 3. Split imports/providers/exports into top-level entries with a
 *    depth-tracking splitter, so `{ provide: X, useFactory: (a, b) => ... }`
 *    stays one entry and its internal commas do not tear it apart.
 * 4. Normalise each entry to a token: unwrap forwardRef(() => X), strip
 *    .forRoot(...)/.register(...)/.forFeature(...), read `provide:` out of a
 *    custom provider object.
 * 5. Report every export token absent from providers and from imports.
 *
 * CHECK D — a provider class NO reachable module registers
 * The three checks below all presuppose the class is in the injector. Check D
 * asks whether it is there at all: an @Injectable() listed in no module's
 * `providers` is never constructed, so its onModuleInit never fires and the
 * feature it implements silently does not exist, with a green typecheck and a
 * green unit spec throughout. Detection walks the real module graph from
 * AppModule — resolving hoisted `imports: BUILD_MODULES` consts, barrel
 * re-exports, forwardRef, `Foo.forRoot()` and `useClass:` — and reports every
 * decorated class the walk never reaches. See the section header for the
 * exemption taxonomy.
 *
 * ADDITIONAL DI CONSTRUCTOR CHECKS (Checks A, B, C)
 * Check A — undeclared token: a constructor parameter whose type resolves to a
 *   class not in the module's providers, not in any imported module's exports,
 *   and not in a @Global() module's exports.
 * Check B — non-injectable type: a parameter typed unknown, any, object, a
 *   primitive, a union without a clear class identity, or an array — none of
 *   which carry a runtime DI token. @Inject(TOKEN) exempts a parameter.
 * Check C — import type on injected class: a parameter whose class type is
 *   imported via `import type { X }` or `import { type X }` with no @Inject.
 *   TypeScript erases the import so design:paramtypes becomes undefined.
 *
 * VACUITY GUARDS
 * - Fewer than 100 module files found → exit 2 ("walk is broken")
 * - Zero @Module decorators parsed → exit 2
 *
 * SELF-TEST (--self-test)
 * Runs detection functions over synthetic fixtures; includes both the existing
 * export check cases and new cases for Checks A, B, C.
 *
 * Usage:
 *   node src/scripts/check-module-di.mjs [--self-test]
 *   pnpm check:module-di
 *   pnpm check:module-di:self-test
 *
 * Exit codes:
 *   0 — clean (or self-test passed)
 *   1 — invalid exports, DI violations or unregistered providers found
 *       (or self-test failed)
 *   2 — scan is broken (vacuity check failed)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const VERBOSE = process.argv.includes("--verbose");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const SRC_ROOT = join(BACKEND_ROOT, "src");

const MIN_MODULE_FILES = 100;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".module.ts")) out.push(full);
  }
  return out;
}

/**
 * Returns the source index just past the opening brace of the @Module object,
 * or -1. Skips strings, template literals and comments so a brace inside them
 * never opens or closes a level.
 */
export function findModuleObjectStart(src) {
  const marker = src.indexOf("@Module(");
  if (marker === -1) return -1;
  for (let i = marker + "@Module(".length; i < src.length; i++) {
    const ch = src[i];
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") continue;
    return ch === "{" ? i + 1 : -1;
  }
  return -1;
}

export function extractBalanced(src, startIndex) {
  let depth = 1;
  let i = startIndex;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) break;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth === 0) return src.slice(startIndex, i);
    }
    i++;
  }
  return null;
}

/** Pulls `key: [ ... ]` out of the module object, brace/bracket aware. */
export function extractArray(objectSrc, key) {
  const re = new RegExp(`(^|[\\s,{])${key}\\s*:\\s*\\[`, "m");
  const m = re.exec(objectSrc);
  if (!m) return null;
  const open = m.index + m[0].length;
  const body = extractBalanced(objectSrc, open);
  return body === null ? null : body;
}

/** Splits an array body into top-level entries, ignoring nested commas. */
export function splitTopLevel(arrayBody) {
  const parts = [];
  let depth = 0;
  let current = "";
  let i = 0;
  while (i < arrayBody.length) {
    const ch = arrayBody[i];
    const next = arrayBody[i + 1];
    if (ch === "/" && next === "/") {
      while (i < arrayBody.length && arrayBody[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < arrayBody.length && !(arrayBody[i] === "*" && arrayBody[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      current += ch;
      i++;
      while (i < arrayBody.length) {
        current += arrayBody[i];
        if (arrayBody[i] === "\\") { current += arrayBody[i + 1] ?? ""; i += 2; continue; }
        if (arrayBody[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (ch === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const CHAINED_FACTORY = /^([A-Za-z_$][\w$]*)\s*\./;
const FORWARD_REF = /^forwardRef\s*\(\s*\(\s*\)\s*=>\s*([A-Za-z_$][\w$]*)/;
const BARE_IDENT = /^([A-Za-z_$][\w$]*)$/;

/** Normalises one imports/providers/exports entry to the token it contributes. */
export function tokenOf(entry) {
  const text = entry.trim();
  const fwd = FORWARD_REF.exec(text);
  if (fwd) return fwd[1];
  if (text.startsWith("{")) {
    const provide = /(^|[\s,{])provide\s*:\s*([A-Za-z_$][\w$]*)/.exec(text);
    return provide ? provide[2] : null;
  }
  const bare = BARE_IDENT.exec(text);
  if (bare) return bare[1];
  const chained = CHAINED_FACTORY.exec(text);
  if (chained) return chained[1];
  return null;
}

export function analyseModuleSource(src) {
  const start = findModuleObjectStart(src);
  if (start === -1) return null;
  const object = extractBalanced(src, start);
  if (object === null) return null;

  const read = (key) => {
    const body = extractArray(object, key);
    if (body === null) return [];
    return splitTopLevel(body).map(tokenOf).filter((t) => t !== null);
  };

  const imports = read("imports");
  const providers = read("providers");
  const exports_ = read("exports");
  const available = new Set([...imports, ...providers]);
  const invalid = exports_.filter((t) => !available.has(t));
  return { imports, providers, exports: exports_, invalid };
}

// ─── DI CONSTRUCTOR ANALYSIS ───────────────────────────────────────────────

/**
 * NestJS framework tokens always available via platform DI without any module
 * registration. Exempt from Check A.
 */
const NEST_FRAMEWORK_TOKENS = new Set([
  "Reflector",
  "ModuleRef",
  "ApplicationRef",
  "HttpServer",
  "HttpAdapter",
  "ContextId",
  "ExternalContextCreator",
  "Logger",
  "DiscoveryService",
  "MetadataScanner",
]);

function isGlobalModule(src) {
  return /@Global\s*\(\s*\)/.test(src);
}

function extractModuleClassName(src) {
  const pos = src.lastIndexOf("@Module(");
  if (pos === -1) return null;
  const after = src.slice(pos);
  const m = /\bexport\s+class\s+([A-Za-z_$][\w$]*)/.exec(after);
  return m?.[1] ?? null;
}

/**
 * Returns the implementation class from a provider entry, or null if there
 * is no class to instantiate (useValue / useFactory / useExisting / no class).
 */
function implClassOf(entry) {
  const text = entry.trim();
  if (text.startsWith("{")) {
    const uc = /\buseClass\s*:\s*([A-Za-z_$][\w$]*)/.exec(text);
    if (uc) return uc[1];
    return null;
  }
  const fwd = FORWARD_REF.exec(text);
  if (fwd) return fwd[1];
  const bare = BARE_IDENT.exec(text);
  if (bare) return bare[1];
  return null;
}

/**
 * When an exports/imports array entry is an ALL_CAPS or camelCase constant
 * (e.g. `KB_MODULES`, `MODULES`), try to inline-expand it by finding the
 * constant's declaration in the same source file.
 * Returns a flat array of tokens (same shape as splitTopLevel → tokenOf).
 * Falls back to [constName] when the constant cannot be resolved.
 */
function resolveConstantArray(src, constName) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:const|let|var)\\s+${constName}\\s*(?::[^=]+)?=\\s*\\[`);
  const m = re.exec(src);
  if (!m) return [constName];
  const openBracket = src.indexOf("[", m.index + m[0].length - 1);
  if (openBracket === -1) return [constName];
  const body = extractBalanced(src, openBracket + 1);
  if (!body) return [constName];
  return splitTopLevel(body).map(tokenOf).filter(Boolean);
}

/**
 * Returns true if a token looks like a constant name (ALL_CAPS or _-separated)
 * rather than a PascalCase class name.
 */
function isConstantName(token) {
  return /^[A-Z][A-Z0-9_]*$/.test(token) && /[_0-9]/.test(token.slice(1));
}

/**
 * Builds a registry of all modules from module files.
 * Returns Map<moduleClassName, moduleInfo>.
 */
function buildModuleGraph(moduleFiles) {
  const registry = new Map();
  for (const file of moduleFiles) {
    let src;
    try { src = readFileSync(file, "utf8"); } catch { continue; }

    const className = extractModuleClassName(src);
    if (!className) continue;

    const start = findModuleObjectStart(src);
    if (start === -1) continue;
    const object = extractBalanced(src, start);
    if (!object) continue;

    const readTokens = (key) => {
      const body = extractArray(object, key);
      const rawList = body !== null
        ? splitTopLevel(body).map(tokenOf).filter(Boolean)
        : (() => {
            const re = new RegExp(`(?:^|[\\s,{])${key}\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*(?:[,}]|$)`, "m");
            const mm = re.exec(object);
            return mm ? [mm[1]] : [];
          })();
      const expanded = [];
      for (const t of rawList) {
        if (isConstantName(t)) {
          for (const resolved of resolveConstantArray(src, t)) expanded.push(resolved);
        } else {
          expanded.push(t);
        }
      }
      return expanded;
    };

    const readRaw = (key) => {
      const body = extractArray(object, key);
      if (!body) return [];
      return splitTopLevel(body);
    };

    const providerEntries = readRaw("providers");
    const providers = providerEntries.map(tokenOf).filter(Boolean);
    const implClasses = providerEntries.map(implClassOf).filter(Boolean);
    const imports = readTokens("imports");
    const exports = readTokens("exports");
    const controllers = readRaw("controllers").map(tokenOf).filter(Boolean);

    registry.set(className, {
      className,
      filePath: file,
      isGlobal: isGlobalModule(src),
      providers,
      implClasses,
      imports,
      exports,
      controllers,
    });
  }
  return registry;
}

/**
 * Returns the set of provider tokens that moduleClassName transitively exports
 * (following re-exported modules). Cycles are guarded by `seen`.
 */
function computeModuleExports(moduleClassName, registry, seen = new Set()) {
  if (seen.has(moduleClassName)) return new Set();
  seen.add(moduleClassName);
  const m = registry.get(moduleClassName);
  if (!m) return new Set();
  const result = new Set();
  for (const exp of m.exports) {
    if (registry.has(exp)) {
      for (const t of computeModuleExports(exp, registry, seen)) result.add(t);
    } else {
      result.add(exp);
    }
  }
  return result;
}

/**
 * Returns the full set of tokens injectable into services within moduleClassName:
 * - own providers
 * - exports of every imported module (transitively)
 * - globalExports from @Global() modules
 * - NEST_FRAMEWORK_TOKENS
 */
function computeVisibleTokens(moduleClassName, registry, globalExports) {
  const m = registry.get(moduleClassName);
  if (!m) return new Set([...globalExports, ...NEST_FRAMEWORK_TOKENS]);

  const visible = new Set(m.providers);
  for (const imp of m.imports) {
    for (const t of computeModuleExports(imp, registry)) visible.add(t);
  }
  for (const t of globalExports) visible.add(t);
  for (const t of NEST_FRAMEWORK_TOKENS) visible.add(t);
  return visible;
}

/**
 * Parses the import statements of a source file to find which identifiers are
 * imported via `import type { X }` or `import { type X }`.
 * Returns { typeOnly: Set<string>, regular: Set<string> }.
 */
function parseImportTypes(src) {
  const typeOnly = new Set();
  const regular = new Set();

  for (const m of src.matchAll(/\bimport\s+type\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(",")) {
      const raw = part.replace(/\bas\s+\w+/, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(raw)) typeOnly.add(raw);
    }
  }

  for (const m of src.matchAll(/\bimport\s*\{([^}]+)\}\s*from/g)) {
    for (const part of m[1].split(",")) {
      const trimmed = part.trim();
      if (trimmed.startsWith("type ")) {
        const name = trimmed.slice(5).replace(/\bas\s+\w+/, "").trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) typeOnly.add(name);
      } else {
        const name = trimmed.split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) regular.add(name);
      }
    }
  }

  return { typeOnly, regular };
}

/**
 * Extracts the balanced content of `(...)` starting from the `(` at src[0].
 * Returns the content between the parens (exclusive), or '' if empty.
 */
function extractParenContent(src) {
  if (!src.startsWith("(")) return null;
  return extractBalanced(src, 1) ?? "";
}

/**
 * Parses a single constructor parameter text and returns its structure, or
 * null if the text does not look like a valid parameter.
 *
 * Returns: { index, name, type, injectToken, optional, decorators }
 *   injectToken: string if @Inject(X) is present, null otherwise
 *   optional: true if @Optional() or ? suffix is present
 */
function parseOneParam(rawText, index) {
  let text = rawText.trim();
  if (!text) return null;

  const decorators = [];

  while (text.startsWith("@")) {
    const nameMatch = /^@([A-Za-z_$][\w$]*)/.exec(text);
    if (!nameMatch) break;
    const decName = nameMatch[1];
    text = text.slice(nameMatch[0].length);
    let args = null;
    const trimmed = text.trimStart();
    if (trimmed.startsWith("(")) {
      text = trimmed;
      args = extractParenContent(text) ?? "";
      text = text.slice(1 + args.length + 1);
    }
    decorators.push({ name: decName, args });
    text = text.trimStart();
  }

  const MODIFIERS = ["private", "protected", "public", "readonly", "static", "override", "abstract", "declare"];
  let changed = true;
  while (changed) {
    changed = false;
    for (const mod of MODIFIERS) {
      if (text.startsWith(mod) && /^\W/.test(text.slice(mod.length) || " ")) {
        text = text.slice(mod.length).trimStart();
        changed = true;
      }
    }
  }

  const nameMatch = /^([A-Za-z_$][\w$]*)(\s*\?)?/.exec(text);
  if (!nameMatch) return null;

  const paramName = nameMatch[1];
  const optional = (nameMatch[2] ?? "").trim() === "?";
  text = text.slice(nameMatch[0].length).trimStart();

  let type = null;
  if (text.startsWith(":")) {
    type = text.slice(1).trim();
    if (type) {
      let depth = 0;
      for (let j = 0; j < type.length; j++) {
        const c = type[j];
        if (c === "<" || c === "(" || c === "[" || c === "{") depth++;
        else if (c === ">" || c === ")" || c === "]" || c === "}") depth--;
        else if (c === "=" && depth === 0 && type[j + 1] !== ">") {
          type = type.slice(0, j).trim();
          break;
        }
      }
    }
  }

  let injectToken = null;
  let isOptional = optional;

  for (const dec of decorators) {
    if (dec.name === "Optional") isOptional = true;
    if (dec.name === "Inject" && dec.args !== null) {
      injectToken = dec.args.trim();
    }
    if (dec.name !== "Injectable" && /^Inject[A-Z]/.test(dec.name)) {
      if (injectToken === null) injectToken = dec.args?.trim() ?? dec.name;
    }
  }

  return { index, name: paramName, type, decorators, injectToken, optional: isOptional };
}

/**
 * Finds the constructor of a class in source text and returns an array of
 * parsed parameters, or [] if no constructor is found.
 * When className is provided, first scopes to that class body so that a
 * non-injectable error class defined before the @Injectable() class is not
 * mistakenly parsed.
 */
function parseConstructorParams(src, className = null) {
  let searchSrc = src;
  if (className) {
    const classRe = new RegExp(`\\bclass\\s+${className}\\b`);
    const classMatch = classRe.exec(src);
    if (classMatch) {
      let i = classMatch.index + classMatch[0].length;
      while (i < src.length && src[i] !== "{") i++;
      if (i < src.length) {
        const classBody = extractBalanced(src, i + 1);
        if (classBody) searchSrc = classBody;
      }
    }
  }
  const m = /\bconstructor\s*\(/.exec(searchSrc);
  if (!m) return [];
  const paramStart = m.index + m[0].length;
  const paramBody = extractBalanced(searchSrc, paramStart);
  if (!paramBody || !paramBody.trim()) return [];
  const rawParams = splitTopLevel(paramBody);
  const params = [];
  for (let i = 0; i < rawParams.length; i++) {
    const p = parseOneParam(rawParams[i], i);
    if (p) params.push(p);
  }
  return params;
}

/**
 * Returns true if typeStr contains a top-level `|` (union type).
 */
function hasTopLevelBar(typeStr) {
  let depth = 0;
  for (let i = 0; i < typeStr.length; i++) {
    const ch = typeStr[i];
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "|" && depth === 0) return true;
  }
  return false;
}

/**
 * Splits a union type into its arms at top-level `|` boundaries.
 */
function splitUnionArms(typeStr) {
  const arms = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < typeStr.length; i++) {
    const ch = typeStr[i];
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") { depth++; current += ch; }
    else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") { depth--; current += ch; }
    else if (ch === "|" && depth === 0) {
      if (current.trim()) arms.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) arms.push(current.trim());
  return arms;
}

const NON_INJECTABLE_KEYWORDS = new Set(["unknown", "any", "never", "void", "object", "Object"]);
const NULLABLE_ARMS = new Set(["null", "undefined"]);
const PRIMITIVE_TYPES = new Set(["string", "number", "boolean", "bigint", "symbol", "true", "false"]);

/**
 * Check B: returns true if the type annotation provably carries no runtime DI
 * token and therefore @Inject() is required.
 */
function isNonInjectableType(typeStr) {
  if (!typeStr) return false;
  const t = typeStr.trim();

  if (NON_INJECTABLE_KEYWORDS.has(t)) return true;
  if (PRIMITIVE_TYPES.has(t)) return true;
  if (t.startsWith("{")) return true;
  if (t.endsWith("[]")) return true;
  if (/^(?:Readonly)?Array\s*</.test(t)) return true;

  if (hasTopLevelBar(t)) {
    const arms = splitUnionArms(t);
    const nonNull = arms.filter((a) => !NULLABLE_ARMS.has(a));
    if (nonNull.length === 1) return isNonInjectableType(nonNull[0]);
    return true;
  }

  return false;
}

/**
 * Returns the base class-like identifier from a type string (for Check A/C),
 * stripping generics and collapsing nullable unions. Returns null when there
 * is no single class identifier (union, primitive, inline object, etc.).
 * Only returns an identifier if it starts with an uppercase letter (class
 * convention), so string/number/boolean identifiers are ignored.
 */
function getTypeIdent(typeStr) {
  if (!typeStr) return null;
  const t = typeStr.trim();

  if (hasTopLevelBar(t)) {
    const arms = splitUnionArms(t);
    const nonNull = arms.filter((a) => !NULLABLE_ARMS.has(a));
    if (nonNull.length !== 1) return null;
    return getTypeIdent(nonNull[0]);
  }

  const withoutGeneric = t.split("<")[0].trim();
  if (/^[A-Z][A-Za-z0-9_$]*$/.test(withoutGeneric)) return withoutGeneric;
  return null;
}

/** Check A — returns a finding or null. */
function checkUndeclaredToken(param, visibleTokens, className, moduleName) {
  if (param.injectToken !== null) return null;
  const ident = getTypeIdent(param.type);
  if (!ident) return null;
  if (visibleTokens.has(ident)) return null;
  return {
    kind: "A",
    severity: param.optional ? "warn" : "error",
    class: className,
    module: moduleName,
    paramIndex: param.index,
    paramName: param.name,
    missingToken: ident,
    optional: param.optional,
  };
}

/** Check B — returns a finding or null. */
function checkNonInjectableType(param, className, moduleName) {
  if (param.injectToken !== null) return null;
  if (!isNonInjectableType(param.type)) return null;
  return {
    kind: "B",
    severity: "error",
    class: className,
    module: moduleName,
    paramIndex: param.index,
    paramName: param.name,
    type: param.type ?? "(untyped)",
  };
}

/** Check C — returns a finding or null. */
function checkImportType(param, typeOnlyImports, className, moduleName) {
  if (param.injectToken !== null) return null;
  const ident = getTypeIdent(param.type);
  if (!ident) return null;
  if (!typeOnlyImports.has(ident)) return null;
  return {
    kind: "C",
    severity: "error",
    class: className,
    module: moduleName,
    paramIndex: param.index,
    paramName: param.name,
    typeIdent: ident,
  };
}

/**
 * Walks src/ and records every `export class X` / `export abstract class X`
 * with its file path. Returns Map<className, filePath[]>.
 * Multiple files may export the same class name (rare but possible when the
 * same class appears under different module subdirectories).
 */
function buildClassIndex(srcDir) {
  const index = new Map();
  const CLASS_RE = /\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
  function walkDir(dir) {
    for (const entry of readdirSync(dir)) {
      if (["node_modules", "dist", ".git"].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walkDir(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".spec.ts")) {
        let src;
        try { src = readFileSync(full, "utf8"); } catch { continue; }
        CLASS_RE.lastIndex = 0;
        for (const m of src.matchAll(CLASS_RE)) {
          const name = m[1];
          if (!index.has(name)) index.set(name, []);
          index.get(name).push(full);
        }
      }
    }
  }
  walkDir(srcDir);
  return index;
}

/**
 * When multiple files share the same basename, pick the one closest in the
 * directory tree to the module file that registered the class.
 * "Closest" = fewest "../" segments in the relative path.
 */
function findBestCandidate(candidates, moduleFilePath) {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  if (!moduleFilePath) return candidates[0];
  const moduleDir = moduleFilePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  let best = candidates[0];
  let bestScore = Infinity;
  for (const c of candidates) {
    const rel = relative(moduleDir, c.replace(/\\/g, "/")).replace(/\\/g, "/");
    const upCount = (rel.match(/\.\.\//g) ?? []).length;
    if (upCount < bestScore) { bestScore = upCount; best = c; }
  }
  return best;
}

/**
 * Runs Checks A, B, C over all registered providers and controllers.
 *
 * Skipped classes are classified into:
 *   nonClassToken  — ALL_CAPS constant or non-PascalCase identifier; no source
 *                    file is ever expected (string/symbol DI tokens, framework
 *                    symbols, side-effect-import modules)
 *   notInFileIndex — PascalCase class name but the file resolver found nothing;
 *                    may be an external-package class or a non-standard filename
 *
 * Returns { findings, checkedCount, skipped }.
 */
function runDiConstructorChecks(registry, classIndex) {
  const globalExports = new Set();
  for (const [, m] of registry) {
    if (m.isGlobal) {
      for (const t of computeModuleExports(m.className, registry)) globalExports.add(t);
    }
  }

  const findings = [];
  let checkedCount = 0;
  const skipped = {
    nonClassToken: [],
    notInClassIndex: [],
  };

  for (const [moduleName, moduleInfo] of registry) {
    const visible = computeVisibleTokens(moduleName, registry, globalExports);
    const classesToCheck = [...new Set([...moduleInfo.implClasses, ...moduleInfo.controllers])];

    for (const className of classesToCheck) {
      if (!className) continue;

      if (isConstantName(className) || !/^[A-Z]/.test(className) || NEST_FRAMEWORK_TOKENS.has(className)) {
        skipped.nonClassToken.push({ className, moduleName });
        continue;
      }

      const candidates = classIndex.get(className) ?? [];
      if (candidates.length === 0) {
        skipped.notInClassIndex.push({ className, moduleName });
        continue;
      }
      const filePath = findBestCandidate(candidates, moduleInfo.filePath);
      let src;
      try { src = readFileSync(filePath, "utf8"); } catch {
        skipped.notInClassIndex.push({ className, moduleName });
        continue;
      }

      const importTypes = parseImportTypes(src);
      const params = parseConstructorParams(src, className);
      if (params.length === 0) continue;
      checkedCount++;

      for (const param of params) {
        const fa = checkUndeclaredToken(param, visible, className, moduleName);
        if (fa) findings.push({ ...fa, file: relative(BACKEND_ROOT, filePath).replace(/\\/g, "/") });

        const fb = checkNonInjectableType(param, className, moduleName);
        if (fb) findings.push({ ...fb, file: relative(BACKEND_ROOT, filePath).replace(/\\/g, "/") });

        const fc = checkImportType(param, importTypes.typeOnly, className, moduleName);
        if (fc) findings.push({ ...fc, file: relative(BACKEND_ROOT, filePath).replace(/\\/g, "/") });
      }
    }
  }

  return { findings, checkedCount, skipped };
}

// ─── CHECK D — @Injectable/@Controller CLASSES NO REACHABLE MODULE REGISTERS ─
//
// THE BLINDSPOT THIS CLOSES
// Everything above answers "do the modules that exist resolve?". None of it
// answers "does this class exist in the injector at all?". An @Injectable()
// listed in no module's `providers` is never constructed by Nest: its
// onModuleInit never fires, its dependencies are never resolved, and the
// feature it implements silently does not exist. Nothing in the file looks
// wrong — it typechecks and its unit spec passes, because a spec constructs the
// class directly and never consults the module graph. This release was already
// bitten by the same shape from the other direction: an outbox consumer was
// unregistered, so OutboxPublisherService.deliver() threw "no dispatch handler"
// and every ticket status change dead-lettered after 8 retries, with green
// specs throughout.
//
// The graph walker below is the one written for check-outbox-consumers.mjs
// (analyseSources / isRuntimeSource). It is duplicated rather than imported
// because that script runs its whole scan at module scope and calls
// process.exit, so importing it would execute a second gate. Two corrections it
// carries are load-bearing here:
//   · modules do NOT always write `imports: [ ... ]` inline. build.module.ts,
//     kb.module.ts and the finance, hr and inventory modules hoist their
//     children into `const BUILD_MODULES = [...]` first. A matcher keyed on
//     `imports: [` misses every one and reports correctly-wired children as
//     orphans — that cost the outbox agent a false report of seven.
//   · module imports resolve through the importing file's OWN import
//     statements, so two modules sharing a class name stay distinct.
// One correction is new here: those import statements frequently point at a
// barrel (`from "./kb-gap"`), and the barrel re-exports the module from a third
// file. Without following `export { X } from "./y"` and `export * from "./y"`,
// SupportKbGapModule's four classes read as orphans when the module is wired
// correctly through src/modules/support/kb-gap/index.ts.
//
// EXEMPTIONS — each is a real registration this walker cannot see, so each is
// classified and reported rather than failed or deleted:
//   enhancer   — named by class in @UseGuards/@UseInterceptors/@UsePipes/
//                @UseFilters or a @Param(..., Pipe); Nest instantiates it.
//   factory    — constructed explicitly somewhere (`new X(`).
//   base-class — abstract, or extended by another class; the subclass is what
//                gets provided.
//   aliased    — provided under a name a re-export renames onto this class.
// forwardRef, `Foo.forRoot()`, `{ provide: T, useClass: X }` and @Global()
// modules need no exemption: the walker resolves all four.

const RUNTIME_SOURCE_FLOOR = 500;
const REACHABLE_MODULE_FLOOR = 100;
const REGISTERED_CLASS_FLOOR = 500;
const DECORATED_CLASS_FLOOR = 500;

/** The ratchet. Measured at 0 after registering the two IngressModule orphans;
 *  never raise it to go green — register the class, or classify it above. */
const MAX_UNREGISTERED = 0;

/**
 * Test files are not runtime sources. A class that exists only in a spec must
 * not read as a provider, and a spec is not a place a provider can be wired.
 */
export function isRuntimeSource(path) {
  if (!path.endsWith(".ts")) return false;
  if (path.endsWith(".d.ts")) return false;
  if (/\.(?:spec|e2e-spec|test)\.ts$/.test(path)) return false;
  return !/(?:^|[/\\])(?:__tests__|__mocks__|test)[/\\]/.test(path);
}

function collectRuntimeSources(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectRuntimeSources(full, out);
    else if (isRuntimeSource(full)) out.push(full);
  }
  return out;
}

/** The balanced (…)/[…]/{…} region starting at `openIndex`, brackets included. */
function balancedSlice(src, openIndex, open, close) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(openIndex, i + 1);
    }
  }
  return null;
}

/** Module-level `const NAME = [ … ]` array literals, as raw text. */
function arrayConstants(src) {
  const consts = new Map();
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\[/g)) {
    const slice = balancedSlice(src, src.indexOf("[", m.index + m[0].length - 1), "[", "]");
    if (slice) consts.set(m[1], slice);
  }
  return consts;
}

/** The `key:` section of a @Module object — inline array OR hoisted const. */
function moduleArraySection(decoratorBody, key, arrayConsts) {
  const inline = decoratorBody.search(new RegExp(`\\b${key}\\s*:\\s*\\[`));
  if (inline !== -1)
    return balancedSlice(decoratorBody, decoratorBody.indexOf("[", inline), "[", "]");
  const viaConst = new RegExp(`\\b${key}\\s*:\\s*([A-Za-z_$][\\w$]*)`).exec(decoratorBody);
  if (viaConst) return arrayConsts.get(viaConst[1]) ?? null;
  return null;
}

const ANY_IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/**
 * Class names a @Module section references. Deliberately generous — every
 * capitalised identifier — so `ConfigModule.forRoot({...})`,
 * `forwardRef(() => XModule)` and `{ provide: APP_GUARD, useClass: JwtAuthGuard }`
 * all yield their class. Over-collecting can only make a class look MORE
 * registered, and reachability from AppModule is what keeps the gate honest.
 */
function referencedClasses(section, arrayConsts = new Map(), seen = new Set()) {
  if (!section) return [];
  const names = new Set();
  for (const m of section.matchAll(ANY_IDENTIFIER)) {
    const name = m[0];
    if (!/^[A-Z]/.test(name)) continue;
    if (arrayConsts.has(name) && !seen.has(name)) {
      seen.add(name);
      for (const nested of referencedClasses(arrayConsts.get(name), arrayConsts, seen))
        names.add(nested);
      continue;
    }
    names.add(name);
  }
  return [...names];
}

const NAMED_IMPORT_RE = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const NAMED_REEXPORT_RE = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const STAR_REEXPORT_RE = /\bexport\s+\*\s*from\s*["']([^"']+)["']/g;

function resolveSpecifier(filePath, spec, fileSet) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(filePath), spec);
  return [`${base}.ts`, join(base, "index.ts")].find((c) => fileSet.has(c)) ?? null;
}

/** Symbol → absolute file path, from a file's own import statements. */
function importedSymbolPaths(filePath, src, fileSet) {
  const map = new Map();
  for (const m of src.matchAll(NAMED_IMPORT_RE)) {
    const target = resolveSpecifier(filePath, m[2], fileSet);
    if (!target) continue;
    for (const raw of m[1].split(",")) {
      const name = raw.replace(/\btype\b/, "").split(/\bas\b/)[0].trim();
      if (name) map.set(name, target);
    }
  }
  return map;
}

/** A file's re-exports: `export { A as B } from "./x"` and `export * from "./y"`. */
function reexportMap(filePath, src, fileSet) {
  const named = new Map();
  const stars = [];
  for (const m of src.matchAll(NAMED_REEXPORT_RE)) {
    const target = resolveSpecifier(filePath, m[2], fileSet);
    if (!target) continue;
    for (const raw of m[1].split(",")) {
      const cleaned = raw.replace(/\btype\b/, "").trim();
      if (!cleaned) continue;
      const parts = cleaned.split(/\s+as\s+/).map((x) => x.trim());
      named.set(parts[1] ?? parts[0], { target, original: parts[0] });
    }
  }
  for (const m of src.matchAll(STAR_REEXPORT_RE)) {
    const target = resolveSpecifier(filePath, m[1], fileSet);
    if (target) stars.push(target);
  }
  return { named, stars };
}

const NEXT_CLASS_DECL = /\bclass\s+([A-Za-z_$][\w$]*)/;

/** Every @Module in a file, keyed by the class its decorator is attached to. */
function parseNestModules(filePath, src) {
  const modules = [];
  const arrayConsts = arrayConstants(src);
  for (const m of src.matchAll(/@Module\s*\(/g)) {
    const call = balancedSlice(src, src.indexOf("(", m.index), "(", ")");
    if (!call) continue;
    const decl = NEXT_CLASS_DECL.exec(src.slice(m.index + call.length));
    if (!decl) continue;
    modules.push({
      file: filePath,
      className: decl[1],
      imports: referencedClasses(moduleArraySection(call, "imports", arrayConsts), arrayConsts),
      providers: referencedClasses(moduleArraySection(call, "providers", arrayConsts), arrayConsts),
      controllers: referencedClasses(
        moduleArraySection(call, "controllers", arrayConsts),
        arrayConsts,
      ),
    });
  }
  return modules;
}

/**
 * Providers named by a DynamicModule returned from `static forRoot()` /
 * `register()` — those `providers:` arrays sit in a method body, not in the
 * @Module decorator, so parseNestModules cannot see them. Read from reachable
 * module files only.
 */
function dynamicModuleRegistrations(src) {
  const arrayConsts = arrayConstants(src);
  const names = new Set();
  for (const key of ["providers", "controllers"]) {
    for (const m of src.matchAll(new RegExp(`\\b${key}\\s*:\\s*`, "g"))) {
      const at = m.index + m[0].length;
      const rest = src.slice(at);
      if (rest.startsWith("[")) {
        for (const n of referencedClasses(balancedSlice(src, at, "[", "]"), arrayConsts))
          names.add(n);
        continue;
      }
      const ident = /^([A-Za-z_$][\w$]*)/.exec(rest);
      if (ident && arrayConsts.has(ident[1]))
        for (const n of referencedClasses(arrayConsts.get(ident[1]), arrayConsts)) names.add(n);
    }
  }
  return names;
}

const DECORATED_CLASS_RE =
  /@(Injectable|Controller)\s*\(([^)]*)\)\s*(?:@[\w$]+\s*\([^)]*\)\s*)*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
const ENHANCER_RE =
  /@(?:UseGuards|UseInterceptors|UsePipes|UseFilters|Param|Query|Body|Headers)\s*\(/g;
const CONSTRUCTED_RE = /\bnew\s+([A-Z][\w$]*)\s*\(/g;
const EXTENDS_RE = /\bextends\s+([A-Z][\w$]*)/g;

/**
 * The whole Check-D detector over a path → source map. The gate and the
 * self-test both call this, so the self-test exercises the real walker rather
 * than a re-declared copy of its rules.
 */
export function analyseRegistration(sourceByFile, options = {}) {
  const rootFile = options.rootModuleFile ?? join(SRC_ROOT, "app.module.ts");
  const rootClass = options.rootModuleClass ?? "AppModule";
  const fileSet = new Set(sourceByFile.keys());

  const modulesByFile = new Map();
  const importPathsByFile = new Map();
  const reexportByFile = new Map();
  const decorated = [];
  const enhancerNames = new Set();
  const constructedNames = new Set();
  const extendedNames = new Set();

  for (const [filePath, src] of sourceByFile) {
    reexportByFile.set(filePath, reexportMap(filePath, src, fileSet));

    for (const m of src.matchAll(DECORATED_CLASS_RE))
      decorated.push({
        file: filePath,
        kind: m[1],
        className: m[3],
        abstract: /\babstract\s+class\b/.test(m[0]),
      });

    for (const m of src.matchAll(ENHANCER_RE)) {
      const args = balancedSlice(src, m.index + m[0].length - 1, "(", ")");
      if (!args) continue;
      for (const ident of args.matchAll(ANY_IDENTIFIER))
        if (/^[A-Z]/.test(ident[0])) enhancerNames.add(ident[0]);
    }
    for (const m of src.matchAll(CONSTRUCTED_RE)) constructedNames.add(m[1]);
    for (const m of src.matchAll(EXTENDS_RE)) extendedNames.add(m[1]);

    if (!src.includes("@Module(")) continue;
    const parsed = parseNestModules(filePath, src);
    if (parsed.length === 0) continue;
    modulesByFile.set(filePath, parsed);
    importPathsByFile.set(filePath, importedSymbolPaths(filePath, src, fileSet));
  }

  /** Follow re-export barrels to the file that actually declares `className`. */
  const locate = (file, className, wanted, seen = new Set()) => {
    if (!file) return null;
    const key = `${file}#${className}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const hit = wanted(file, className);
    if (hit) return hit;
    const re = reexportByFile.get(file);
    if (!re) return null;
    const named = re.named.get(className);
    if (named) {
      const viaNamed = locate(named.target, named.original, wanted, seen);
      if (viaNamed) return viaNamed;
    }
    for (const star of re.stars) {
      const viaStar = locate(star, className, wanted, seen);
      if (viaStar) return viaStar;
    }
    return null;
  };

  const wantModule = (file, className) => {
    const mod = (modulesByFile.get(file) ?? []).find((m) => m.className === className);
    return mod ? { file, mod } : null;
  };
  const wantClass = (file, className) =>
    new RegExp(`\\bclass\\s+${className}\\b`).test(sourceByFile.get(file) ?? "")
      ? `${file}#${className}`
      : null;

  const registeredNames = new Set();
  const registeredIdentities = new Set();
  const reachableModules = new Set();
  const reachableFiles = new Set();
  const queue = (modulesByFile.get(rootFile) ?? [])
    .filter((m) => m.className === rootClass)
    .map((m) => ({ file: rootFile, mod: m }));

  while (queue.length > 0) {
    const { file, mod } = queue.pop();
    const key = `${file}#${mod.className}`;
    if (reachableModules.has(key)) continue;
    reachableModules.add(key);
    reachableFiles.add(file);

    const importPaths = importPathsByFile.get(file) ?? new Map();
    for (const name of [...mod.providers, ...mod.controllers]) {
      registeredNames.add(name);
      // A provider may be listed under a name a re-export renames onto the real
      // class — GdprExportWorkerImplementation is provided as
      // GdprExportWorkerService. Resolve to the declaring file so the alias
      // does not read as an orphan.
      const identity = locate(importPaths.get(name) ?? null, name, wantClass);
      if (identity) registeredIdentities.add(identity);
    }

    for (const imported of mod.imports) {
      const viaImport = locate(importPaths.get(imported) ?? null, imported, wantModule);
      if (viaImport) {
        queue.push(viaImport);
        continue;
      }
      for (const [f, ms] of modulesByFile)
        for (const m of ms) if (m.className === imported) queue.push({ file: f, mod: m });
    }
  }

  for (const file of reachableFiles)
    for (const name of dynamicModuleRegistrations(sourceByFile.get(file) ?? ""))
      registeredNames.add(name);

  const registeredAnywhere = new Set();
  for (const [, mods] of modulesByFile)
    for (const mod of mods)
      for (const name of [...mod.providers, ...mod.controllers]) registeredAnywhere.add(name);

  const classify = (entry) => {
    if (registeredNames.has(entry.className)) return null;
    if (registeredIdentities.has(`${entry.file}#${entry.className}`)) return "aliased";
    if (entry.abstract || extendedNames.has(entry.className)) return "base-class";
    if (enhancerNames.has(entry.className)) return "enhancer";
    if (constructedNames.has(entry.className)) return "factory";
    return registeredAnywhere.has(entry.className) ? "unreachable-module" : "unregistered";
  };

  const findings = [];
  const exempt = [];
  for (const entry of decorated) {
    const verdict = classify(entry);
    if (verdict === null) continue;
    if (verdict === "unregistered" || verdict === "unreachable-module")
      findings.push({ ...entry, verdict });
    else exempt.push({ ...entry, verdict });
  }

  return {
    decorated,
    findings,
    exempt,
    registeredNames,
    registeredIdentities,
    reachableModules,
    modulesByFile,
  };
}

function isRegistrationScanVacuous(result, fileCount) {
  return (
    fileCount < RUNTIME_SOURCE_FLOOR ||
    result.reachableModules.size < REACHABLE_MODULE_FLOOR ||
    result.registeredNames.size < REGISTERED_CLASS_FLOOR ||
    result.decorated.length < DECORATED_CLASS_FLOOR
  );
}

// ─── SELF-TEST ──────────────────────────────────────────────────────────────

function runSelfTest() {
  let failures = 0;

  // ── Existing export-check cases ──────────────────────────────────────────
  const exportCases = [
    {
      name: "the StorageModule defect — exports a provider token from an imported module",
      src: `@Module({
  imports: [AvScannerModule],
  controllers: [StorageController],
  providers: [MediaCompressionService, StorageService],
  exports: [StorageService, AvScanner],
})
export class StorageModule {}`,
      expectInvalid: ["AvScanner"],
    },
    {
      name: "the fixed form — re-exports the module",
      src: `@Module({
  imports: [AvScannerModule],
  providers: [MediaCompressionService, StorageService],
  exports: [StorageService, AvScannerModule],
})
export class StorageModule {}`,
      expectInvalid: [],
    },
    {
      name: "custom provider token is provided by this module",
      src: `@Module({
  providers: [{ provide: REDIS, useFactory: (a, b) => make(a, b), inject: [A, B] }],
  exports: [REDIS],
})
export class CacheModule {}`,
      expectInvalid: [],
    },
    {
      name: "a factory with commas inside does not tear the entry apart",
      src: `@Module({
  providers: [
    {
      provide: AvScanner,
      useFactory: (config) => {
        if (config.AV_SCANNER === "clamav") return new ClamAvScanner(host, port);
        return new NoopAvScanner();
      },
      inject: [APP_CONFIG],
    },
  ],
  exports: [AvScanner],
})
export class AvScannerModule {}`,
      expectInvalid: [],
    },
    {
      name: "forwardRef import satisfies an export",
      src: `@Module({
  imports: [forwardRef(() => BuildModule)],
  providers: [X],
  exports: [X, BuildModule],
})
export class M {}`,
      expectInvalid: [],
    },
    {
      name: "dynamic module import satisfies an export",
      src: `@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: [],
  exports: [ConfigModule],
})
export class M {}`,
      expectInvalid: [],
    },
    {
      name: "a brace inside a string does not close the module object early",
      src: `@Module({
  providers: [{ provide: "TOKEN}", useValue: 1 }],
  exports: [Ghost],
})
export class M {}`,
      expectInvalid: ["Ghost"],
    },
  ];

  for (const c of exportCases) {
    const result = analyseModuleSource(c.src);
    if (!result) {
      console.error(`SELF-TEST FAIL [export]: ${c.name} — module object did not parse`);
      failures++;
      continue;
    }
    const got = JSON.stringify(result.invalid);
    const want = JSON.stringify(c.expectInvalid);
    if (got !== want) {
      console.error(`SELF-TEST FAIL [export]: ${c.name}\n  expected invalid ${want}\n  got      invalid ${got}`);
      failures++;
    }
  }

  // ── Helper: build a synthetic registry from simple descriptor objects ──
  function makeRegistry(modules) {
    const reg = new Map();
    for (const m of modules) {
      reg.set(m.className, {
        className: m.className,
        isGlobal: m.isGlobal ?? false,
        providers: m.providers ?? [],
        implClasses: m.implClasses ?? m.providers ?? [],
        imports: m.imports ?? [],
        exports: m.exports ?? [],
        controllers: m.controllers ?? [],
        filePath: null,
      });
    }
    return reg;
  }

  function globalExportsFrom(reg) {
    const ge = new Set();
    for (const [, m] of reg) {
      if (m.isGlobal) {
        for (const t of computeModuleExports(m.className, reg)) ge.add(t);
      }
    }
    return ge;
  }

  // ── Check A: undeclared token (HrWorkflowEngineService shape) ──

  {
    const name = "Check A MUST flag: HrWorkflowEngineService shape — dep not in module";
    const reg = makeRegistry([{
      className: "HrWorkflowsModule",
      providers: ["HrWorkflowEngineService"],
      implClasses: ["HrWorkflowEngineService"],
      imports: [],
      exports: [],
    }]);
    const visible = computeVisibleTokens("HrWorkflowsModule", reg, new Set());
    const param = { index: 1, name: "approver", type: "HrWorkflowApproverService", injectToken: null, optional: false };
    const f = checkUndeclaredToken(param, visible, "HrWorkflowEngineService", "HrWorkflowsModule");
    if (!f) {
      console.error(`SELF-TEST FAIL [A]: ${name} — expected a finding, got null`);
      failures++;
    }
  }

  // ── Check B: non-injectable type (CrmBriefService shape) ──

  {
    const name = "Check B MUST flag: CrmBriefService shape — param typed unknown";
    const reg = makeRegistry([{ className: "AiModule", providers: ["CrmBriefService"] }]);
    const visible = computeVisibleTokens("AiModule", reg, new Set());
    const param = { index: 2, name: "orgFeatures", type: "unknown", injectToken: null, optional: false };
    const f = checkNonInjectableType(param, "CrmBriefService", "AiModule");
    if (!f) {
      console.error(`SELF-TEST FAIL [B]: ${name} — expected a finding, got null`);
      failures++;
    }
  }

  // ── Check C: import type on injected class ──

  {
    const name = "Check C MUST flag: service injected with import type — no @Inject";
    const typeOnly = new Set(["SomeService"]);
    const param = { index: 0, name: "svc", type: "SomeService", injectToken: null, optional: false };
    const f = checkImportType(param, typeOnly, "Consumer", "SomeModule");
    if (!f) {
      console.error(`SELF-TEST FAIL [C]: ${name} — expected a finding, got null`);
      failures++;
    }
  }

  // ── NOT flagged: dep comes from an imported module's exports ──

  {
    const name = "Check A MUST NOT flag: dep visible via imported module exports";
    const reg = makeRegistry([
      { className: "ModuleA", providers: ["ServiceA"], exports: ["ServiceA"] },
      { className: "ModuleB", providers: ["ServiceB"], imports: ["ModuleA"] },
    ]);
    const visible = computeVisibleTokens("ModuleB", reg, new Set());
    const param = { index: 0, name: "a", type: "ServiceA", injectToken: null, optional: false };
    const f = checkUndeclaredToken(param, visible, "ServiceB", "ModuleB");
    if (f) {
      console.error(`SELF-TEST FAIL [A]: ${name} — got unexpected finding: ${JSON.stringify(f)}`);
      failures++;
    }
  }

  // ── NOT flagged: dep comes from a @Global() module ──

  {
    const name = "Check A MUST NOT flag: dep visible via @Global() module";
    const reg = makeRegistry([
      { className: "GlobalModule", isGlobal: true, providers: ["GlobalService"], exports: ["GlobalService"] },
      { className: "LocalModule", providers: ["LocalService"] },
    ]);
    const ge = globalExportsFrom(reg);
    const visible = computeVisibleTokens("LocalModule", reg, ge);
    const param = { index: 0, name: "gs", type: "GlobalService", injectToken: null, optional: false };
    const f = checkUndeclaredToken(param, visible, "LocalService", "LocalModule");
    if (f) {
      console.error(`SELF-TEST FAIL [A]: ${name} — got unexpected finding: ${JSON.stringify(f)}`);
      failures++;
    }
  }

  // ── NOT flagged: @Inject(DRIZZLE) db: Db — explicit token, type-only import ──

  {
    const name = "Check B MUST NOT flag: @Inject(DRIZZLE) db: Db (explicit token exempts)";
    const param = { index: 0, name: "db", type: "Db", injectToken: "DRIZZLE", optional: false };
    const fb = checkNonInjectableType(param, "SomeService", "SomeModule");
    if (fb) {
      console.error(`SELF-TEST FAIL [B]: ${name} — unexpected finding: ${JSON.stringify(fb)}`);
      failures++;
    }
    const name2 = "Check C MUST NOT flag: @Inject(DRIZZLE) db: Db (explicit token exempts)";
    const typeOnly = new Set(["Db"]);
    const fc = checkImportType(param, typeOnly, "SomeService", "SomeModule");
    if (fc) {
      console.error(`SELF-TEST FAIL [C]: ${name2} — unexpected finding: ${JSON.stringify(fc)}`);
      failures++;
    }
  }

  // ── NOT flagged: forwardRef import ──

  {
    const name = "Check A MUST NOT flag: dep visible via forwardRef import (tokenOf resolves it)";
    const reg = makeRegistry([
      { className: "ModuleA", providers: ["ServiceA"], exports: ["ServiceA"] },
      { className: "ModuleB", providers: ["ServiceB"], imports: ["ModuleA"] },
    ]);
    const visible = computeVisibleTokens("ModuleB", reg, new Set());
    const param = { index: 0, name: "a", type: "ServiceA", injectToken: null, optional: false };
    const f = checkUndeclaredToken(param, visible, "ServiceB", "ModuleB");
    if (f) {
      console.error(`SELF-TEST FAIL [A]: ${name} — unexpected finding: ${JSON.stringify(f)}`);
      failures++;
    }
  }

  // ── NOT flagged: transitive re-exported module ──

  {
    const name = "Check A MUST NOT flag: dep transitive via re-exported module (EmploymentFactsModule pattern)";
    const reg = makeRegistry([
      { className: "EmploymentFactsModule", providers: ["EmploymentFactsService"], exports: ["EmploymentFactsService"] },
      { className: "DirectoryModule", imports: ["EmploymentFactsModule"], exports: ["EmploymentFactsModule"] },
      { className: "HrWorkflowsModule", imports: ["DirectoryModule"], providers: ["HrWorkflowApproverService"] },
    ]);
    const visible = computeVisibleTokens("HrWorkflowsModule", reg, new Set());
    const param = { index: 2, name: "employment", type: "EmploymentFactsService", injectToken: null, optional: false };
    const f = checkUndeclaredToken(param, visible, "HrWorkflowApproverService", "HrWorkflowsModule");
    if (f) {
      console.error(`SELF-TEST FAIL [A]: ${name} — unexpected finding: ${JSON.stringify(f)}`);
      failures++;
    }
  }

  {
    // Union splitting decides whether an injected type is a single token or an arm
    // of a union. hasTopLevelBar must ignore a `|` nested inside generics, tuples,
    // objects or parentheses — otherwise a Map<A|B, C> parameter is split apart.
    const barCases = [
      ["A | B", true],
      ["A", false],
      ["Map<string | number, X>", false],
      ["Array<A | B>", false],
      ["{ a: A | B }", false],
      ["(A | B)", false],
      ["Map<string, A> | null", true],
      ["[A | B]", false],
    ];
    for (const [type, expected] of barCases) {
      if (hasTopLevelBar(type) !== expected) {
        console.error(
          `SELF-TEST FAIL [bar]: hasTopLevelBar(${JSON.stringify(type)}) = ${String(hasTopLevelBar(type))}, expected ${String(expected)}`,
        );
        failures++;
      }
    }
  }

  // ── Check D: a provider class no reachable module registers ─────────────
  //
  // Every fixture below is a shape measured in this repository. The corpus is
  // fed to the real analyseRegistration, so the self-test exercises the walker
  // rather than a re-declared copy of its rules.

  let checkDAssertions = 0;
  {
    const assertD = (label, condition) => {
      checkDAssertions++;
      if (!condition) {
        console.error(`SELF-TEST FAIL [D]: ${label}`);
        failures++;
      }
    };

    const base = "/repo/src";
    const opts = { rootModuleFile: `${base}/app.module.ts`, rootModuleClass: "AppModule" };
    const wired = `@Injectable()\nexport class WiredService {}`;
    // The reference defect: a complete @Injectable() that no module provides.
    const orphan = `@Injectable()\nexport class OrphanService {}`;
    const feature = `import { WiredService } from "./wired.service";\n@Module({ providers: [WiredService] })\nexport class FeatureModule {}`;
    const app = `import { FeatureModule } from "./b/feature.module";\n@Module({ imports: [FeatureModule] })\nexport class AppModule {}`;

    const sources = new Map([
      [`${base}/b/wired.service.ts`, wired],
      [`${base}/b/orphan.service.ts`, orphan],
      [`${base}/b/feature.module.ts`, feature],
      [`${base}/app.module.ts`, app],
    ]);
    const result = analyseRegistration(sources, opts);
    const flagged = (r, name) => r.findings.some((f) => f.className === name);
    const exemptAs = (r, name, verdict) =>
      r.exempt.some((e) => e.className === name && e.verdict === verdict);

    assertD("an @Injectable no module provides IS flagged", flagged(result, "OrphanService"));
    assertD("a provided @Injectable is NOT flagged", !flagged(result, "WiredService"));
    assertD("exactly one orphan is reported", result.findings.length === 1);
    assertD("the orphan is classified 'unregistered'", result.findings[0].verdict === "unregistered");

    // A module nobody imports registers nothing at runtime, however complete
    // its @Module block looks — the check-module-registration failure mode.
    const detached = new Map(sources);
    detached.set(`${base}/app.module.ts`, `@Module({ imports: [] })\nexport class AppModule {}`);
    const detachedResult = analyseRegistration(detached, opts);
    assertD(
      "a provider of a module unreachable from AppModule IS flagged",
      flagged(detachedResult, "WiredService"),
    );
    assertD(
      "and is classified 'unreachable-module', not 'unregistered'",
      detachedResult.findings.some(
        (f) => f.className === "WiredService" && f.verdict === "unreachable-module",
      ),
    );

    // `imports: BUILD_MODULES` — build, kb, finance, hr and inventory all hoist
    // their children. Missing this reported seven false orphans for the outbox
    // agent before it resolved the indirection.
    const hoisted = new Map(sources);
    hoisted.set(
      `${base}/b/feature.module.ts`,
      `import { WiredService } from "./wired.service";\nconst FEATURE_PROVIDERS = [WiredService];\n@Module({ providers: FEATURE_PROVIDERS })\nexport class FeatureModule {}`,
    );
    hoisted.set(
      `${base}/app.module.ts`,
      `import { FeatureModule } from "./b/feature.module";\nconst ROOT_MODULES = [FeatureModule];\n@Module({ imports: ROOT_MODULES })\nexport class AppModule {}`,
    );
    const hoistedResult = analyseRegistration(hoisted, opts);
    assertD(
      "a module list hoisted into `imports: SOME_CONST` is followed",
      !flagged(hoistedResult, "WiredService"),
    );
    assertD("the orphan is still found through a hoisted graph", flagged(hoistedResult, "OrphanService"));

    // A barrel between the importer and the module — src/modules/support/kb-gap
    // is wired through its index.ts, and not following it reported four false
    // orphans.
    const barrel = new Map(sources);
    barrel.set(`${base}/b/index.ts`, `export { FeatureModule } from "./feature.module";`);
    barrel.set(`${base}/app.module.ts`, `import { FeatureModule } from "./b";\n@Module({ imports: [FeatureModule] })\nexport class AppModule {}`);
    assertD(
      "a module imported through a re-export barrel is still reachable",
      !flagged(analyseRegistration(barrel, opts), "WiredService"),
    );

    const starBarrel = new Map(barrel);
    starBarrel.set(`${base}/b/index.ts`, `export * from "./feature.module";`);
    assertD(
      "a module imported through an `export *` barrel is still reachable",
      !flagged(analyseRegistration(starBarrel, opts), "WiredService"),
    );

    // GdprExportWorkerImplementation is provided under the re-exported alias
    // GdprExportWorkerService.
    const aliased = new Map([
      [`${base}/b/impl.ts`, `@Injectable()\nexport class ImplementationService {}`],
      [`${base}/b/facade.ts`, `export { ImplementationService as PublicService } from "./impl";`],
      [
        `${base}/b/feature.module.ts`,
        `import { PublicService } from "./facade";\n@Module({ providers: [PublicService] })\nexport class FeatureModule {}`,
      ],
      [`${base}/app.module.ts`, app],
    ]);
    assertD(
      "a class provided under a re-exported alias is not an orphan",
      analyseRegistration(aliased, opts).exempt.some(
        (e) => e.className === "ImplementationService" && e.verdict === "aliased",
      ),
    );

    // forwardRef, a dynamic module and a useClass token are all real
    // registrations the walker must resolve rather than exempt.
    const resolved = new Map([
      [`${base}/b/wired.service.ts`, wired],
      [`${base}/b/guard.ts`, `@Injectable()\nexport class TokenGuard {}`],
      [
        `${base}/b/feature.module.ts`,
        `import { WiredService } from "./wired.service";\nimport { TokenGuard } from "./guard";\n@Module({ providers: [WiredService, { provide: APP_GUARD, useClass: TokenGuard }] })\nexport class FeatureModule {}`,
      ],
      [
        `${base}/app.module.ts`,
        `import { FeatureModule } from "./b/feature.module";\n@Module({ imports: [forwardRef(() => FeatureModule), ConfigModule.forRoot({ isGlobal: true })] })\nexport class AppModule {}`,
      ],
    ]);
    const resolvedResult = analyseRegistration(resolved, opts);
    assertD("a forwardRef module import is followed", !flagged(resolvedResult, "WiredService"));
    assertD(
      "a `{ provide: TOKEN, useClass: X }` provider registers X",
      !flagged(resolvedResult, "TokenGuard"),
    );

    // A @Controller is a provider class too — SupportKbGapController was one of
    // the four the barrel blindspot hid.
    const controller = new Map(sources);
    controller.set(`${base}/b/thing.controller.ts`, `@Controller("thing")\nexport class ThingController {}`);
    assertD(
      "a @Controller no module registers IS flagged",
      flagged(analyseRegistration(controller, opts), "ThingController"),
    );
    const wiredController = new Map(controller);
    wiredController.set(
      `${base}/b/feature.module.ts`,
      `import { WiredService } from "./wired.service";\nimport { ThingController } from "./thing.controller";\n@Module({ controllers: [ThingController], providers: [WiredService] })\nexport class FeatureModule {}`,
    );
    assertD(
      "a registered @Controller is NOT flagged",
      !flagged(analyseRegistration(wiredController, opts), "ThingController"),
    );

    // The four exemptions — each a registration Nest performs that no module
    // records. They are classified, never failed, and never deleted.
    const exemptions = new Map(sources);
    exemptions.set(`${base}/b/api-key.guard.ts`, `@Injectable()\nexport class ApiKeyGuardFixture {}`);
    exemptions.set(`${base}/b/parse.pipe.ts`, `@Injectable()\nexport class ParsePipeFixture {}`);
    exemptions.set(`${base}/b/interceptor.ts`, `@Injectable()\nexport class InterceptorFixture {}`);
    exemptions.set(`${base}/b/base.ts`, `@Injectable()\nabstract class BaseFixture {}\nexport class ConcreteFixture extends BaseFixture {}`);
    exemptions.set(
      `${base}/b/use.controller.ts`,
      `import { ApiKeyGuardFixture } from "./api-key.guard";\n@UseGuards(ApiKeyGuardFixture)\nexport class UseController {\n  read(@Param("projectId", ParsePipeFixture) projectId) {}\n}`,
    );
    exemptions.set(`${base}/main.ts`, `app.useGlobalInterceptors(new InterceptorFixture());`);
    const exemptResult = analyseRegistration(exemptions, opts);
    assertD(
      "@UseGuards(X) exempts X — Nest instantiates the enhancer itself",
      exemptAs(exemptResult, "ApiKeyGuardFixture", "enhancer"),
    );
    assertD(
      "@Param(_, Pipe) exempts the pipe",
      exemptAs(exemptResult, "ParsePipeFixture", "enhancer"),
    );
    assertD(
      "a class constructed with `new X()` is exempt as a factory instantiation",
      exemptAs(exemptResult, "InterceptorFixture", "factory"),
    );
    assertD(
      "an abstract @Injectable base class is exempt",
      exemptAs(exemptResult, "BaseFixture", "base-class"),
    );
    assertD(
      "an exemption is never counted as a finding",
      !flagged(exemptResult, "ApiKeyGuardFixture") && !flagged(exemptResult, "BaseFixture"),
    );

    // Two modules may share a class name; the import path disambiguates them.
    const colliding = new Map([
      [`${base}/x/x.service.ts`, `@Injectable()\nexport class XService {}`],
      [
        `${base}/x/shared.module.ts`,
        `import { XService } from "./x.service";\n@Module({ providers: [XService] })\nexport class SharedModule {}`,
      ],
      [`${base}/y/shared.module.ts`, `@Module({ providers: [] })\nexport class SharedModule {}`],
      [
        `${base}/app.module.ts`,
        `import { SharedModule } from "./y/shared.module";\n@Module({ imports: [SharedModule] })\nexport class AppModule {}`,
      ],
    ]);
    assertD(
      "importing a same-named module from another folder does not register the other one's providers",
      flagged(analyseRegistration(colliding, opts), "XService"),
    );

    // Test files are not runtime sources: a spec-only class must not read as a
    // provider, and a module can never be wired from a spec.
    assertD("a .spec.ts file is not a runtime source", !isRuntimeSource("/repo/src/a/f.spec.ts"));
    assertD("an .e2e-spec.ts file is not a runtime source", !isRuntimeSource("/repo/src/a/f.e2e-spec.ts"));
    assertD("a file under __tests__/ is not a runtime source", !isRuntimeSource("/repo/src/a/__tests__/f.ts"));
    assertD("a .d.ts file is not a runtime source", !isRuntimeSource("/repo/src/a/f.d.ts"));
    assertD("an ordinary service IS a runtime source", isRuntimeSource("/repo/src/a/f.service.ts"));

    // Vacuity: "no orphans" over a scan that resolved nothing proves nothing.
    const empty = analyseRegistration(new Map(), opts);
    assertD("an empty corpus yields no findings", empty.findings.length === 0);
    assertD("an empty corpus trips the vacuity floor", isRegistrationScanVacuous(empty, 0));
    assertD(
      "a scan that resolves no module graph trips the floor even with files",
      isRegistrationScanVacuous(
        { reachableModules: new Set(), registeredNames: new Set(), decorated: [] },
        RUNTIME_SOURCE_FLOOR,
      ),
    );
    assertD(
      "a real-sized scan does not trip the floor",
      !isRegistrationScanVacuous(
        {
          reachableModules: new Set(Array.from({ length: REACHABLE_MODULE_FLOOR }, (_, i) => `m${String(i)}`)),
          registeredNames: new Set(Array.from({ length: REGISTERED_CLASS_FLOOR }, (_, i) => `c${String(i)}`)),
          decorated: Array.from({ length: DECORATED_CLASS_FLOOR }, () => ({})),
        },
        RUNTIME_SOURCE_FLOOR,
      ),
    );
    assertD("the ratchet is not silently above zero", MAX_UNREGISTERED === 0);
  }

  const totalCases = exportCases.length + 8 + 8 + checkDAssertions;
  if (failures > 0) {
    console.error(`\n${String(failures)} of ${String(totalCases)} self-test assertions failed`);
    process.exit(1);
  }
  console.log(`check:module-di self-test passed — ${String(totalCases)} assertions`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

// ─── MAIN SCAN ──────────────────────────────────────────────────────────────

const files = walk(SRC_ROOT);
if (files.length < MIN_MODULE_FILES) {
  console.error(
    `check:module-di scan is broken — found ${String(files.length)} *.module.ts files, expected at least ${String(MIN_MODULE_FILES)}`,
  );
  process.exit(2);
}

let parsed = 0;
const violations = [];
for (const file of files) {
  const result = analyseModuleSource(readFileSync(file, "utf8"));
  if (!result) continue;
  parsed++;
  for (const token of result.invalid) {
    violations.push({ file: relative(BACKEND_ROOT, file).replace(/\\/g, "/"), token });
  }
}

if (parsed === 0) {
  console.error("check:module-di scan is broken — zero @Module decorators parsed");
  process.exit(2);
}

if (violations.length > 0) {
  console.error(
    `check:module-di found ${String(violations.length)} export(s) NestJS will reject at boot:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(
      `    exports ${v.token}, which is neither a provider of this module nor a module it imports.`,
    );
    console.error(
      `    Export the module that provides ${v.token}, or add ${v.token} to providers.\n`,
    );
  }
  process.exit(1);
}

// ── Phase 2: DI constructor checks ──────────────────────────────────────────

const registry = buildModuleGraph(files);
const classIndex = buildClassIndex(SRC_ROOT);
const { findings, checkedCount, skipped } = runDiConstructorChecks(registry, classIndex);

// ── Phase 3: Check D — provider classes no reachable module registers ───────

const runtimeFiles = collectRuntimeSources(SRC_ROOT);
const sourceByFile = new Map(runtimeFiles.map((f) => [f, readFileSync(f, "utf8")]));
const registration = analyseRegistration(sourceByFile);

if (isRegistrationScanVacuous(registration, runtimeFiles.length)) {
  console.error(
    `check:module-di Check-D scan is broken — ${String(runtimeFiles.length)} runtime source(s) (floor ${String(RUNTIME_SOURCE_FLOOR)}), ` +
      `${String(registration.reachableModules.size)} module(s) reachable from AppModule (floor ${String(REACHABLE_MODULE_FLOOR)}), ` +
      `${String(registration.registeredNames.size)} registered class name(s) (floor ${String(REGISTERED_CLASS_FLOOR)}), ` +
      `${String(registration.decorated.length)} decorated class(es) (floor ${String(DECORATED_CLASS_FLOOR)}). ` +
      `"No orphans" over a graph that failed to resolve proves nothing.`,
  );
  process.exit(2);
}

const registrationFindings = registration.findings;
const exemptByVerdict = new Map();
for (const e of registration.exempt)
  exemptByVerdict.set(e.verdict, (exemptByVerdict.get(e.verdict) ?? 0) + 1);

function printCheckD() {
  console.error(
    `\nCheck D — provider class registered in no reachable module (${String(registrationFindings.length)} finding(s), ratchet ${String(MAX_UNREGISTERED)}):`,
  );
  for (const f of registrationFindings) {
    const where =
      f.verdict === "unreachable-module"
        ? "is provided only by a module nothing imports from AppModule"
        : "is listed in no @Module's providers/controllers";
    console.error(`  [ERROR] @${f.kind}() ${f.className} — ${where}`);
    console.error(`    ${relative(BACKEND_ROOT, f.file).replace(/\\/g, "/")}`);
    console.error(
      `    Nest never constructs it, so its onModuleInit never fires and the feature it implements does not exist at runtime.`,
    );
    console.error(
      `    Fix: add ${f.className} to the providers (or controllers) of a @Module reachable from AppModule.`,
    );
  }
}

function checkDSummary() {
  const exemptions =
    [...exemptByVerdict.entries()].map(([k, v]) => `${String(v)} ${k}`).join(" · ") || "none";
  return (
    `  Check-D: ${String(registration.decorated.length)} decorated class(es) · ` +
    `${String(registration.reachableModules.size)} modules reachable from AppModule · ` +
    `${String(registration.registeredNames.size)} registered · ` +
    `${String(registrationFindings.length)} unregistered · exempt: ${exemptions}`
  );
}

const findingsA = findings.filter((f) => f.kind === "A");
const findingsB = findings.filter((f) => f.kind === "B");
const findingsC = findings.filter((f) => f.kind === "C");

const genuineErrors = findings.filter((f) => f.severity === "error");
const genuineWarns = findings.filter((f) => f.severity === "warn");

const totalSkipped = skipped.nonClassToken.length + skipped.notInClassIndex.length;

function printSkippedSummary() {
  console.error(
    `  skipped: ${String(skipped.nonClassToken.length)} non-class tokens (string/symbol DI tokens, framework symbols)` +
    ` · ${String(skipped.notInClassIndex.length)} classes with no 'export class' found in src/`,
  );
  if (skipped.notInClassIndex.length > 0) {
    console.error(`  (use --verbose to list the classes not found in the class index)`);
  }
}

function printVerboseSkipped() {
  if (skipped.nonClassToken.length > 0) {
    console.error(`\nSkipped — non-class tokens (${String(skipped.nonClassToken.length)}, no source file expected):`);
    for (const s of skipped.nonClassToken) {
      console.error(`  ${s.className}  [registered in ${s.moduleName}]`);
    }
  }
  if (skipped.notInClassIndex.length > 0) {
    console.error(`\nSkipped — no 'export class X' found in src/ (${String(skipped.notInClassIndex.length)}, unchecked):`);
    for (const s of skipped.notInClassIndex) {
      console.error(`  ${s.className}  [registered in ${s.moduleName}]`);
    }
  }
}

const registrationFailed = registrationFindings.length > MAX_UNREGISTERED;

if (findings.length > 0 || registrationFailed) {
  if (findingsA.length > 0) {
    console.error(`\nCheck A — undeclared constructor token (${String(findingsA.length)} finding(s)):`);
    for (const f of findingsA) {
      const sev = f.optional ? "WARN" : "ERROR";
      console.error(`  [${sev}] ${f.class}.${f.paramName} at index [${String(f.paramIndex)}] — ${f.missingToken} is not available in ${f.module}`);
      console.error(`    ${f.file}`);
      console.error(`    Fix: add ${f.missingToken} to ${f.module} providers, or import the module that provides it.`);
    }
  }

  if (findingsB.length > 0) {
    console.error(`\nCheck B — non-injectable type annotation (${String(findingsB.length)} finding(s)):`);
    for (const f of findingsB) {
      console.error(`  [ERROR] ${f.class}.${f.paramName} at index [${String(f.paramIndex)}] — type '${f.type}' carries no DI token`);
      console.error(`    ${f.file}`);
      console.error(`    Fix: add @Inject(TOKEN) to pass an explicit token, or remove the parameter if unused.`);
    }
  }

  if (findingsC.length > 0) {
    console.error(`\nCheck C — import type erases DI token (${String(findingsC.length)} finding(s)):`);
    for (const f of findingsC) {
      console.error(`  [ERROR] ${f.class}.${f.paramName} at index [${String(f.paramIndex)}] — ${f.typeIdent} is imported with 'import type', erasing its DI token`);
      console.error(`    ${f.file}`);
      console.error(`    Fix: change to a value import, or add @Inject(TOKEN) with an explicit token.`);
    }
  }

  if (registrationFindings.length > 0) printCheckD();

  if (VERBOSE) printVerboseSkipped();

  console.error(`\ncheck:module-di: ${String(parsed)} modules · ${String(checkedCount)} classes checked`);
  printSkippedSummary();
  console.error(`  ${String(findingsA.length)} Check-A (undeclared token) · ${String(findingsB.length)} Check-B (non-injectable type) · ${String(findingsC.length)} Check-C (import type)`);
  console.error(checkDSummary());

  if (genuineErrors.length > 0 || registrationFailed) {
    console.error(
      `  ${String(genuineErrors.length)} constructor error(s) + ${String(registrationFindings.length)} unregistered provider(s) + ${String(genuineWarns.length)} warning(s) — failing`,
    );
    process.exit(1);
  }
  console.error(`  0 errors, ${String(genuineWarns.length)} warning(s) — passing`);
  process.exit(0);
}

if (VERBOSE) printVerboseSkipped();

console.log(
  `check:module-di clean — ${String(parsed)} modules · ${String(checkedCount)} classes checked` +
  ` · skipped: ${String(skipped.nonClassToken.length)} non-class tokens · ${String(skipped.notInClassIndex.length)} not-in-class-index · 0 violations`,
);
console.log(checkDSummary().trimStart());
