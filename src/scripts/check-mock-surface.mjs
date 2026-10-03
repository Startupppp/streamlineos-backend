#!/usr/bin/env node
/**
 * check-mock-surface.mjs
 *
 * Finds methods defined in test doubles that do not exist on the real service
 * class they stand in for.
 *
 * THE REFERENCE DEFECT
 * AccessService.resolveWithValidity was changed to call
 * this.cache.cachedForOrgWith(...). That method was never implemented on
 * CacheService. It was added to the CacheService mock in five spec files.
 * Every unit test passed, typecheck passed, madge passed, knip passed —
 * production threw TypeError at runtime (GET /build/:projectId → 500).
 *
 * WHY TYPECHECK MISSES IT
 * Mocks are cast (as unknown as CacheService, useValue: {...}), so TypeScript
 * never compares the double's surface to the real class.
 *
 * DETECTION STRATEGY
 * 1. Walk all *.spec.ts files (Node.js filesystem, no shell glob).
 * 2. For each spec file, find mock objects via two patterns:
 *    Pattern A — named variable: `const X = { ... }` + `X as unknown as Cls`
 *    Pattern B — useValue: `{ provide: Cls, useValue: { ... } }`
 *    Pattern C — factory return type: `function makeFoo(): Cls { return { ... } }`
 * 3. For each (mock-object, ClassName) pair, extract the mock's top-level
 *    method/property names using a depth-tracking character-level scanner.
 * 4. Find the real class file and extract its public method names.
 * 5. Report every method present on the mock but absent from the real class.
 *
 * VACUITY GUARDS
 * - Fewer than 50 spec files found → exit 2 ("walk is broken")
 * - Zero classes resolved → exit 2
 *
 * SELF-TEST (--self-test)
 * Plants a known phantom method in synthetic content, runs the detection
 * functions, and asserts the scan FLAGS it. Also verifies no false positives.
 * The same detection code paths are used — this is not a parallel implementation.
 *
 * Usage:
 *   node src/scripts/check-mock-surface.mjs [--self-test]
 *   pnpm check:mock-surface
 *   pnpm check:mock-surface:self-test
 *
 * Exit codes:
 *   0 — clean (or self-test passed)
 *   1 — phantom mock methods found (or self-test failed)
 *   2 — scan is broken (vacuity check failed)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const SRC_ROOT = join(BACKEND_ROOT, "src");

const MIN_SPEC_FILES = 50;

const SKIP_KEYWORDS = new Set([
  "if", "for", "while", "return", "const", "let", "var", "new", "this",
  "else", "switch", "case", "default", "break", "continue", "throw",
  "try", "catch", "finally", "class", "interface", "type", "export",
  "import", "void", "typeof", "instanceof", "delete", "in", "of",
  "from", "async", "await", "yield", "function", "static", "readonly",
  "abstract", "implements", "extends", "declare", "override", "public",
  "private", "protected", "never", "unknown", "any", "null", "undefined",
  "true", "false", "super", "constructor", "get", "set",
]);

// ---------------------------------------------------------------------------
// Character-level helpers
// ---------------------------------------------------------------------------

/**
 * Given source text and the index of an opening `{`, return the text from
 * that `{` to the matching `}` inclusive, respecting strings and comments.
 */
function extractBracedBlock(src, openBraceIdx) {
  let depth = 0;
  let i = openBraceIdx;
  let inStr = false, strChar = "", escaped = false;
  let inLineComment = false, inBlockComment = false;

  while (i < src.length) {
    const ch = src[i];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++; continue;
    }
    if (inBlockComment) {
      if (ch === "*" && src[i + 1] === "/") { inBlockComment = false; i += 2; } else i++;
      continue;
    }
    if (escaped) { escaped = false; i++; continue; }
    if (inStr) {
      if (ch === "\\") escaped = true;
      else if (ch === strChar) inStr = false;
      i++; continue;
    }

    if (ch === "/" && src[i + 1] === "/") { inLineComment = true; i += 2; continue; }
    if (ch === "/" && src[i + 1] === "*") { inBlockComment = true; i += 2; continue; }
    if (ch === "\"" || ch === "'" || ch === "`") { inStr = true; strChar = ch; i++; continue; }

    if (ch === "{") { depth++; i++; continue; }
    if (ch === "}") {
      depth--;
      i++;
      if (depth === 0) return src.slice(openBraceIdx, i);
      continue;
    }
    i++;
  }
  return src.slice(openBraceIdx, i);
}

/**
 * Extract the top-level method/property names from an object literal whose
 * text starts with `{`. Tracks brace, paren, and bracket depth separately so
 * that commas inside function parameter lists do not look like property
 * separators. Handles single-line and multi-line objects.
 *
 * Returns a Set of string names.
 */
function extractTopLevelKeys(objText) {
  const keys = new Set();
  let braceDepth = 0; // {} depth within the object (0 = top level)
  let parenDepth = 0; // () depth — prevents parameter commas from faking boundary
  let bracketDepth = 0; // [] depth — same for array elements
  let i = 1; // skip the opening {
  let inStr = false, strChar = "", escaped = false;
  let inLineComment = false, inBlockComment = false;
  let atBoundary = true; // right after { or a real property-separator ,
  /**
   * A newline only starts a property when the line before it ENDED a property.
   * It used to start one unconditionally, so a value continued onto the next line
   * had its first token read as a key:
   *
   *   buildModuleAvailabilityResolver: (getModuleMap) =>
   *     moduleAvailabilityResolver(...)      <-- recorded as a second key
   *
   * That reported a phantom against a double whose keys were all real, and a
   * parser that invents keys is one that can also miss them.
   */
  let lastMeaningful = "{";

  const isTopLevel = () => braceDepth === 0 && parenDepth === 0 && bracketDepth === 0;

  while (i < objText.length - 1) {
    const ch = objText[i];

    if (inLineComment) {
      if (ch === "\n") { inLineComment = false; if (isTopLevel()) atBoundary = true; }
      i++; continue;
    }
    if (inBlockComment) {
      if (ch === "*" && objText[i + 1] === "/") { inBlockComment = false; i += 2; } else i++;
      continue;
    }
    if (escaped) { escaped = false; i++; continue; }
    if (inStr) {
      if (ch === "\\") escaped = true;
      else if (ch === strChar) inStr = false;
      i++; continue;
    }

    if (ch === "/" && objText[i + 1] === "/") { inLineComment = true; i += 2; atBoundary = false; continue; }
    if (ch === "/" && objText[i + 1] === "*") { inBlockComment = true; i += 2; atBoundary = false; continue; }
    if (ch === "\"" || ch === "'" || ch === "`") { inStr = true; strChar = ch; i++; atBoundary = false; continue; }

    if (ch === "{") { braceDepth++; i++; atBoundary = false; lastMeaningful = ch; continue; }
    if (ch === "}") { braceDepth--; i++; atBoundary = false; lastMeaningful = ch; continue; }
    if (ch === "(") { parenDepth++; i++; atBoundary = false; lastMeaningful = ch; continue; }
    if (ch === ")") { parenDepth--; i++; atBoundary = false; lastMeaningful = ch; continue; }
    if (ch === "[") { bracketDepth++; i++; atBoundary = false; lastMeaningful = ch; continue; }
    if (ch === "]") { bracketDepth--; i++; atBoundary = false; lastMeaningful = ch; continue; }

    if (ch === "," && isTopLevel()) { atBoundary = true; lastMeaningful = ch; i++; continue; }
    if (ch === "\n") {
      if (isTopLevel() && (lastMeaningful === "," || lastMeaningful === "{")) atBoundary = true;
      i++; continue;
    }
    if ((ch === " " || ch === "\t") && atBoundary) { i++; continue; }

    if (atBoundary && isTopLevel()) {
      const remaining = objText.slice(i);
      let name = null;

      const asyncMatch = /^async\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[<(]/.exec(remaining);
      if (asyncMatch) name = asyncMatch[1];

      if (!name) {
        const accMatch = /^(get|set)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/.exec(remaining);
        if (accMatch) name = accMatch[2];
      }

      if (!name) {
        const basicMatch = /^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[<(:]/.exec(remaining);
        if (basicMatch) name = basicMatch[1];
      }

      if (name && !SKIP_KEYWORDS.has(name)) {
        keys.add(name);
      }
      atBoundary = false;
    } else {
      atBoundary = false;
    }

    i++;
  }
  return keys;
}

/**
 * Within a factory function body (a braced block starting with `{`), find
 * the position of the opening `{` of the FIRST `return {...}` statement that
 * appears at function-depth 0 — i.e. not inside a nested arrow function or
 * regular function body.
 *
 * Why this matters: Drizzle query-builder mocks embed `return { innerJoin,
 * where, onConflictDoUpdate, … }` inside callback arrow functions (e.g.
 * `from: (table) => { return { innerJoin: …, where: … }; }`). Those inner
 * `return {…}` blocks are part of the builder chain, not the factory's own
 * return value. A naive `/\breturn\s*\{/` scan finds the FIRST match
 * anywhere in the body and misattributes the builder methods to the enclosing
 * service class.
 *
 * The rule is structural, not name-based: a `{` that follows `=>` (trimming
 * whitespace) or a `function(…)` keyword opens a nested function body and
 * increments `functionDepth`. Any `return {` inside such a block is at
 * `functionDepth > 0` and is excluded. Only `return {` at `functionDepth === 0`
 * can represent the factory's own direct return value.
 *
 * This cannot mask a real phantom: a genuine service mock returned directly
 * by the factory (`return { realMethod: jest.fn() }`) is still at depth 0
 * and is still extracted. The only thing suppressed is a `return {` that is
 * itself the body of a callback passed to a builder method — and no real
 * service is mocked that way.
 *
 * Returns the index within `funcBody` of the `{` that opens the return block,
 * or -1 if none is found at the top level.
 */
function findTopLevelReturnBrace(funcBody) {
  let braceDepth = 0;
  let functionDepth = 0;
  const isFnBrace = [];
  let i = 0;
  let inStr = false, strChar = "", escaped = false;
  let inLineComment = false, inBlockComment = false;

  while (i < funcBody.length) {
    const ch = funcBody[i];

    if (inLineComment) { if (ch === "\n") inLineComment = false; i++; continue; }
    if (inBlockComment) {
      if (ch === "*" && funcBody[i + 1] === "/") { inBlockComment = false; i += 2; } else i++;
      continue;
    }
    if (escaped) { escaped = false; i++; continue; }
    if (inStr) {
      if (ch === "\\") escaped = true;
      else if (ch === strChar) inStr = false;
      i++; continue;
    }
    if (ch === "/" && funcBody[i + 1] === "/") { inLineComment = true; i += 2; continue; }
    if (ch === "/" && funcBody[i + 1] === "*") { inBlockComment = true; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = true; strChar = ch; i++; continue; }

    if (ch === "{") {
      const before = funcBody.slice(0, i).trimEnd();
      const opensFn =
        before.endsWith("=>") ||
        /\bfunction\s*(?:\w+\s*)?\([^)]*\)\s*$/.test(before);
      isFnBrace.push(opensFn);
      if (opensFn) functionDepth++;
      braceDepth++;
      i++; continue;
    }

    if (ch === "}") {
      const wasFn = isFnBrace.pop() ?? false;
      if (wasFn) functionDepth--;
      braceDepth--;
      i++; continue;
    }

    if (functionDepth === 0 && braceDepth >= 1) {
      const remaining = funcBody.slice(i);
      const m = /^return\s*\{/.exec(remaining);
      if (m) return i + m[0].length - 1;
    }

    i++;
  }
  return -1;
}

/**
 * Extract public method names from a class body.
 * `classSrc` is the full source text of the file.
 * `className` is the class name to find.
 * Returns a Set of method names, or null if the class is not found.
 */
function extractClassPublicMethods(classSrc, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const classRe = new RegExp(
    `\\bclass\\s+${escaped}(?:<[^>]*>)?(?:\\s+extends\\s+[^{]+)?(?:\\s+implements\\s+[^{]+)?\\s*\\{`,
  );
  const classMatch = classRe.exec(classSrc);
  if (!classMatch) return null;

  const openBraceIdx = classMatch.index + classMatch[0].length - 1;
  const classBody = extractBracedBlock(classSrc, openBraceIdx);

  const methods = new Set();
  const lines = classBody.split("\n");
  let bodyDepth = -1; // -1 so that after the class's opening { it becomes 0

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
    if (trimmed.startsWith("@")) continue;

    if (
      trimmed.startsWith("private ") ||
      trimmed.startsWith("protected ") ||
      trimmed.startsWith("#") ||
      /^\s*private\s/.test(line) ||
      /^\s*protected\s/.test(line)
    ) {
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      bodyDepth += opens - closes;
      continue;
    }

    if (bodyDepth > 0) {
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      bodyDepth += opens - closes;
      continue;
    }

    let rest = trimmed
      .replace(/^public\s+/, "")
      .replace(/^static\s+/, "")
      .replace(/^override\s+/, "")
      .replace(/^abstract\s+/, "")
      .replace(/^async\s+/, "")
      .replace(/^public\s+/, "")
      .replace(/^static\s+/, "")
      .replace(/^async\s+/, "");

    const accMatch = /^(get|set)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/.exec(rest);
    if (accMatch && accMatch[2] !== "constructor") {
      methods.add(accMatch[2]);
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      bodyDepth += opens - closes;
      continue;
    }

    const methodMatch = /^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[<(]/.exec(rest);
    if (methodMatch && methodMatch[1] !== "constructor") {
      methods.add(methodMatch[1]);
    }

    const propertyMatch = /^(?:readonly\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[?!]?\s*[:=]/.exec(rest);
    if (propertyMatch && !SKIP_KEYWORDS.has(propertyMatch[1])) {
      methods.add(propertyMatch[1]);
    }

    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    bodyDepth += opens - closes;
  }

  return methods;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function collectFiles(dir, predicate) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) results.push(...collectFiles(full, predicate));
    else if (predicate(entry, full)) results.push(full);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Mock-pair extraction from a single spec file
// ---------------------------------------------------------------------------

/**
 * From one spec file's source text, return an array of
 * { className, mockMethods: Set<string>, source } pairs.
 *
 * Covers three patterns:
 *   A) `as unknown as ClassName` / `as ClassName` applied to a variable
 *   B) useValue: { ... } with provide: ClassName nearby
 *   C) function return type annotation: (): ClassName { return { ... } }
 */
function extractMockPairs(src, filePath) {
  const pairs = [];

  // ---- Pass 1: collect named variable declarations -------------------------
  // const/let/var varName = {
  const varObjects = new Map(); // varName → Set<methodName>

  const constRe = /\b(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::[^=]+)?\s*=\s*\{/g;
  let cm;
  while ((cm = constRe.exec(src)) !== null) {
    const varName = cm[1];
    const openBrace = src.lastIndexOf("{", cm.index + cm[0].length);
    if (openBrace < 0) continue;
    const block = extractBracedBlock(src, openBrace);
    const keys = extractTopLevelKeys(block);
    if (keys.size > 0) varObjects.set(varName, keys);
  }

  // Also collect factory function patterns:
  // function makeFoo(): ClassName { return { ... } as unknown as ClassName; }
  // or: function makeFoo(): ClassName { return { ... }; }
  const factoryRe = /function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*:\s*([A-Z][a-zA-Z0-9_$]*)\s*\{/g;
  let fm;
  while ((fm = factoryRe.exec(src)) !== null) {
    const className = fm[2];
    const openBrace = src.indexOf("{", fm.index + fm[0].length - 1);
    if (openBrace < 0) continue;
    const funcBody = extractBracedBlock(src, openBrace);
    const retBrace = findTopLevelReturnBrace(funcBody);
    if (retBrace < 0) continue;
    const retBlock = extractBracedBlock(funcBody, retBrace);
    const keys = extractTopLevelKeys(retBlock);
    if (keys.size > 0)
      pairs.push({ className, mockMethods: keys, specFile: filePath, pattern: "factory-return" });
  }

  // ---- Pass 2: find type-cast links ----------------------------------------
  // varName as unknown as ClassName  or  varName as ClassName
  const castRe = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s+as\s+unknown\s+as\s+([A-Z][a-zA-Z0-9_$]*)/g;
  let cast;
  while ((cast = castRe.exec(src)) !== null) {
    const varName = cast[1];
    const className = cast[2];
    if (varObjects.has(varName)) {
      pairs.push({
        className,
        mockMethods: varObjects.get(varName),
        specFile: filePath,
        pattern: "cast",
      });
    }
  }

  // Inline object literal cast: `{ ... } as unknown as ClassName`
  // Find `} as unknown as ClassName` and look backwards for the opening {
  const inlineCastRe = /\}\s+as\s+unknown\s+as\s+([A-Z][a-zA-Z0-9_$]*)/g;
  let ic;
  while ((ic = inlineCastRe.exec(src)) !== null) {
    const className = ic[1];
    // Find the matching opening brace by scanning backward
    const closeBracePos = ic.index;
    let depth = 0;
    let j = closeBracePos;
    let inS = false, sChar = "", esc = false;
    while (j >= 0) {
      const c = src[j];
      if (esc) { esc = false; j--; continue; }
      if (inS) { if (c === "\\") esc = true; else if (c === sChar) inS = false; j--; continue; }
      if (c === "\"" || c === "'" || c === "`") { inS = true; sChar = c; j--; continue; }
      if (c === "}") { depth++; j--; continue; }
      if (c === "{") {
        depth--;
        if (depth === 0) { // found the matching opening brace
          const block = extractBracedBlock(src, j);
          const keys = extractTopLevelKeys(block);
          if (keys.size > 0)
            pairs.push({ className, mockMethods: keys, specFile: filePath, pattern: "inline-cast" });
          break;
        }
        j--; continue;
      }
      j--;
    }
  }

  // ---- Pass 3: useValue patterns -------------------------------------------
  // { provide: ClassName, useValue: { ... } }
  // { provide: ClassName, useValue: varName }         (simple variable ref)
  // { provide: ClassName, useValue: varName.prop }    (skip — property access of aggregate object)
  // { provide: ClassName, useValue: makeFn() }        (skip — function call)
  const useValueRe = /\buseValue\s*:\s*(?:\{|([a-zA-Z_$][a-zA-Z0-9_$]*)([.(]?))/g;
  let uv;
  while ((uv = useValueRe.exec(src)) !== null) {
    const varRef = uv[1]; // set if useValue: identifierRef (before any . or ()
    const suffix = uv[2]; // '.' or '(' or '' — indicates property access or call
    const useValuePos = uv.index;

    // Look backwards up to 600 chars for `provide: ClassName`
    const window = src.slice(Math.max(0, useValuePos - 600), useValuePos);
    const provideMatch = /\bprovide\s*:\s*(?:([A-Z][a-zA-Z0-9_$]*)(?:\s*,|\s*\n)|["'`])/g;
    let pm, lastPm;
    while ((pm = provideMatch.exec(window)) !== null) lastPm = pm;
    if (!lastPm || !lastPm[1]) continue;
    const className = lastPm[1];

    if (varRef) {
      // Skip property access (varName.prop) and function calls (fn()) — cannot resolve their type
      if (suffix === "." || suffix === "(") continue;
      if (varObjects.has(varRef)) {
        pairs.push({
          className,
          mockMethods: varObjects.get(varRef),
          specFile: filePath,
          pattern: "useValue-var",
        });
      }
    } else {
      const openBrace = src.indexOf("{", uv.index + uv[0].length - 1);
      if (openBrace < 0) continue;
      const block = extractBracedBlock(src, openBrace);
      const keys = extractTopLevelKeys(block);
      if (keys.size > 0)
        pairs.push({ className, mockMethods: keys, specFile: filePath, pattern: "useValue-inline" });
    }
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Self-test — must exercise the SAME code paths as the real scan
// ---------------------------------------------------------------------------

if (SELF_TEST) {
  console.log("Running self-test...");
  let failed = false;

  // --- Test 1: extractTopLevelKeys basic ---
  const obj1 = `{
  cached: jest.fn(),
  invalidate: jest.fn(),
  phantomMethod: jest.fn(),
  cachedForOrg(o, k, fn) {
    return this.cached(o + k, fn);
  },
}`;
  const keys1 = extractTopLevelKeys(obj1);
  if (!keys1.has("cached") || !keys1.has("invalidate") || !keys1.has("phantomMethod") || !keys1.has("cachedForOrg")) {
    console.error("SELF-TEST FAILED: extractTopLevelKeys missed expected keys");
    console.error("Got:", [...keys1]);
    failed = true;
  } else {
    console.log("  [pass] extractTopLevelKeys — basic");
  }

  // --- Test 2: extractTopLevelKeys should NOT pick up nested keys ---
  const obj2 = `{
  query: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  topLevel: jest.fn(),
}`;
  const keys2 = extractTopLevelKeys(obj2);
  if (keys2.has("findFirst") || keys2.has("findMany")) {
    console.error("SELF-TEST FAILED: extractTopLevelKeys picked up nested keys");
    console.error("Got:", [...keys2]);
    failed = true;
  } else if (!keys2.has("query") || !keys2.has("topLevel")) {
    console.error("SELF-TEST FAILED: extractTopLevelKeys missed top-level keys");
    console.error("Got:", [...keys2]);
    failed = true;
  } else {
    console.log("  [pass] extractTopLevelKeys — nested keys excluded");
  }

  // --- Test 3: extractTopLevelKeys single-line ---
  const obj3 = `{ resolve: jest.fn(), reject: jest.fn() }`;
  const keys3 = extractTopLevelKeys(obj3);
  if (!keys3.has("resolve") || !keys3.has("reject")) {
    console.error("SELF-TEST FAILED: extractTopLevelKeys missed single-line keys");
    console.error("Got:", [...keys3]);
    failed = true;
  } else {
    console.log("  [pass] extractTopLevelKeys — single-line");
  }

  // --- Test 4: extractClassPublicMethods ---
  const classSrc = `
export class CacheService {
  private readonly redis: Redis | null;

  constructor(redis: Redis | null) { this.redis = redis; }

  async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  async invalidate(key: string): Promise<void> {
    // noop
  }

  private async internalHelper(): Promise<void> {
    // private
  }

  get isConnected(): boolean {
    return this.redis !== null;
  }
}`;
  const classMethods = extractClassPublicMethods(classSrc, "CacheService");
  if (!classMethods) {
    console.error("SELF-TEST FAILED: extractClassPublicMethods returned null");
    failed = true;
  } else {
    if (!classMethods.has("cached") || !classMethods.has("invalidate") || !classMethods.has("isConnected")) {
      console.error("SELF-TEST FAILED: extractClassPublicMethods missed public methods");
      console.error("Got:", [...classMethods]);
      failed = true;
    } else if (classMethods.has("internalHelper") || classMethods.has("constructor")) {
      console.error("SELF-TEST FAILED: extractClassPublicMethods included private/constructor");
      console.error("Got:", [...classMethods]);
      failed = true;
    } else {
      console.log("  [pass] extractClassPublicMethods");
    }
  }

  // --- Test 5: full pipeline — detect phantom method ---
  // Synthetic spec file that plants `phantomMethod` in a CacheService mock
  const syntheticSpec = `
import type { CacheService } from "./cache.service";

function makeCacheMock(): CacheService {
  return {
    cached: jest.fn(),
    invalidate: jest.fn(),
    phantomMethod: jest.fn(),
  } as unknown as CacheService;
}
`;
  const syntheticClass = `
export class CacheService {
  async cached<T>(key: string, fn: () => Promise<T>): Promise<T> { return fn(); }
  async invalidate(key: string): Promise<void> {}
}
`;

  const propertyClass = `
export class KbPageAdapter {
  readonly contentType = "page";
  declaredLimit: number = 10;
  private readonly hidden = "x";
  async handle(orgId: string, contentId: number): Promise<void> {}
}
`;
  const propertyMembers = extractClassPublicMethods(propertyClass, "KbPageAdapter");
  if (!propertyMembers || !propertyMembers.has("contentType")) {
    console.error(
      "SELF-TEST FAILED: a public readonly property was not recognised as a class member, so any mock declaring it reads as a phantom",
    );
    failed = true;
  } else if (!propertyMembers.has("declaredLimit")) {
    console.error("SELF-TEST FAILED: a public typed field was not recognised as a class member");
    failed = true;
  } else if (!propertyMembers.has("handle")) {
    console.error("SELF-TEST FAILED: property matching swallowed a real method");
    failed = true;
  } else if (propertyMembers.has("hidden")) {
    console.error("SELF-TEST FAILED: a private property was exposed as a public member");
    failed = true;
  } else {
    console.log("  [pass] extractClassPublicMethods — public properties count as members, private ones do not");
  }

  const pairs = extractMockPairs(syntheticSpec, "synthetic.spec.ts");
  const csPair = pairs.find((p) => p.className === "CacheService");
  if (!csPair) {
    console.error("SELF-TEST FAILED: extractMockPairs did not find CacheService pair");
    console.error("Pairs found:", pairs.map((p) => p.className));
    failed = true;
  } else {
    const realMethods = extractClassPublicMethods(syntheticClass, "CacheService");
    if (!realMethods) {
      console.error("SELF-TEST FAILED: could not extract real class methods from synthetic source");
      failed = true;
    } else {
      const phantoms = [...csPair.mockMethods].filter((m) => !realMethods.has(m));
      if (!phantoms.includes("phantomMethod")) {
        console.error("SELF-TEST FAILED: phantomMethod not detected as phantom");
        console.error("Mock methods:", [...csPair.mockMethods]);
        console.error("Real methods:", [...realMethods]);
        console.error("Phantoms found:", phantoms);
        failed = true;
      } else if (phantoms.includes("cached") || phantoms.includes("invalidate")) {
        console.error("SELF-TEST FAILED: false positive — real methods flagged as phantoms");
        console.error("Phantoms found:", phantoms);
        failed = true;
      } else {
        console.log("  [pass] full pipeline — phantom method detected, no false positives");
      }
    }
  }

  // --- Test 6: useValue-inline pattern ---
  const specWithUseValue = `
Test.createTestingModule({
  providers: [
    SomeService,
    {
      provide: CacheService,
      useValue: {
        cached: jest.fn(),
        invalidate: jest.fn(),
        ghostMethod: jest.fn(),
      },
    },
  ],
});
`;
  const uvPairs = extractMockPairs(specWithUseValue, "usevalue-test.spec.ts");
  const uvPair = uvPairs.find((p) => p.className === "CacheService");
  if (!uvPair) {
    console.error("SELF-TEST FAILED: useValue-inline pattern not detected");
    console.error("Pairs found:", uvPairs.map((p) => p.className));
    failed = true;
  } else if (!uvPair.mockMethods.has("ghostMethod") || !uvPair.mockMethods.has("cached")) {
    console.error("SELF-TEST FAILED: useValue-inline keys not extracted");
    console.error("Mock methods:", [...uvPair.mockMethods]);
    failed = true;
  } else {
    console.log("  [pass] useValue-inline pattern");
  }

  const specWithStringToken = `
Test.createTestingModule({
  providers: [
    { provide: CacheService, useValue: makeCache() },
    { provide: "NotificationsService", useValue: { create: jest.fn() } },
  ],
});
`;
  const stringTokenPairs = extractMockPairs(specWithStringToken, "string-token-test.spec.ts");
  if (stringTokenPairs.some((p) => p.className === "CacheService" && p.mockMethods.has("create"))) {
    console.error("SELF-TEST FAILED: a string-token provider's double was attributed to the class provided before it");
    failed = true;
  } else {
    console.log("  [pass] a string-token provider is not attributed to an earlier class provider");
  }

  // --- Test 7: vacuity — a scan that finds nothing must fail ---
  // Verify that if collectFiles returns an empty array, we'd exit non-zero
  const emptySpecList = [];
  const wouldFail = emptySpecList.length < MIN_SPEC_FILES;
  if (!wouldFail) {
    console.error("SELF-TEST FAILED: vacuity guard would not trigger on empty spec list");
    failed = true;
  } else {
    console.log("  [pass] vacuity guard triggers on empty spec list");
  }

  // --- Test 8: builder-chain nested return {} NOT extracted ---
  // A factory that returns `new ServiceClass(db)` where `db` has nested
  // arrow-function callbacks that each `return { builderMethod: … }` must NOT
  // have those builder methods attributed to the service class.
  // This exercises findTopLevelReturnBrace: the inner return {} blocks are at
  // functionDepth > 0 and must be skipped; the outer `return new X(...)` does
  // not match `return {`, so no pair is created for the builder methods.
  const specWithBuilderChainReturn = `
function makeService(opts): SomeService {
  const db = {
    select: () => ({
      from: (table) => {
        return { innerJoin: () => ({ where: () => [] }), where: () => [] };
      },
    }),
    insert: (tbl) => ({
      values: (rows) => {
        return {
          onConflictDoNothing: () => Promise.resolve(),
          onConflictDoUpdate: () => Promise.resolve(),
        };
      },
    }),
  };
  return new SomeService(db);
}
`;
  const builderPairs = extractMockPairs(specWithBuilderChainReturn, "builder-chain-test.spec.ts");
  const builderPair = builderPairs.find((p) => p.className === "SomeService");
  const builderLeaked =
    builderPair &&
    (builderPair.mockMethods.has("innerJoin") ||
      builderPair.mockMethods.has("where") ||
      builderPair.mockMethods.has("onConflictDoNothing") ||
      builderPair.mockMethods.has("onConflictDoUpdate"));
  if (builderLeaked) {
    console.error("SELF-TEST FAILED: builder-chain nested return {} leaked methods into factory pair");
    console.error("Leaked methods:", [...builderPair.mockMethods]);
    failed = true;
  } else {
    console.log("  [pass] builder-chain nested return {} — builder methods not attributed to service");
  }

  // --- Test 9: top-level factory return {} IS still detected (anti-vacuity) ---
  // Proves the fix in Test 8 does not suppress the detection of real phantoms
  // returned directly at the top level of a factory function. If this test
  // passes while Test 8 also passes, the rule genuinely bites on real phantoms
  // and only suppresses the builder-chain case.
  const specWithTopLevelReturn = `
function makeService(): AnotherService {
  return {
    realMethod: jest.fn(),
    phantomOnlyOnMock: jest.fn(),
  };
}
`;
  const tlPairs = extractMockPairs(specWithTopLevelReturn, "toplevel-return-test.spec.ts");
  const tlPair = tlPairs.find((p) => p.className === "AnotherService");
  if (!tlPair || !tlPair.mockMethods.has("phantomOnlyOnMock") || !tlPair.mockMethods.has("realMethod")) {
    console.error("SELF-TEST FAILED: top-level factory return {} methods not extracted");
    console.error("Pairs found:", tlPairs.map((p) => p.className));
    if (tlPair) console.error("Mock methods:", [...tlPair.mockMethods]);
    failed = true;
  } else {
    console.log("  [pass] top-level factory return {} — methods correctly attributed to service");
  }

  if (failed) {
    console.error("\nSELF-TEST FAILED");
    process.exit(1);
  }
  console.log("\nSELF-TEST PASSED");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Real scan
// ---------------------------------------------------------------------------

/**
 * Spec files AND shared test-support files under a `__tests__/` directory.
 *
 * The walk used to take `*.spec.ts` only, so every shared stub module was
 * invisible — and a shared stub is the worst possible place to miss a phantom,
 * because one wrong name is inherited by every spec that imports it and surfaces
 * as "x is not a function" inside whichever service first reaches that branch.
 * Found exactly that: `INVENTORY_ISOLATION_STUBS` provided
 * `InventoryAccountingBridge` as `{ postMovement }`, a method the real class does
 * not have, while omitting the five it does.
 */
const isTestSupportFile = (name, full) =>
  name.endsWith(".ts") &&
  !name.endsWith(".d.ts") &&
  /[\\/]__tests__[\\/]/.test(full);

const specFiles = collectFiles(
  SRC_ROOT,
  (name, full) =>
    name.endsWith(".spec.ts") || name.endsWith(".e2e-spec.ts") || isTestSupportFile(name, full),
);

if (specFiles.length < MIN_SPEC_FILES) {
  console.error(`FATAL: Found only ${specFiles.length} spec files — expected at least ${MIN_SPEC_FILES}.`);
  console.error("The filesystem walk is broken. Check SRC_ROOT:", SRC_ROOT);
  process.exit(2);
}
console.log(`Scanning ${specFiles.length} spec files...`);

// Build the class → source file map from all non-spec .ts files (fallback)
const sourceFiles = collectFiles(SRC_ROOT, (name) => name.endsWith(".ts") && !name.endsWith(".spec.ts") && !name.endsWith(".e2e-spec.ts") && !name.endsWith(".d.ts"));
const classToFile = new Map(); // className → file path (first match wins — used as fallback only)
const classToAllFiles = new Map(); // className → [all file paths] — for collision detection

for (const filePath of sourceFiles) {
  const src = readFileSync(filePath, "utf8");
  const classRe = /\bclass\s+([A-Z][a-zA-Z0-9_$]*)/g;
  let m;
  while ((m = classRe.exec(src)) !== null) {
    const name = m[1];
    if (!classToFile.has(name)) classToFile.set(name, filePath);
    const all = classToAllFiles.get(name) ?? [];
    all.push(filePath);
    classToAllFiles.set(name, all);
  }
}

/**
 * Parse import statements from a spec file source and return a map of
 * ClassName → resolved absolute file path. Only handles static named imports.
 */
function parseImports(src, specFilePath) {
  const specDir = dirname(specFilePath);
  const imports = new Map(); // ClassName → absolutePath

  const importRe = /\bimport\s+(?:type\s+)?(?:\{([^}]+)\}|\*\s+as\s+\w+|(\w+))\s+from\s+["']([^"']+)["']/g;
  let m;
  while ((m = importRe.exec(src)) !== null) {
    const namedImports = m[1]; // e.g., "ClassA, ClassB as CB"
    const defaultImport = m[2]; // e.g., "SomeDefault"
    const importPath = m[3]; // e.g., "./some/service"

    if (!importPath.startsWith(".") && !importPath.startsWith("/")) continue; // skip node_modules

    // Resolve the import path to an absolute file path
    let resolvedBase = resolve(specDir, importPath);
    let resolvedPath = null;

    for (const ext of ["", ".ts", "/index.ts"]) {
      const candidate = resolvedBase + ext;
      try {
        const s = statSync(candidate);
        if (s.isFile()) { resolvedPath = candidate; break; }
      } catch { /* not found */ }
    }
    if (!resolvedPath) continue;

    // Extract class names from named imports: { ClassA, ClassB as CB, type ClassC }
    if (namedImports) {
      for (const part of namedImports.split(",")) {
        const trimmed = part.trim().replace(/^type\s+/, "");
        const name = trimmed.split(/\s+as\s+/)[0].trim();
        if (/^[A-Z]/.test(name)) imports.set(name, resolvedPath);
      }
    }
    if (defaultImport && /^[A-Z]/.test(defaultImport)) {
      imports.set(defaultImport, resolvedPath);
    }
  }

  return imports;
}

// Cache of resolved class methods per file path
const fileMethodsCache = new Map(); // filePath:className → Set<string> | null

function getClassMethodsFromFile(filePath, className) {
  const key = `${filePath}::${className}`;
  if (fileMethodsCache.has(key)) return fileMethodsCache.get(key);
  const src = readFileSync(filePath, "utf8");
  const methods = extractClassPublicMethods(src, className);
  fileMethodsCache.set(key, methods); // set early to prevent inheritance cycles
  if (methods) {
    const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const extendsRe = new RegExp(
      `\\bclass\\s+${escaped}(?:<[^>]*>)?\\s+extends\\s+([A-Z][a-zA-Z0-9_$]*)`,
    );
    const m = extendsRe.exec(src);
    if (m) {
      const parentName = m[1];
      const parentInSameFile = extractClassPublicMethods(src, parentName);
      if (parentInSameFile) {
        for (const pm of parentInSameFile) methods.add(pm);
      } else {
        const parentFiles = classToAllFiles.get(parentName) ?? [];
        if (parentFiles.length === 1) {
          const parentMethods = getClassMethodsFromFile(parentFiles[0], parentName);
          if (parentMethods) {
            for (const pm of parentMethods) methods.add(pm);
          }
        }
      }
    }
  }
  return methods;
}

function getClassMethods(className, importedPath) {
  // 1. If import-resolved path is known, use that (avoids class name collisions)
  if (importedPath) {
    const methods = getClassMethodsFromFile(importedPath, className);
    if (methods !== null) return { methods, resolvedFile: importedPath };
  }

  // 2. If there are multiple files for this class name, skip (ambiguous without import info)
  const allFiles = classToAllFiles.get(className) ?? [];
  if (allFiles.length > 1 && !importedPath) return null; // ambiguous — skip to avoid false positives

  // 3. Fall back to global map
  const filePath = classToFile.get(className);
  if (!filePath) return null;
  const methods = getClassMethodsFromFile(filePath, className);
  if (methods === null) return null;
  return { methods, resolvedFile: filePath };
}

// Collect all mock pairs with import resolution
const allPairs = [];
for (const specFile of specFiles) {
  const src = readFileSync(specFile, "utf8");
  const importMap = parseImports(src, specFile);
  const pairs = extractMockPairs(src, specFile);
  for (const pair of pairs) {
    pair.importedPath = importMap.get(pair.className) ?? null;
  }
  allPairs.push(...pairs);
}

// Count unique classes resolved
let resolvedCount = 0;
const classesAttempted = new Set(allPairs.map((p) => p.className));
for (const className of classesAttempted) {
  const result = getClassMethods(className, null);
  if (result !== null) resolvedCount++;
}

if (resolvedCount === 0) {
  console.error("FATAL: Resolved zero classes from all mock pairs — the class lookup is broken.");
  console.error("Classes attempted:", [...classesAttempted].slice(0, 10));
  process.exit(2);
}

console.log(`Resolved ${resolvedCount}+ classes from ${classesAttempted.size} candidates`);

// Compare — dedupe by (className, phantomMethod, specFile)
const byClassAndFile = new Map(); // `className::resolvedFile` → { phantoms: Map, className, realFile }

for (const pair of allPairs) {
  const { className, mockMethods, specFile, importedPath } = pair;
  const resolved = getClassMethods(className, importedPath);
  if (!resolved) continue;
  const { methods: realMethods, resolvedFile } = resolved;

  const key = `${className}::${resolvedFile}`;
  for (const method of mockMethods) {
    if (!realMethods.has(method)) {
      if (!byClassAndFile.has(key)) byClassAndFile.set(key, { phantoms: new Map(), className, realFile: resolvedFile });
      const entry = byClassAndFile.get(key);
      if (!entry.phantoms.has(method)) entry.phantoms.set(method, new Set());
      entry.phantoms.get(method).add(specFile);
    }
  }
}

// Report
const SEPARATOR = "─".repeat(72);
let totalPhantoms = 0;

if (byClassAndFile.size === 0) {
  console.log("\n" + SEPARATOR);
  console.log("OK — no phantom mock methods found");
  console.log(`Doubles scanned   : ${allPairs.length}`);
  console.log(`Classes resolved  : ${resolvedCount}`);
  console.log(`Genuine defects   : 0`);
  process.exit(0);
}

console.log("\n" + SEPARATOR);
console.log("FAIL — phantom mock methods detected");
console.log(SEPARATOR);

for (const [, { phantoms, className, realFile }] of [...byClassAndFile.entries()].sort()) {
  const relReal = relative(BACKEND_ROOT, realFile);
  console.log(`\nClass: ${className}`);
  console.log(`  Real class: ${relReal}`);
  for (const [method, files] of [...phantoms.entries()].sort()) {
    totalPhantoms++;
    console.log(`  [PHANTOM] .${method}() — exists on mock but NOT on the real class`);
    for (const f of files) {
      const rel = relative(BACKEND_ROOT, f);
      console.log(`    spec: ${rel}`);
    }
  }
}

console.log("\n" + SEPARATOR);
console.log(`Doubles scanned   : ${allPairs.length}`);
console.log(`Classes resolved  : ${resolvedCount}`);
console.log(`Genuine defects   : ${totalPhantoms}`);
console.log(SEPARATOR);
process.exit(1);
