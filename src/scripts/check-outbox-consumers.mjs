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

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC_ROOT = resolve(__dirname, "..");

const MIN_FILES = 500;
const MIN_EMITTED = 5;
const MIN_CONSUMED = 5;

const CONST_RE = /\bconst\s+([A-Z][A-Z0-9_]+)\s*=\s*(["'][^"']+["'])/gm;
const EMIT_RE = /OutboxWriter\.emit\s*\(/g;
const CONSUMER_RE = /\breadonly\s+eventType\s*=\s*(["'][^"']+["']|[A-Z][A-Z0-9_]+)/g;
const INLINE_RE = /\bregistry\.register\s*\(/g;
const EVENT_TYPE_PROP = /\beventType\s*:\s*(["'][^"']+["']|[A-Z][A-Z0-9_]+)/;

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

function resolveValue(raw, constMap) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed.slice(1, -1);
  return constMap.get(trimmed) ?? null;
}

/**
 * The whole detector, over a path → source map. The gate and the self-test both
 * call this. The previous self-test filtered two hand-built arrays and re-declared
 * the inline-registration regex locally, so it asserted a copy of the rule; the
 * real emit/consumer scanners could break without the self-test noticing.
 */
export function analyseSources(sourceByFile) {
  const constMap = new Map();
  for (const src of sourceByFile.values()) {
    for (const m of src.matchAll(CONST_RE)) {
      const name = m[1];
      if (!constMap.has(name)) constMap.set(name, m[2].slice(1, -1));
    }
  }

  const emittedByFile = new Map();
  const consumedByFile = new Map();

  const add = (map, filePath, value) => {
    const entry = map.get(filePath) ?? new Set();
    entry.add(value);
    map.set(filePath, entry);
  };

  for (const [filePath, src] of sourceByFile) {
    EMIT_RE.lastIndex = 0;
    let match;
    while ((match = EMIT_RE.exec(src)) !== null) {
      const typeMatch = EVENT_TYPE_PROP.exec(src.slice(match.index, match.index + 600));
      if (!typeMatch) continue;
      const resolved = resolveValue(typeMatch[1], constMap);
      if (resolved) add(emittedByFile, filePath, resolved);
    }

    CONSUMER_RE.lastIndex = 0;
    while ((match = CONSUMER_RE.exec(src)) !== null) {
      const resolved = resolveValue(match[1], constMap);
      if (resolved) add(consumedByFile, filePath, resolved);
    }

    INLINE_RE.lastIndex = 0;
    while ((match = INLINE_RE.exec(src)) !== null) {
      const typeMatch = EVENT_TYPE_PROP.exec(src.slice(match.index, match.index + 400));
      if (!typeMatch) continue;
      const resolved = resolveValue(typeMatch[1], constMap);
      if (resolved) add(consumedByFile, filePath, resolved);
    }
  }

  const allEmitted = new Set([...emittedByFile.values()].flatMap((s) => [...s]));
  const allConsumed = new Set([...consumedByFile.values()].flatMap((s) => [...s]));
  const orphans = [...allEmitted].filter((t) => !allConsumed.has(t));

  return { allEmitted, allConsumed, orphans, emittedByFile, consumedByFile, constMap };
}

function runSelfTest() {
  let passed = 0;
  const failures = [];
  const assert = (label, condition) => {
    if (condition) passed++;
    else failures.push(label);
  };

  const emitter = `
    const REMINDER_DUE = "accounting.invoice.reminder.due";
    export class Svc {
      async run(tx) {
        await OutboxWriter.emit(tx, { eventType: "test.event.orphaned", payload: {} });
        await OutboxWriter.emit(tx, { eventType: REMINDER_DUE, payload: {} });
        await OutboxWriter.emit(tx, { eventType: "test.event.inline-consumed", payload: {} });
        await OutboxWriter.emit(tx, { eventType: COMPUTED_AT_RUNTIME, payload: {} });
      }
    }
  `;
  const consumer = `
    export class ReminderConsumer {
      readonly eventType = "accounting.invoice.reminder.due";
      handle() {}
    }
  `;
  const inlineConsumer = `
    onModuleInit() {
      this.registry.register(this);
      this.registry.register({ eventType: "test.event.inline-consumed", handle: (e) => this.handle(e) });
    }
  `;

  const sources = new Map([
    ["src/a/emitter.service.ts", emitter],
    ["src/b/consumer.ts", consumer],
    ["src/c/inline.ts", inlineConsumer],
  ]);
  const result = analyseSources(sources);

  assert("a known-orphan emitted type is rejected", result.orphans.includes("test.event.orphaned"));
  assert("exactly the one orphan is reported", result.orphans.length === 1);
  assert("a literal emission is detected", result.allEmitted.has("test.event.orphaned"));
  assert(
    "an emission through a module const is resolved, not dropped",
    result.allEmitted.has("accounting.invoice.reminder.due"),
  );
  assert(
    "a readonly eventType consumer clears its emission",
    !result.orphans.includes("accounting.invoice.reminder.due"),
  );
  assert(
    "an inline registry.register({ eventType }) also clears its emission",
    !result.orphans.includes("test.event.inline-consumed"),
  );
  assert("the inline registration is counted as consumed", result.allConsumed.has("test.event.inline-consumed"));
  assert("registry.register(this) alone adds nothing", result.allConsumed.size === 2);
  assert(
    "an unresolvable eventType identifier is dropped rather than reported as an orphan",
    !result.orphans.includes("COMPUTED_AT_RUNTIME"),
  );
  assert("the const map picked up the module const", result.constMap.get("REMINDER_DUE") === "accounting.invoice.reminder.due");
  assert(
    "the orphan is attributed to the file that emitted it",
    [...result.emittedByFile.get("src/a/emitter.service.ts")].includes("test.event.orphaned"),
  );

  // A consumer declared in a file scanned before the const's declaring file must
  // still resolve — the two-pass const map is the whole reason for that ordering.
  const reordered = new Map([
    ["src/b/consumer-const.ts", 'export class C { readonly eventType = LATE_CONST; }'],
    ["src/a/emitter-const.ts", 'const LATE_CONST = "late.declared.type";\nOutboxWriter.emit(tx, { eventType: LATE_CONST });'],
  ]);
  assert(
    "a consumer using a const declared in a later-scanned file is not an orphan",
    analyseSources(reordered).orphans.length === 0,
  );

  const empty = analyseSources(new Map());
  assert("an empty corpus yields no findings", empty.orphans.length === 0);
  assert("an empty corpus would trip the vacuity floor", isVacuous(0, empty.allEmitted.size, empty.allConsumed.size));
  assert(
    "a real-sized scan does not trip the vacuity floor",
    !isVacuous(MIN_FILES, MIN_EMITTED, MIN_CONSUMED),
  );

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`check-outbox-consumers self-tests: ${failures.length} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-outbox-consumers self-tests: ${passed} passed`);
  process.exit(0);
}

function isVacuous(fileCount, emittedCount, consumedCount) {
  return fileCount < MIN_FILES || emittedCount < MIN_EMITTED || consumedCount < MIN_CONSUMED;
}

if (SELF_TEST) runSelfTest();

const allFiles = collectTsFiles(SRC_ROOT);
const sourceByFile = new Map(allFiles.map((f) => [f, readFileSync(f, "utf8")]));
const { allEmitted, allConsumed, orphans, emittedByFile } = analyseSources(sourceByFile);

console.log(`Scanned ${allFiles.length} TypeScript files`);
console.log(`Emitted event types  (${allEmitted.size}): ${[...allEmitted].join(", ") || "(none)"}`);
console.log(`Consumed event types (${allConsumed.size}): ${[...allConsumed].join(", ") || "(none)"}`);

if (isVacuous(allFiles.length, allEmitted.size, allConsumed.size)) {
  console.error(
    `\nINCONCLUSIVE — scanned ${allFiles.length} files (floor ${MIN_FILES}) finding ${allEmitted.size} emitted (floor ${MIN_EMITTED}) and ${allConsumed.size} consumed (floor ${MIN_CONSUMED}) event types. "No orphans" over an empty scan proves nothing.`,
  );
  process.exit(2);
}

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
