#!/usr/bin/env node
/**
 * check-compression.mjs  (section 7.1 — Brotli/gzip compression gate)
 *
 * WHAT IT CHECKS
 * 1. COMPRESSION MIDDLEWARE — scans main.ts and app.module.ts for a
 *    compression middleware call (compression(), @nestjs/compression, or the
 *    Node.js built-in zlib/brotli pipe). Reports if none is found and provides
 *    the exact import+call to add.
 *
 * 2. CROSS-ORIGIN REFLECTION GUARD — checks that compressed responses are NOT
 *    sent to routes that reflect secrets from the request (BREACH / CRIME class
 *    attacks). Looks for route handlers decorated with @Public() or @Universal()
 *    that take a body echoed into the response with minimal variance (crude
 *    heuristic: handler name contains "reflect", "echo", "confirm" AND has both
 *    @Body() and a 2xx response). These are reported for manual review.
 *
 * 3. ALREADY-COMPRESSED EXCLUSIONS — checks that binary content types
 *    (image/*, video/*, application/zip, font/*) or endpoints returning pre-
 *    compressed assets are not double-compressed. Looks for @ApiProduces()
 *    annotations with binary types.
 *
 * 4. DECLARED OPTIONS (added 2026-09-04, v2 ticket 04) — checks 1-3 above amounted
 *    to `grep compression( main.ts`, and PRD-C089 asks for four properties none of
 *    which that grep can see: a minimum size, already-compressed exclusions, Brotli,
 *    and no compression of secrets in a cross-origin reflection context. A gate whose
 *    entire output was "compression middleware detected" reported OK over a call that
 *    took NO OPTIONS AT ALL, so every one of the four was a library default nothing
 *    in this repository stated. This check now asserts that `common/http/
 *    compression.config.ts` declares the threshold (1024), a non-empty already-
 *    compressed exclusion list including application/pdf, a Brotli quality, and a
 *    filter honouring the opt-out header — and that `main.ts` wires
 *    `httpCompressionOptions()` rather than a bare `compression()`.
 *
 * 5. SECRET-ON-THE-WIRE ADOPTION (added 2026-09-04, v2 ticket 04) — the BREACH clause
 *    of PRD-C089 is about ADOPTION, not mechanism: `x-no-compression` existed and was
 *    set by ZERO handlers, so the opt-out was a constant nobody used. This check finds
 *    every controller handler whose response body carries a token-shaped field —
 *    directly, or one hop into the service it delegates to — and requires each to
 *    declare an opt-out (`x-no-compression` or `Cache-Control: no-transform`). It is
 *    enforced at ZERO, not ratcheted: the repository is at zero exposures now.
 *
 * NOTE: Full verification requires running the server. This gate performs static
 * source analysis and reports what to add or verify at boot time.
 *
 * SELF-TEST (--self-test)
 * Proves detection of present/absent compression in synthetic fixtures.
 *
 * Usage:
 *   node src/scripts/check-compression.mjs [--self-test]
 *   pnpm check:compression
 *
 * Exit codes:
 *   0 — compression configured, declared, and no secret body is compressible
 *   1 — compression missing, an option undeclared, a secret body compressible, or
 *       self-test failed
 *   2 — main.ts or compression.config.ts not found
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const MAIN_TS_PATH = join(BACKEND_ROOT, "src", "main.ts");
const APP_MODULE_PATH = join(BACKEND_ROOT, "src", "app.module.ts");
const SRC_ROOT = join(BACKEND_ROOT, "src");
const COMPRESSION_CONFIG_PATH = join(SRC_ROOT, "common", "http", "compression.config.ts");

/**
 * The four properties PRD-C089 names, each as a thing the config file must SAY.
 * A default inherited from `compression@1.8.1` satisfies the runtime and satisfies
 * nobody reading the repository, and vanishes in a minor upgrade with no diff.
 */
export const REQUIRED_COMPRESSION_DECLARATIONS = [
  { key: "threshold", pattern: /COMPRESSION_THRESHOLD_BYTES\s*=\s*1024\b/, what: "a 1024-byte minimum size" },
  { key: "brotli", pattern: /BROTLI_PARAM_QUALITY\b/, what: "Brotli quality, keyed by the imported zlib constant" },
  { key: "opt-out", pattern: /NO_COMPRESSION_HEADER\s*=\s*["'`]x-no-compression["'`]/, what: "the x-no-compression opt-out constant" },
  { key: "filter", pattern: /export function shouldCompress\s*\(/, what: "an exported, testable filter" },
  { key: "no-transform", pattern: /no-transform/, what: "Cache-Control: no-transform as a second opt-out" },
];

/** Media types that must be named explicitly rather than trusted to a third-party table. */
export const REQUIRED_ALREADY_COMPRESSED = ["image/", "video/", "application/pdf", "application/zip"];

/** A response field whose value is a credential. Compressing one beside attacker-influenced text is BREACH. */
const SECRET_FIELD = "(token|rawToken|rawKey|accessToken|refreshToken|apiKey|secret|plaintext|password)";
const SECRET_RETURN_RE = new RegExp(`\\breturn\\s*\\{[^}]*\\b${SECRET_FIELD}\\b\\s*[,:}]`);
const OPT_OUT_RE = /NO_COMPRESSION_HEADER|x-no-compression|no-transform/;
const ROUTE_DECORATOR_RE = /@(Get|Post|Put|Patch|Delete)\(/;

const COMPRESSION_PATTERNS = [
  /\bcompression\s*\(\s*\)/,
  /app\.use\s*\(\s*compression/,
  /@nestjs\/compression/,
  /CompressionMiddleware/,
  /zlib\.(createBrotliCompress|createGzip|createDeflate)/,
  /\bbrotliCompress\b/,
];

const BINARY_MEDIA_TYPES = ["image/", "video/", "audio/", "application/zip", "application/octet-stream", "font/"];

export function detectCompression(source) {
  return COMPRESSION_PATTERNS.some((re) => re.test(source));
}

export function detectBinaryProducers(source) {
  const findings = [];
  const apiProducesRe = /@ApiProduces\s*\(\s*["'`]([^"'`]+)["'`]/g;
  let match;
  while ((match = apiProducesRe.exec(source)) !== null) {
    const mediaType = match[1];
    if (BINARY_MEDIA_TYPES.some((bt) => mediaType.startsWith(bt))) {
      findings.push(mediaType);
    }
  }
  return findings;
}

export function detectReflectionRisk(source) {
  const findings = [];
  const handlerRe = /(?:@Public\(\)|@Universal\(\))[\s\S]{0,400}(?:reflect|echo|confirm)\w*\s*\(/g;
  let match;
  while ((match = handlerRe.exec(source)) !== null) {
    findings.push({ excerpt: match[0].slice(0, 80).replace(/\n/g, " ") });
  }
  return findings;
}

/** Every .ts under `root`, excluding specs. */
export function collectSources(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!entry.endsWith(".ts") || entry.includes(".spec.")) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

/** The decorator block and signature of the class member that owns `index`. */
export function memberWindow(lines, index) {
  let start = index;
  while (start > 0 && !/^ {2}\}/.test(lines[start - 1] ?? "")) start--;
  return lines.slice(start, index + 1).join("\n");
}

/** Which declarations the config file is missing, and which exclusions it does not name. */
export function missingCompressionDeclarations(configSource) {
  const missing = REQUIRED_COMPRESSION_DECLARATIONS.filter((d) => !d.pattern.test(configSource)).map((d) => d.what);
  for (const type of REQUIRED_ALREADY_COMPRESSED)
    if (!configSource.includes(`"${type}"`)) missing.push(`${type} in the already-compressed exclusion list`);
  return missing;
}

/** `main.ts` must pass the declared options, not call `compression()` bare. */
export function wiresDeclaredOptions(mainSource) {
  return /app\.use\(\s*compression\(\s*httpCompressionOptions\(\)\s*\)\s*\)/.test(mainSource);
}

/**
 * `this.<prop>` → the file declaring the injected class, resolved through this file's
 * OWN imports so two same-named services in different modules stay apart.
 */
export function collaboratorFiles(file, source) {
  const byProp = new Map();
  const importPath = new Map();
  for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'](\.[^"']+)["']/g)) {
    for (const raw of (m[1] ?? "").split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0]?.trim();
      if (name) importPath.set(name, m[2]);
    }
  }
  for (const m of source.matchAll(/(?:private|public|protected)\s+(?:readonly\s+)?([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_]+)/g)) {
    const spec = importPath.get(m[2] ?? "");
    if (spec === undefined) continue;
    const base = resolve(dirname(file), spec);
    for (const candidate of [`${base}.ts`, join(base, "index.ts")])
      if (existsSync(candidate)) { byProp.set(m[1], candidate); break; }
  }
  return byProp;
}

/** Does `Class.method` in `source` return an object literal carrying a credential field? */
export function methodReturnsSecret(source, method) {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^\\s{2}(?:async\\s+)?${method}\\s*[(<]`).test(l));
  if (start < 0) return false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\}/.test(lines[i] ?? "")) break;
    if (SECRET_RETURN_RE.test(lines[i] ?? "")) return true;
  }
  return false;
}

/**
 * Handlers whose response body carries a credential — directly, or one hop into the
 * service they delegate to — reported with whether they declare a compression opt-out.
 */
export function findSecretBodyHandlers(files, readSource) {
  const found = [];
  for (const file of files) {
    const source = readSource(file);
    if (!/@Controller\(/.test(source)) continue;
    const lines = source.split("\n");
    const collaborators = collaboratorFiles(file, source);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      let carriesSecret = SECRET_RETURN_RE.test(line);
      if (!carriesSecret) {
        const delegated = /\breturn\s+(?:await\s+)?this\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\(/.exec(line);
        const target = delegated ? collaborators.get(delegated[1]) : undefined;
        if (target !== undefined && methodReturnsSecret(readSource(target), delegated[2] ?? "")) carriesSecret = true;
      }
      if (!carriesSecret) continue;
      const window = memberWindow(lines, i);
      if (!ROUTE_DECORATOR_RE.test(window)) continue;
      found.push({ file, line: i + 1, optedOut: OPT_OUT_RE.test(window) });
    }
  }
  return found;
}

const RECOMMENDED_ADDITION = `
  // Add before app.listen():
  import compression from 'compression';
  // ...
  app.use(compression({ level: 6 }));  // gzip level 6 is a good default
  // For Brotli (Node 18+):
  // const { brotliCompress } = await import('node:zlib');
  // app.use(require('shrink-ray-current')());
`.trim();

if (SELF_TEST) {
  process.stdout.write("Running self-test...\n");
  let failed = false;

  const pass = (label) => process.stdout.write(`  [pass] ${label}\n`);
  const fail = (label, detail) => {
    process.stderr.write(`  [FAIL] ${label}: ${detail}\n`);
    failed = true;
  };

  if (!detectCompression("app.use(compression())"))
    fail("compression-call-detected", "expected detectCompression to find app.use(compression())");
  else pass("compression-call-detected — app.use(compression()) pattern is detected");

  if (!detectCompression("import { CompressionMiddleware } from '@nestjs/compression'"))
    fail("compression-import-detected", "expected detectCompression to find @nestjs/compression import");
  else pass("compression-import-detected — @nestjs/compression import is detected");

  if (detectCompression("const x = 'no compression here'"))
    fail("no-compression-not-detected", "expected detectCompression to return false for unrelated source");
  else pass("no-compression-not-detected — unrelated source correctly returns false");

  const binaryProducers = detectBinaryProducers('@ApiProduces("image/png") get() {}');
  if (binaryProducers.length !== 1 || binaryProducers[0] !== "image/png")
    fail("binary-producer-detected", `expected ['image/png'], got ${JSON.stringify(binaryProducers)}`);
  else pass("binary-producer-detected — image/png @ApiProduces is detected");

  const nonBinary = detectBinaryProducers('@ApiProduces("application/json") get() {}');
  if (nonBinary.length !== 0)
    fail("non-binary-not-flagged", `expected 0 binary producers for JSON, got ${nonBinary.length}`);
  else pass("non-binary-not-flagged — application/json is not a binary producer");

  const declaredOk = `
    export const NO_COMPRESSION_HEADER = "x-no-compression";
    export const ALREADY_COMPRESSED = ["image/", "video/", "application/pdf", "application/zip"];
    export const COMPRESSION_THRESHOLD_BYTES = 1024;
    const q = { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 };
    export function shouldCompress(_req, res) { return !/no-transform/.test(res); }
  `;
  if (missingCompressionDeclarations(declaredOk).length !== 0)
    fail("declarations-complete", `a fully declared config must report nothing missing, got ${JSON.stringify(missingCompressionDeclarations(declaredOk))}`);
  else pass("declarations-complete — a config stating all four properties reports nothing missing");

  const declaredThresholdRaised = declaredOk.replace("= 1024", "= 1");
  if (missingCompressionDeclarations(declaredThresholdRaised).length === 0)
    fail("declarations-bite", "changing the threshold away from 1024 must be reported");
  else pass("declarations-bite — a config that stops stating the 1024 threshold is reported");

  const declaredNoPdf = declaredOk.replace('"application/pdf", ', "");
  if (!missingCompressionDeclarations(declaredNoPdf).some((m) => m.startsWith("application/pdf")))
    fail("pdf-exclusion-bite", "dropping application/pdf from the exclusion list must be reported");
  else pass("pdf-exclusion-bite — dropping application/pdf from the exclusions is reported");

  if (!wiresDeclaredOptions("app.use(compression(httpCompressionOptions()));"))
    fail("wiring-detected", "the declared wiring must be detected");
  else pass("wiring-detected — app.use(compression(httpCompressionOptions())) is detected");

  if (wiresDeclaredOptions("app.use(compression());"))
    fail("bare-wiring-rejected", "a bare compression() must NOT count as declared options");
  else pass("bare-wiring-rejected — a bare compression() does not count as declared options");

  /* The BREACH adoption check, over synthetic controllers. */
  const exposedCtl = [
    '@Controller("x")',
    "export class XController {",
    '  @Post("token")',
    "  mint() {",
    "    return { token };",
    "  }",
    "}",
  ].join("\n");
  const guardedCtl = exposedCtl.replace('  @Post("token")', '  @Post("token")\n  @Header(NO_COMPRESSION_HEADER, "1")');
  const fakeRead = (f) => (f === "/exposed.ts" ? exposedCtl : guardedCtl);

  const exposedFound = findSecretBodyHandlers(["/exposed.ts"], fakeRead);
  if (exposedFound.length !== 1 || exposedFound[0].optedOut !== false)
    fail("secret-body-bites", `an un-opted-out token response must be found and flagged, got ${JSON.stringify(exposedFound)}`);
  else pass("secret-body-bites — a token response with no opt-out is found and flagged");

  const guardedFound = findSecretBodyHandlers(["/guarded.ts"], fakeRead);
  if (guardedFound.length !== 1 || guardedFound[0].optedOut !== true)
    fail("secret-body-optout-recognised", `an opted-out token response must be found and cleared, got ${JSON.stringify(guardedFound)}`);
  else pass("secret-body-optout-recognised — the same response with @Header(NO_COMPRESSION_HEADER) is cleared");

  const plainCtl = exposedCtl.replace("return { token };", "return { items };");
  if (findSecretBodyHandlers(["/plain.ts"], () => plainCtl).length !== 0)
    fail("non-secret-not-flagged", "a body with no credential field must not be flagged");
  else pass("non-secret-not-flagged — a body with no credential field is not flagged");

  if (memberWindow(["  }", '  @Post("x")', "  h() {", "    return { token };"], 3).includes("@Post"))
    pass("member-window — the handler's own decorator block is the window, not the file");
  else fail("member-window", "the window must reach back to the handler's decorators");

  if (failed) {
    process.stderr.write("\nSELF-TEST FAILED\n");
    process.exit(1);
  }
  process.stdout.write("\nSELF-TEST PASSED\n");
  process.exit(0);
}

if (!existsSync(MAIN_TS_PATH)) {
  process.stderr.write(`check-compression: main.ts not found at ${MAIN_TS_PATH}\n`);
  process.exit(2);
}

const mainSource = readFileSync(MAIN_TS_PATH, "utf8");
const appModuleSource = existsSync(APP_MODULE_PATH) ? readFileSync(APP_MODULE_PATH, "utf8") : "";
const combinedSource = mainSource + "\n" + appModuleSource;

const compressionFound = detectCompression(combinedSource);
const binaryProducers = detectBinaryProducers(mainSource);
const reflectionRisks = detectReflectionRisk(mainSource);

process.stdout.write(`check-compression: HTTP response compression analysis\n`);

if (compressionFound) {
  process.stdout.write(`  compression: OK — compression middleware detected in main.ts or app.module.ts\n`);
} else {
  process.stderr.write(
    `  compression: MISSING — no compression middleware found in main.ts or app.module.ts\n` +
    `  Compression reduces JSON/text payload sizes by 60–80%. Brotli/gzip should be enabled\n` +
    `  for all responses except already-compressed binaries and streaming endpoints.\n\n` +
    `  WHAT TO ADD (do not edit main.ts if another agent owns it; check first):\n` +
    `${RECOMMENDED_ADDITION}\n\n` +
    `  Eligibility: JSON/text/OpenAPI/static responses above ~1KB. Exclude:\n` +
    `    - Pre-compressed assets (image/*, video/*, application/zip)\n` +
    `    - Cross-origin credential reflections (BREACH/CRIME)\n` +
    `    - SSE/WebSocket streaming handlers\n`,
  );
}

/* --- 4. the four declared properties, and main.ts wiring them --- */
let declarationFailures = 0;
if (!existsSync(COMPRESSION_CONFIG_PATH)) {
  process.stderr.write(`  options: MISSING — ${COMPRESSION_CONFIG_PATH} not found; the four PRD-C089 properties are undeclared\n`);
  process.exit(2);
}
const configSource = readFileSync(COMPRESSION_CONFIG_PATH, "utf8");
const missingDeclarations = missingCompressionDeclarations(configSource);
if (missingDeclarations.length > 0) {
  declarationFailures += missingDeclarations.length;
  process.stderr.write(
    `  options: UNDECLARED (${String(missingDeclarations.length)}) — compression.config.ts must state each of these, not inherit it:\n` +
    missingDeclarations.map((m) => `    ${m}`).join("\n") + "\n",
  );
} else {
  process.stdout.write(
    `  options: OK — threshold, Brotli quality, opt-out header, exported filter and ${String(REQUIRED_ALREADY_COMPRESSED.length)} named exclusions are all declared\n`,
  );
}
if (!wiresDeclaredOptions(mainSource)) {
  declarationFailures += 1;
  process.stderr.write(
    `  wiring: NOT DECLARED — main.ts must call app.use(compression(httpCompressionOptions())).\n` +
    `  A bare compression() takes the library's defaults, which is what this gate used to pass over.\n`,
  );
} else {
  process.stdout.write(`  wiring: OK — main.ts passes httpCompressionOptions() rather than a bare compression()\n`);
}

/* --- 5. no credential body is left compressible --- */
const sourceCache = new Map();
const readCached = (file) => {
  if (!sourceCache.has(file)) sourceCache.set(file, readFileSync(file, "utf8"));
  return sourceCache.get(file);
};
const secretHandlers = findSecretBodyHandlers(collectSources(SRC_ROOT), readCached);
const exposed = secretHandlers.filter((h) => !h.optedOut);
if (secretHandlers.length === 0) {
  declarationFailures += 1;
  process.stderr.write(
    `  secret bodies: VACUOUS — the scan found no credential-carrying handler at all.\n` +
    `  This repository mints a stream token, a session token and an API key; finding none means\n` +
    `  the detector is broken, and a broken detector reports clean.\n`,
  );
} else if (exposed.length > 0) {
  declarationFailures += exposed.length;
  process.stderr.write(
    `  secret bodies: BREACH (${String(exposed.length)} of ${String(secretHandlers.length)}) — a credential in a compressible body,\n` +
    `  with app.enableCors({ credentials: true }) live, is a cross-origin size oracle. Add\n` +
    `  @Header(NO_COMPRESSION_HEADER, "1") to each:\n` +
    exposed.map((h) => `    ${h.file.slice(BACKEND_ROOT.length + 1)}:${String(h.line)}`).join("\n") + "\n",
  );
} else {
  process.stdout.write(
    `  secret bodies: OK — all ${String(secretHandlers.length)} credential-carrying handler(s) declare a compression opt-out\n`,
  );
}

if (binaryProducers.length > 0) {
  process.stdout.write(
    `  BINARY PRODUCERS (${String(binaryProducers.length)}) — verify compression is excluded for these types:\n` +
    binaryProducers.map((t) => `    ${t}`).join("\n") + "\n",
  );
}

if (reflectionRisks.length > 0) {
  process.stdout.write(
    `  REFLECTION RISK (${String(reflectionRisks.length)} potential candidate(s)) — review these handlers for BREACH/CRIME exposure:\n` +
    reflectionRisks.map((r) => `    ${r.excerpt}`).join("\n") + "\n",
  );
}

if (!compressionFound || declarationFailures > 0) {
  process.exit(1);
}

process.exit(0);
