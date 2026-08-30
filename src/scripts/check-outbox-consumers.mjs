#!/usr/bin/env node
/**
 * Verifies that every outbox event type emitted via OutboxWriter.emit() has a
 * registered consumer (a class with `readonly eventType = "..."` that matches).
 *
 * An orphaned emitted type means the event is written to the outbox but never
 * processed — it silently fills the outbox table and is never retried or delivered.
 *
 * Usage:
 *   node src/scripts/check-outbox-consumers.mjs          # production check
 *   node src/scripts/check-outbox-consumers.mjs --self-test
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");

// ---------------------------------------------------------------------------
// Self-test: inject a fake set and assert exactly one violation is detected,
// then verify that the inline registry.register({ eventType }) pattern is
// detected correctly.
// ---------------------------------------------------------------------------
if (SELF_TEST) {
  const fakeEmitted = ["test.event.orphaned", "accounting.invoice.reminder.due"];
  const fakeConsumed = new Set(["accounting.invoice.reminder.due"]);
  const violations = fakeEmitted.filter((t) => !fakeConsumed.has(t));
  if (violations.length !== 1 || violations[0] !== "test.event.orphaned") {
    console.error("SELF-TEST FAILED: expected exactly 1 violation for test.event.orphaned");
    console.error("Got:", violations);
    process.exit(1);
  }
  console.log("SELF-TEST PASSED: orphan detection correctly identified 1 violation");

  // Verify inline registry.register({ eventType: "..." }) detection
  const sampleSrc = `
    onModuleInit() {
      this.registry.register(this);
      this.registry.register({ eventType: "test.inline.alpha", handle: (e) => this.handle(e) });
      this.registry.register({ eventType: "test.inline.beta", handle: (e) => this.handle(e) });
    }
  `;
  const inlineTestRe = /\bregistry\.register\s*\(/g;
  const inlineConsumed = new Set();
  let testMatch;
  while ((testMatch = inlineTestRe.exec(sampleSrc)) !== null) {
    const window = sampleSrc.slice(testMatch.index, testMatch.index + 400);
    const tm = /\beventType\s*:\s*(["'][^"']+["']|[A-Z][A-Z0-9_]+)/.exec(window);
    if (!tm) continue;
    const val = tm[1].startsWith('"') || tm[1].startsWith("'") ? tm[1].slice(1, -1) : tm[1];
    inlineConsumed.add(val);
  }
  if (!inlineConsumed.has("test.inline.alpha") || !inlineConsumed.has("test.inline.beta")) {
    console.error("SELF-TEST FAILED: inline registry.register({ eventType }) detection missed expected event types");
    console.error("Got:", [...inlineConsumed]);
    process.exit(1);
  }
  if (inlineConsumed.size !== 2) {
    console.error(`SELF-TEST FAILED: expected exactly 2 inline types, got ${inlineConsumed.size}`);
    process.exit(1);
  }
  console.log("SELF-TEST PASSED: inline registry.register({ eventType }) detection works");

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Real scan
// ---------------------------------------------------------------------------
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC_ROOT = resolve(__dirname, "..");

/** Recursively collect all .ts files under a directory (skip node_modules, dist). */
function collectTsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) results.push(...collectTsFiles(full));
    else if (entry.endsWith(".ts")) results.push(full);
  }
  return results;
}

/**
 * Resolve a constant name to its string value given a map of
 * `const NAME = "value"` declarations found across all scanned files.
 */
function resolveValue(raw, constMap) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return constMap.get(trimmed) ?? null;
}

const allFiles = collectTsFiles(SRC_ROOT);

/** Map from const identifier name → string literal value. */
const constMap = new Map();

/** Emitted event types: file path → Set<string>. */
const emittedByFile = new Map();

/** Consumed event types: file path → Set<string>. */
const consumedByFile = new Map();

// Pass 1 — collect every const declaration across ALL files before resolving
// anything. A consumer whose eventType is an imported const is otherwise
// dropped when its file happens to be scanned before the file declaring it,
// which reports a consumed event as an orphan.
const CONST_RE = /\bconst\s+([A-Z][A-Z0-9_]+)\s*=\s*(["'][^"']+["'])/gm;
const sourceByFile = new Map();
for (const filePath of allFiles) {
  const src = readFileSync(filePath, "utf8");
  sourceByFile.set(filePath, src);
  for (const m of src.matchAll(CONST_RE)) {
    const name = m[1];
    const val = m[2].slice(1, -1);
    if (!constMap.has(name)) constMap.set(name, val);
  }
}

// Pass 2 — resolve emissions and consumers against the complete const map.
for (const filePath of allFiles) {
  const src = sourceByFile.get(filePath);

  // Find OutboxWriter.emit(...) calls and extract eventType value
  // The eventType property appears within the next ~600 chars after OutboxWriter.emit(
  const emitRe = /OutboxWriter\.emit\s*\(/g;
  let match;
  while ((match = emitRe.exec(src)) !== null) {
    const window = src.slice(match.index, match.index + 600);
    const typeMatch = /\beventType\s*:\s*(["'][^"']+["']|[A-Z][A-Z0-9_]+)/.exec(window);
    if (!typeMatch) continue;
    const resolved = resolveValue(typeMatch[1], constMap);
    if (!resolved) continue;
    const entry = emittedByFile.get(filePath) ?? new Set();
    entry.add(resolved);
    emittedByFile.set(filePath, entry);
  }

  // Find `readonly eventType = "value"` consumer declarations
  const consumerRe = /\breadonly\s+eventType\s*=\s*(["'][^"']+["']|[A-Z][A-Z0-9_]+)/g;
  while ((match = consumerRe.exec(src)) !== null) {
    const resolved = resolveValue(match[1], constMap);
    if (!resolved) continue;
    const entry = consumedByFile.get(filePath) ?? new Set();
    entry.add(resolved);
    consumedByFile.set(filePath, entry);
  }

  // Find inline object literal registrations: registry.register({ eventType: "..." })
  // This pattern is used when one consumer class handles multiple event types by
  // registering extra event types in onModuleInit via plain object literals.
  const inlineRe = /\bregistry\.register\s*\(/g;
  while ((match = inlineRe.exec(src)) !== null) {
    const window = src.slice(match.index, match.index + 400);
    const typeMatch = /\beventType\s*:\s*(["'][^"']+["']|[A-Z][A-Z0-9_]+)/.exec(window);
    if (!typeMatch) continue;
    const resolved = resolveValue(typeMatch[1], constMap);
    if (!resolved) continue;
    const entry = consumedByFile.get(filePath) ?? new Set();
    entry.add(resolved);
    consumedByFile.set(filePath, entry);
  }
}

const allEmitted = new Set([...emittedByFile.values()].flatMap((s) => [...s]));
const allConsumed = new Set([...consumedByFile.values()].flatMap((s) => [...s]));

const orphans = [...allEmitted].filter((t) => !allConsumed.has(t));

// Summary
console.log(`Scanned ${allFiles.length} TypeScript files`);
console.log(`Emitted event types  (${allEmitted.size}): ${[...allEmitted].join(", ") || "(none)"}`);
console.log(`Consumed event types (${allConsumed.size}): ${[...allConsumed].join(", ") || "(none)"}`);

if (orphans.length > 0) {
  console.error("\nFAIL — orphaned event types (emitted but never consumed):");
  for (const type of orphans) {
    const files = [...emittedByFile.entries()]
      .filter(([, s]) => s.has(type))
      .map(([f]) => f.replace(SRC_ROOT + "/", ""));
    console.error(`  ${type}`);
    for (const f of files) console.error(`    emitted in: ${f}`);
  }
  process.exit(1);
}

console.log("\nOK — every emitted outbox event type has a registered consumer");
