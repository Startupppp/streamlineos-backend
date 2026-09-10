#!/usr/bin/env node
/**
 * Verifies that every outbox event type emitted via OutboxWriter.emit() has a
 * registered consumer.
 *
 * An orphaned emitted type is not ignored by the publisher. `OutboxPublisher.deliver`
 * throws when `registry.getAll(eventType)` is empty, so the event burns its retry
 * budget and dead-letters — in a background worker, on somebody else's shift.
 *
 * ## Why this file grew a small expression reader
 *
 * The scan used to recognise exactly two shapes: `readonly eventType = "literal"`
 * on a consumer class, and `registry.register({ eventType: "literal" })`. That
 * missed the shape inventory actually uses — one consumer registering a *table*
 * of routes:
 *
 *     for (const [eventType, webhookType] of Object.entries(INVENTORY_WEBHOOK_ROUTES)) {
 *       this.registry.register({ eventType, handle: (e) => this.deliver(e, webhookType) });
 *     }
 *
 * The property is shorthand, so no literal ever appears beside `eventType:`, and
 * the check reported six live, consumed, webhook-delivering event types as
 * orphans. A gate that cannot read the codebase's own registration idiom does not
 * report "no consumer", it reports "I did not recognise the consumer" — and the
 * two are indistinguishable to whoever reads the output. Both sides now resolve
 * `MAP.PROP` references and `Object.entries(MAP)` registrations against the real
 * constant tables.
 *
 * Detection stays deliberately conservative: an expression this reader cannot
 * resolve contributes nothing to *either* side, so an unreadable emit is dropped
 * rather than reported as an orphan, and an unreadable registration never
 * launders an event type into the consumed set.
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
// Source reading primitives
// ---------------------------------------------------------------------------

/**
 * An event type as this system spells one: dot-separated lowercase segments
 * (`inventory.stock.low`, `billing.revenue-event`).
 *
 * Only used to sieve the references found inside a *compound* expression — a
 * ternary's condition (`input.kind === "EINVOICE" ? A : B`) puts a string
 * literal in reach that is emphatically not an event type. A lone literal or a
 * lone constant reference is taken at its word, exactly as before.
 */
const EVENT_TYPE_SHAPE = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/;

/**
 * Remove `//` and `/* *\/` comments, preserving string contents.
 *
 * Applied only to an already-delimited object body, never to a whole file: a
 * naive string scanner mistakes the quote characters inside a regex literal
 * (`/["']/`) for a string, and this codebase is full of them. Event tables
 * contain no regex literals, so the narrow application is safe and the wide one
 * would not be.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\") j++;
        j++;
      }
      out += src.slice(i, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      out += "\n";
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? src.length : close + 2;
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** The body of the `{ … }` whose opening brace is at `openIdx`, braces balanced. */
function readBracedBody(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? src.length : close + 2;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
    i++;
  }
  return null;
}

/**
 * The text inside the balanced parentheses whose `(` is at `openIdx`.
 *
 * A fixed-width character window is not good enough here: 400 characters after
 * `registry.register(` runs past the end of the call and into the *next* one, so
 * a shorthand registration reads the following call's `eventType: …` and
 * silently resolves to the wrong event. The self-test caught exactly that.
 */
function readParenArgs(src, openIdx, limit = 4000) {
  const end = Math.min(src.length, openIdx + limit);
  let depth = 0;
  let i = openIdx;
  while (i < end) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? src.length : close + 2;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
    i++;
  }
  return null;
}

/**
 * The value expression of a property, starting just after its `:`.
 *
 * Stops at the `,` or `}` that closes the property at depth zero, so a ternary
 * spanning three lines comes back whole — `india-compliance.service.ts` writes
 * exactly that, and reading only to end-of-line would see the condition and
 * neither branch.
 */
function readValueExpression(src, from, limit = 600) {
  const end = Math.min(src.length, from + limit);
  let depth = 0;
  let i = from;
  let out = "";
  while (i < end) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\") j++;
        j++;
      }
      out += src.slice(i, Math.min(j + 1, src.length));
      i = j + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? src.length : close + 2;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      out += ch;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
      out += ch;
      i++;
      continue;
    }
    if (ch === "," && depth === 0) break;
    out += ch;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constant resolution
// ---------------------------------------------------------------------------

const CONST_RE = /\bconst\s+([A-Z][A-Z0-9_]+)\s*=\s*(["'][^"']+["'])/gm;
const CONST_OBJECT_RE = /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]{0,200})?=\s*\{/g;

/**
 * Every `const NAME = "value"` and `const NAME = { … }` in the tree.
 *
 * Collected across ALL files before anything is resolved: a consumer whose
 * eventType is an imported const is otherwise dropped when its file happens to
 * be scanned before the file declaring it, which reports a consumed event as an
 * orphan.
 */
function collectConstants(sources) {
  /** Identifier → string literal value. */
  const constMap = new Map();
  /** Identifier → { props: Map<propName, value>, keys: Set<quoted key> }. */
  const objectMaps = new Map();

  for (const src of sources.values()) {
    for (const m of src.matchAll(CONST_RE)) {
      if (!constMap.has(m[1])) constMap.set(m[1], m[2].slice(1, -1));
    }

    for (const m of src.matchAll(CONST_OBJECT_RE)) {
      const name = m[1];
      if (objectMaps.has(name)) continue;
      const openIdx = src.indexOf("{", m.index + m[0].length - 1);
      if (openIdx === -1) continue;
      const rawBody = readBracedBody(src, openIdx);
      if (rawBody === null) continue;
      const body = stripComments(rawBody);

      const props = new Map();
      for (const p of body.matchAll(/(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:\s*(["'])([^"']*)\2/g)) {
        if (!props.has(p[1])) props.set(p[1], p[3]);
      }

      const keys = new Set();
      for (const k of body.matchAll(/(?:^|[{,\s])(["'])([^"']+)\1\s*:/g)) {
        keys.add(k[2]);
      }

      objectMaps.set(name, { props, keys });
    }
  }

  return { constMap, objectMaps };
}

/**
 * Every event type an expression can name.
 *
 * Simple shapes — a lone literal, a lone constant, a lone `MAP.PROP` — resolve
 * exactly. Anything compound is scanned for references and sieved through
 * `EVENT_TYPE_SHAPE`, which is how the two branches of a ternary are both
 * counted without also counting the condition's string literal.
 */
function resolveEventTypes(expression, constMap, objectMaps) {
  const expr = expression.trim();
  if (expr === "") return [];

  const literal = /^(["'`])([^"'`]+)\1$/.exec(expr);
  if (literal) return [literal[2]];

  if (/^[A-Z][A-Z0-9_]+$/.test(expr)) {
    const value = constMap.get(expr);
    return value ? [value] : [];
  }

  const member = /^([A-Z][A-Z0-9_]*)\s*\.\s*([A-Za-z_$][\w$]*)$/.exec(expr);
  if (member) {
    const value = objectMaps.get(member[1])?.props.get(member[2]);
    return value ? [value] : [];
  }

  const found = new Set();
  const references =
    /(["'`])([^"'`]+)\1|\b([A-Z][A-Z0-9_]*)\s*\.\s*([A-Za-z_$][\w$]*)|\b([A-Z][A-Z0-9_]+)\b/g;
  for (const m of expr.matchAll(references)) {
    let value = null;
    if (m[2] !== undefined) value = m[2];
    else if (m[3] !== undefined) value = objectMaps.get(m[3])?.props.get(m[4]) ?? null;
    else if (m[5] !== undefined) value = constMap.get(m[5]) ?? null;
    if (value && EVENT_TYPE_SHAPE.test(value)) found.add(value);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Per-file scan
// ---------------------------------------------------------------------------

const EMIT_RE = /OutboxWriter\.emit\s*\(/g;
const REGISTER_RE = /\bregistry\.register\s*\(/g;
const CLASS_EVENT_TYPE_RE = /\breadonly\s+eventType\s*=\s*([^;\n]+)/g;
const OBJECT_ENTRIES_RE = /Object\.entries\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;

/** `{ eventType, …` or `{ eventType }` — the ES shorthand, with no value beside it. */
const SHORTHAND_EVENT_TYPE_RE = /\beventType\s*[,}]/;

function scanSource(src, constMap, objectMaps) {
  const emitted = new Set();
  const consumed = new Set();

  /** The `eventType:` value inside one call's own argument list, or null. */
  const eventTypeValue = (args) => {
    const key = /\beventType\s*:/.exec(args);
    if (!key) return null;
    return readValueExpression(args, key.index + key[0].length);
  };

  /** The arguments of the call whose `(` closes `match[0]`. */
  const argsOf = (src_, match) => readParenArgs(src_, match.index + match[0].length - 1);

  // OutboxWriter.emit(tx, { …, eventType: <expression>, … })
  for (const match of src.matchAll(EMIT_RE)) {
    const args = argsOf(src, match);
    if (args === null) continue;
    const expression = eventTypeValue(args);
    if (expression === null) continue;
    for (const type of resolveEventTypes(expression, constMap, objectMaps)) emitted.add(type);
  }

  // class Consumer { readonly eventType = <expression> }
  for (const match of src.matchAll(CLASS_EVENT_TYPE_RE)) {
    for (const type of resolveEventTypes(match[1], constMap, objectMaps)) consumed.add(type);
  }

  // registry.register({ eventType: <expression>, handle })
  // registry.register({ eventType, handle }) inside a for-of over Object.entries(MAP)
  for (const match of src.matchAll(REGISTER_RE)) {
    const args = argsOf(src, match);
    if (args === null) continue;
    const expression = eventTypeValue(args);
    if (expression !== null && expression.trim() !== "") {
      for (const type of resolveEventTypes(expression, constMap, objectMaps)) consumed.add(type);
      continue;
    }
    if (!SHORTHAND_EVENT_TYPE_RE.test(args)) continue;

    // The shorthand carries no name of its own, so the table it iterates is the
    // only place the event types are written down. Nearest preceding
    // `Object.entries(MAP)` wins; an unresolvable one contributes nothing, which
    // leaves the emitted types orphaned rather than silently absolved.
    const lookback = src.slice(Math.max(0, match.index - 500), match.index);
    let table = null;
    for (const entries of lookback.matchAll(OBJECT_ENTRIES_RE)) table = entries[1];
    if (!table) continue;
    const keys = objectMaps.get(table)?.keys;
    if (!keys) continue;
    for (const key of keys) consumed.add(key);
  }

  return { emitted, consumed };
}

// ---------------------------------------------------------------------------
// Self-test — runs the real scanner over synthetic sources
// ---------------------------------------------------------------------------

function selfTest() {
  const fail = (message, detail) => {
    console.error(`SELF-TEST FAILED: ${message}`);
    if (detail !== undefined) console.error("Got:", detail);
    process.exit(1);
  };

  const scanAll = (sources) => {
    const { constMap, objectMaps } = collectConstants(sources);
    const emitted = new Set();
    const consumed = new Set();
    for (const src of sources.values()) {
      const result = scanSource(src, constMap, objectMaps);
      for (const t of result.emitted) emitted.add(t);
      for (const t of result.consumed) consumed.add(t);
    }
    return { emitted, consumed, orphans: [...emitted].filter((t) => !consumed.has(t)) };
  };

  // 1. An emitted type with no consumer anywhere is an orphan; a consumed one is not.
  {
    const sources = new Map([
      [
        "a.ts",
        `await OutboxWriter.emit(tx, { eventId: id, eventType: "test.event.orphaned", payload: {} });
         await OutboxWriter.emit(tx, { eventId: id, eventType: "accounting.invoice.reminder.due", payload: {} });`,
      ],
      ["b.ts", `class C { readonly eventType = "accounting.invoice.reminder.due"; }`],
    ]);
    const { orphans } = scanAll(sources);
    if (orphans.length !== 1 || orphans[0] !== "test.event.orphaned") {
      fail("expected exactly 1 violation for test.event.orphaned", orphans);
    }
    console.log("SELF-TEST PASSED: orphan detection correctly identified 1 violation");
  }

  // 2. Inline object-literal registration.
  {
    const sources = new Map([
      [
        "a.ts",
        `onModuleInit() {
           this.registry.register(this);
           this.registry.register({ eventType: "test.inline.alpha", handle: (e) => this.handle(e) });
           this.registry.register({ eventType: "test.inline.beta", handle: (e) => this.handle(e) });
         }`,
      ],
    ]);
    const { consumed } = scanAll(sources);
    if (!consumed.has("test.inline.alpha") || !consumed.has("test.inline.beta") || consumed.size !== 2) {
      fail("inline registry.register({ eventType }) detection is wrong", [...consumed]);
    }
    console.log("SELF-TEST PASSED: inline registry.register({ eventType }) detection works");
  }

  // 3. The shape that made six live event types read as orphans: a table of
  //    routes registered through the ES shorthand, and constants emitted through
  //    a member expression and a ternary.
  {
    const table = `
      const TEST_ROUTES = {
        // A comment naming "test.table.decoy": null must not become a route.
        "test.table.routed": "subscriber.name",
        "test.table.silent": null,
      };
      const TEST_EVENTS = {
        ALPHA: "test.member.alpha",
        BETA: "test.member.beta",
      };
    `;
    const sources = new Map([
      ["routes.ts", table],
      [
        "consumer.ts",
        `onModuleInit() {
           for (const [eventType, webhookType] of Object.entries(TEST_ROUTES)) {
             this.registry.register({
               eventType,
               handle: (event) => this.deliver(event, webhookType),
             });
           }
           this.registry.register({ eventType: TEST_EVENTS.ALPHA, handle: (e) => this.handle(e) });
           this.registry.register({ eventType: TEST_EVENTS.BETA, handle: (e) => this.handle(e) });
         }`,
      ],
      [
        "emitter.ts",
        `await OutboxWriter.emit(tx, { eventId: id, eventType: "test.table.routed", payload: {} });
         await OutboxWriter.emit(tx, { eventId: id, eventType: "test.table.silent", payload: {} });
         await OutboxWriter.emit(tx, { eventId: id, eventType: TEST_EVENTS.ALPHA, payload: {} });
         await OutboxWriter.emit(tx, {
           eventId: id,
           eventType:
             input.kind === "EINVOICE"
               ? TEST_EVENTS.ALPHA
               : TEST_EVENTS.BETA,
           payload: {},
         });`,
      ],
    ]);
    const { emitted, consumed, orphans } = scanAll(sources);
    if (orphans.length !== 0) fail("table-driven registration was not recognised", orphans);
    if (!consumed.has("test.table.routed") || !consumed.has("test.table.silent")) {
      fail("Object.entries(MAP) registration missed a route key", [...consumed]);
    }
    if (consumed.has("test.table.decoy")) {
      fail("a commented-out route in the table was read as registered", [...consumed]);
    }
    if (!emitted.has("test.member.beta")) {
      fail("the far branch of a ternary eventType was not resolved", [...emitted]);
    }
    if (emitted.has("EINVOICE")) {
      fail("a string literal from a ternary condition was read as an event type", [...emitted]);
    }
    console.log("SELF-TEST PASSED: Object.entries(MAP) registration and MAP.PROP emits resolve");
  }

  // 4. The gate must still bite. Drop one key from the table and the event it
  //    routed has to come back as an orphan — a check that only ever passes is
  //    not a check.
  {
    const sources = new Map([
      ["routes.ts", `const TEST_ROUTES = { "test.table.routed": "subscriber.name" };`],
      [
        "consumer.ts",
        `for (const [eventType, webhookType] of Object.entries(TEST_ROUTES)) {
           this.registry.register({ eventType, handle: (e) => this.deliver(e, webhookType) });
         }`,
      ],
      [
        "emitter.ts",
        `await OutboxWriter.emit(tx, { eventId: id, eventType: "test.table.routed", payload: {} });
         await OutboxWriter.emit(tx, { eventId: id, eventType: "test.table.withdrawn", payload: {} });`,
      ],
    ]);
    const { orphans } = scanAll(sources);
    if (orphans.length !== 1 || orphans[0] !== "test.table.withdrawn") {
      fail("a type missing from the route table must still be reported", orphans);
    }
    console.log("SELF-TEST PASSED: a type missing from the route table is still an orphan");
  }

  process.exit(0);
}

if (SELF_TEST) selfTest();

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

const allFiles = collectTsFiles(SRC_ROOT);

const sourceByFile = new Map();
for (const filePath of allFiles) sourceByFile.set(filePath, readFileSync(filePath, "utf8"));

// Pass 1 — every constant in the tree, before anything is resolved against them.
const { constMap, objectMaps } = collectConstants(sourceByFile);

/** Emitted event types: file path → Set<string>. */
const emittedByFile = new Map();
/** Consumed event types: file path → Set<string>. */
const consumedByFile = new Map();

// Pass 2 — resolve emissions and registrations against the complete constant map.
for (const [filePath, src] of sourceByFile) {
  const { emitted, consumed } = scanSource(src, constMap, objectMaps);
  if (emitted.size > 0) emittedByFile.set(filePath, emitted);
  if (consumed.size > 0) consumedByFile.set(filePath, consumed);
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
