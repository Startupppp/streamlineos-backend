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
 * VACUITY GUARDS
 * - Fewer than 100 module files found → exit 2 ("walk is broken")
 * - Zero @Module decorators parsed → exit 2
 *
 * SELF-TEST (--self-test)
 * Runs the real detection functions over synthetic modules: the exact
 * StorageModule defect must be FLAGGED, and the fixed form, a re-exported
 * module, a custom provider token, a forwardRef import and a spread-free
 * multiline factory must all come back CLEAN. Same code path as the scan —
 * not a parallel implementation.
 *
 * Usage:
 *   node src/scripts/check-module-di.mjs [--self-test]
 *   pnpm check:module-di
 *   pnpm check:module-di:self-test
 *
 * Exit codes:
 *   0 — clean (or self-test passed)
 *   1 — invalid exports found (or self-test failed)
 *   2 — scan is broken (vacuity check failed)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
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

function runSelfTest() {
  const cases = [
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

  let failures = 0;
  for (const c of cases) {
    const result = analyseModuleSource(c.src);
    if (!result) {
      console.error(`SELF-TEST FAIL: ${c.name} — module object did not parse`);
      failures++;
      continue;
    }
    const got = JSON.stringify(result.invalid);
    const want = JSON.stringify(c.expectInvalid);
    if (got !== want) {
      console.error(`SELF-TEST FAIL: ${c.name}\n  expected invalid ${want}\n  got      invalid ${got}`);
      failures++;
    }
  }

  if (failures > 0) {
    console.error(`\n${String(failures)} of ${String(cases.length)} self-test assertions failed`);
    process.exit(1);
  }
  console.log(`check:module-di self-test passed — ${String(cases.length)} assertions`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

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

console.log(
  `check:module-di clean — ${String(parsed)} modules parsed of ${String(files.length)} files, 0 invalid exports`,
);
