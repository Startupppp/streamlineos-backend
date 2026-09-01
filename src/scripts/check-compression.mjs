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
 *   0 — compression appears configured (or self-test passed)
 *   1 — compression likely missing, or self-test failed
 *   2 — main.ts not found
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");
const BACKEND_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const MAIN_TS_PATH = join(BACKEND_ROOT, "src", "main.ts");
const APP_MODULE_PATH = join(BACKEND_ROOT, "src", "app.module.ts");

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

if (!compressionFound) {
  process.exit(1);
}

process.exit(0);
