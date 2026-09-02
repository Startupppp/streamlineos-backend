#!/usr/bin/env node
/**
 * Zero-growth ledger for forced typing in application code.
 *
 * Root CLAUDE.md §6 says never force a type. The measured reality at head is
 * that application code is already close to that: **zero `as any`, zero
 * `@ts-ignore`, zero `@ts-expect-error`, zero `@ts-nocheck`** anywhere under
 * `src/` outside the spec suite. What remains is 26 `as unknown as` sites, and
 * they are not all the same thing — roughly half are a genuine seam against
 * something outside the type system (a raw SQL row, a Drizzle client built by a
 * standalone script, an Express internal), and roughly half are a JSONB column
 * that should be parsed with Zod instead.
 *
 * Both halves are recorded below with the distinction stated, because a bare
 * count cannot tell them apart and a reviewer six months from now cannot either.
 *
 * The gate has two rules:
 *
 *  1. **Hard zero** for `as any`, `@ts-ignore`, `@ts-expect-error` and
 *     `@ts-nocheck` in application code. There is no ledger for these; the
 *     count is zero today and any reintroduction fails.
 *  2. **Zero growth** for `as unknown as`. Every file holding one is listed with
 *     its count, its seam and the invariant that makes the cast survivable. A
 *     new file, or an existing file gaining a site, fails. A file that *loses* a
 *     site also fails — with the new lower number to write down — so the ledger
 *     ratchets down and can never quietly hold a number that is no longer true.
 *
 * Scope is application code: `src/**` excluding `*.spec.ts`, `*.e2e-spec.ts`,
 * `__tests__/`, `__mocks__/` and `*spec-fixtures.ts`. The spec suite carries
 * 2,637 more `as unknown as` — the mock-construction idiom — and changing that
 * is a mocking-strategy decision, not a hygiene sweep.
 *
 * Flags:
 *   --self-test   Run the classifier against synthetic fixtures and exit.
 *   --list        Print the current per-file counts and exit 0. Use this to
 *                 produce the numbers a ledger update needs.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../", import.meta.url));

/** A scan that suddenly finds nothing is far likelier to be broken than the tree clean. */
const SCAN_FLOOR_FILES = 2000;

/**
 * Patterns that appear in CODE. These are counted with comments stripped, so a
 * comment discussing a cast is never mistaken for one.
 */
const BANNED_IN_CODE = {
  "as any": /(?<![\w$])as\s+any(?![\w$])/g,
};

/**
 * Patterns that appear in COMMENTS, because that is the only place TypeScript
 * reads them. These MUST be matched in the raw source.
 *
 * This split is a correction. All four escapes were previously counted with
 * `countOutsideComments`, which strips comments before matching — and a
 * suppression directive is only ever written inside a comment. So rule 1 was
 * structurally incapable of ever firing for the three directives: it reported
 * zero on a file whose first line is `// @ts-ignore`. The count was zero
 * because the check could not see, not because the tree was clean. Only
 * `as any`, which appears in code, was genuinely enforced.
 *
 * Anchoring to the start of the comment is what keeps prose honest.
 * TypeScript only honours a directive that begins the comment, so
 * `// @ts-ignore` is a real suppression while `// we ship zero @ts-ignore` is a
 * sentence, and only the first matches.
 */
const BANNED_DIRECTIVES = {
  "@ts-ignore": /(?:\/\/|\/\*)\s*@ts-ignore\b/g,
  "@ts-expect-error": /(?:\/\/|\/\*)\s*@ts-expect-error\b/g,
  "@ts-nocheck": /(?:\/\/|\/\*)\s*@ts-nocheck\b/g,
};

const DOUBLE_CAST = /\bas\s+unknown\s+as\b/g;

const SKIP_DIRS = new Set(["__tests__", "__mocks__", "node_modules", "dist", "coverage"]);
const SKIP_FILE = /(\.spec\.ts|\.e2e-spec\.ts|\.db\.spec\.ts|\.test\.ts|spec-fixtures\.ts|\.d\.ts)$/;

/**
 * file -> { count, seam, invariant }
 *
 * `seam` is one of:
 *   external   — the value genuinely arrives from outside the type system and
 *                nothing inside it can describe the shape. Legitimate.
 *   narrow-me  — the value is ours and the shape is knowable. The cast stands
 *                in for a Zod parse that has not been written. Debt.
 */
const DOUBLE_CAST_LEDGER = new Map([
  // -- external: a standalone script builds a Drizzle client or a stub service --
  ["src/scripts/benchmark-access-service.ts", { count: 4, seam: "external", invariant: "a benchmark harness stands up one real Db plus three hand-built stubs (cache, entitlements, MFA policy) to time AccessService in isolation. The stubs implement only the methods the measured path calls; the cast is what lets a four-method object stand where a full service is declared. It never runs in the application." }],
  ["src/scripts/check-set-null-column-lists.ts", { count: 4, seam: "external", invariant: "two casts hand the Drizzle schema barrel to a reflective walker as `Record<string, unknown>`; two more type the rows of a `sql.unsafe` catalog query, which postgres.js returns untyped by construction. Both are outside the type system by definition — a pg_catalog row has no compile-time shape." }],
  ["src/scripts/verify-cell-degraded-control-plane.ts", { count: 1, seam: "external", invariant: "`drizzle(client, { schema })` instantiates to a structurally identical but nominally different type than the app's `Db` alias. The script needs the app alias to call app services. No runtime narrowing is possible or useful." }],
  ["src/scripts/verify-cell-admission.ts", { count: 1, seam: "external", invariant: "same Drizzle instantiation seam as verify-cell-degraded-control-plane.ts." }],
  ["src/scripts/seed-permissions.ts", { count: 1, seam: "external", invariant: "same Drizzle instantiation seam; a seed script constructing its own client." }],
  ["src/test/sql-predicate.ts", { count: 2, seam: "external", invariant: "reads Drizzle's internal SQL AST node shape, which the library does not export. Test-support code for asserting that a predicate was built, not application code, and it breaks loudly on a Drizzle upgrade rather than silently." }],

  // -- external: a runtime shape the type system cannot see --
  ["src/db/query-telemetry.ts", { count: 3, seam: "external", invariant: "the instrumentation proxy wraps a Drizzle query builder that is thenable at runtime but not declared `PromiseLike`. The cast names the `.then` that is provably there — the proxy only reaches this branch after checking for it." }],
  ["src/common/observability/tracing.ts", { count: 1, seam: "external", invariant: "a `RegExpMatchArray` is typed as `string[]` but the W3C traceparent regex has four capture groups, so a successful match has exactly five elements. The cast names the arity the regex guarantees; the match is null-checked first." }],
  ["src/modules/platform/operator-session.guard.ts", { count: 1, seam: "external", invariant: "`req.route` is attached by Express at dispatch time and is absent from the Nest request type. Read optionally with a `?? req.url` fallback, so an absent route degrades to the raw URL rather than throwing." }],

  // -- narrow-me: ours, knowable, and owed a Zod parse --
  ["src/modules/party/party-merge.service.ts", { count: 2, seam: "narrow-me", invariant: "a merge snapshot written into a jsonb audit column. Drizzle types jsonb as `unknown`, so the cast is the write half of a round-trip whose read half is party-revert.service.ts. Owed a shared `mergeSnapshotSchema` parsed on read." }],
  ["src/modules/party/party-revert.service.ts", { count: 1, seam: "narrow-me", invariant: "the read half of the party-merge jsonb round-trip. This is the cast that matters: it trusts a stored shape without parsing it, so a snapshot written by an older release deserialises into a lie rather than an error." }],
  ["src/modules/ingress/inbound-ingress.service.ts", { count: 1, seam: "narrow-me", invariant: "an inbound communication event written to a jsonb payload column. Write half; owed the same schema as the workflow's read." }],
  ["src/modules/ingress/inbound-ingress.workflow.ts", { count: 1, seam: "narrow-me", invariant: "the read half of the inbound-event jsonb round-trip, and the one that should be a Zod parse — the row may have been written by a previous release." }],
  ["src/modules/crm/import/crm-import-preview.service.ts", { count: 1, seam: "narrow-me", invariant: "stored column mappings read back from a jsonb column. CRM is outside the PRD's dead-code scope but is still application code for this gate." }],
  ["src/modules/notifications/notification-retention.service.ts", { count: 1, seam: "narrow-me", invariant: "rows from a raw `db.execute` probe. CLAUDE.md §6 says raw rows are `Record<string, unknown>` and should be converted at the use site (`Number(row.count)`), not cast wholesale." }],
  ["src/modules/record-layouts/record-layouts.service.ts", { count: 1, seam: "narrow-me", invariant: "rows from a raw `db.execute` aggregate. Same §6 treatment as notification-retention.service.ts." }],
]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".ts") && !SKIP_FILE.test(entry.name)) yield full;
  }
}

/**
 * Counts occurrences outside line comments and block comments, so that a
 * comment *describing* a cast is never counted as one. This file's own header
 * would otherwise fail the gate it implements.
 */
export function countOutsideComments(source, pattern) {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
  return [...stripped.matchAll(pattern)].length;
}

function scan(root) {
  const banned = new Map();
  const doubleCasts = new Map();
  let files = 0;

  for (const file of walk(root)) {
    files += 1;
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(root, file).replace(/\\/g, "/");
    for (const [name, pattern] of Object.entries(BANNED_IN_CODE)) {
      const n = countOutsideComments(source, pattern);
      if (n) banned.set(`${rel} :: ${name}`, n);
    }
    for (const [name, pattern] of Object.entries(BANNED_DIRECTIVES)) {
      const n = [...source.matchAll(pattern)].length;
      if (n) banned.set(`${rel} :: ${name}`, n);
    }
    const casts = countOutsideComments(source, DOUBLE_CAST);
    if (casts) doubleCasts.set(`src/${rel}`, casts);
  }

  return { banned, doubleCasts, files };
}

export function diffLedger(actual, ledger) {
  const added = [];
  const grown = [];
  const shrunk = [];
  const gone = [];

  for (const [file, count] of actual) {
    const entry = ledger.get(file);
    if (!entry) added.push({ file, count });
    else if (count > entry.count) grown.push({ file, was: entry.count, now: count });
    else if (count < entry.count) shrunk.push({ file, was: entry.count, now: count });
  }
  for (const file of ledger.keys()) if (!actual.has(file)) gone.push(file);

  return { added, grown, shrunk, gone };
}

function assert(cond, msg) {
  if (!cond) {
    console.error("SELF-TEST FAIL:", msg);
    process.exit(1);
  }
}

function runSelfTest() {
  console.log("Running self-test...\n");

  assert(countOutsideComments("const a = b as unknown as C;\n", DOUBLE_CAST) === 1,
    "(a) a real double cast must be counted");
  assert(countOutsideComments("// explains an as unknown as cast\n", DOUBLE_CAST) === 0,
    "(b) a line comment describing a cast must NOT be counted — this gate's own header depends on it");
  assert(countOutsideComments("/**\n * an as unknown as cast\n */\n", DOUBLE_CAST) === 0,
    "(c) a block comment describing a cast must NOT be counted");
  assert(countOutsideComments("const url = 'https://x/y'; const a = b as unknown as C;\n", DOUBLE_CAST) === 1,
    "(d) a `//` inside a string must not blind the rest of the line");
  assert(countOutsideComments("const x = y as any;\n", BANNED_IN_CODE["as any"]) === 1,
    "(e) `as any` must be counted");
  assert(countOutsideComments("const x: Whereas anything = 1;\n", BANNED_IN_CODE["as any"]) === 0,
    "(f) `as any` must not match inside a longer identifier");

  // The regression these three guard is the one this gate shipped with: all four
  // escapes were counted with comments stripped, so the three DIRECTIVES could
  // never fire. (e1) pins the precondition, (e2) pins the fix, (e3) pins prose.
  const directiveHits = (src, name) => [...src.matchAll(BANNED_DIRECTIVES[name])].length;
  assert(countOutsideComments("// @ts-ignore\nconst x = 1;\n", /@ts-ignore/g) === 0,
    "(e1) precondition: a comment-stripping counter CANNOT see a directive — which is why directives are matched raw");
  assert(directiveHits("// @ts-ignore\nconst x = 1;\n", "@ts-ignore") === 1
    && directiveHits("//@ts-ignore\n", "@ts-ignore") === 1
    && directiveHits("/* @ts-expect-error */\n", "@ts-expect-error") === 1
    && directiveHits("// @ts-nocheck\n", "@ts-nocheck") === 1,
    "(e2) a real suppression directive MUST be caught, with or without a space, in a line or block comment");
  assert(directiveHits("// we ship zero @ts-ignore in application code\n", "@ts-ignore") === 0,
    "(e3) prose mentioning a directive is not a directive — TypeScript only honours one that begins the comment");

  const ledger = new Map([
    ["a.ts", { count: 2, seam: "external", invariant: "x" }],
    ["b.ts", { count: 1, seam: "external", invariant: "y" }],
    ["c.ts", { count: 1, seam: "external", invariant: "z" }],
  ]);
  const d = diffLedger(new Map([["a.ts", 3], ["b.ts", 1], ["d.ts", 1]]), ledger);
  assert(d.grown.length === 1 && d.grown[0].file === "a.ts",
    "(g) a file gaining a cast must be reported as growth");
  assert(d.added.length === 1 && d.added[0].file === "d.ts",
    "(h) a file not in the ledger must be reported as new");
  assert(d.gone.length === 1 && d.gone[0] === "c.ts",
    "(i) a ledgered file with no casts left must be reported so the entry is deleted");
  assert(diffLedger(new Map([["a.ts", 1]]), ledger).shrunk[0]?.now === 1,
    "(j) a file losing a cast must be reported with its new lower number");
  assert(diffLedger(new Map([["b.ts", 1]]), new Map([["b.ts", { count: 1 }]])).grown.length === 0,
    "(k) an unchanged file must not be reported");

  for (const [file, entry] of DOUBLE_CAST_LEDGER) {
    assert(entry.seam === "external" || entry.seam === "narrow-me",
      `(l) ${file}: seam must be "external" or "narrow-me", got "${entry.seam}"`);
    assert(typeof entry.invariant === "string" && entry.invariant.length > 40,
      `(m) ${file}: every entry needs a written invariant, not a placeholder`);
  }

  console.log("PASS: self-test (14 assertions + a written invariant on all "
    + `${DOUBLE_CAST_LEDGER.size} ledger entries)\n`);
  for (const line of [
    "  (a) a real double cast                        -> counted",
    "  (b) a line comment describing one             -> not counted",
    "  (c) a block comment describing one            -> not counted",
    "  (d) a `//` inside a string                    -> does not blind the line",
    "  (e) `as any`                                  -> counted",
    "  (f) `as any` inside a longer identifier       -> not counted",
    "  (e1) comment-stripping CANNOT see a directive -> why directives are matched raw",
    "  (e2) a real @ts-ignore/-expect-error/-nocheck -> caught (gate bites)",
    "  (e3) prose mentioning a directive             -> not a directive",
    "  (g) a file gaining a cast                     -> growth (gate bites)",
    "  (h) a file absent from the ledger             -> new (gate bites)",
    "  (i) a ledgered file with no casts left        -> stale (gate bites)",
    "  (j) a file losing a cast                      -> reported with the new number",
    "  (k) an unchanged file                         -> silent",
    "  (l) every ledger entry names a seam kind",
    "  (m) every ledger entry carries a written invariant",
  ]) console.log(line);
}

function main() {
  const { banned, doubleCasts, files } = scan(SRC);

  if (files < SCAN_FLOOR_FILES) {
    console.error(`FAIL: scanned only ${files} file(s), below the floor of ${SCAN_FLOOR_FILES}. The scan is broken, not the tree clean.`);
    process.exit(1);
  }

  const total = [...doubleCasts.values()].reduce((a, b) => a + b, 0);

  if (process.argv.includes("--list")) {
    for (const [file, count] of [...doubleCasts].sort()) console.log(`${count}\t${file}`);
    console.log(`\n${files} application files, ${doubleCasts.size} with a double cast, ${total} sites.`);
    return;
  }

  const external = [...DOUBLE_CAST_LEDGER.values()].filter((e) => e.seam === "external").reduce((a, e) => a + e.count, 0);
  const narrowMe = [...DOUBLE_CAST_LEDGER.values()].filter((e) => e.seam === "narrow-me").reduce((a, e) => a + e.count, 0);

  console.log(`=== application files scanned: ${files} ===`);
  console.log(`=== \`as unknown as\`: ${total} site(s) in ${doubleCasts.size} file(s) ===`);
  console.log(`=== ledger: ${external} at a proven external seam, ${narrowMe} owed a Zod parse ===`);

  let failed = false;

  if (banned.size) {
    console.error(`\nFAIL: ${banned.size} forced-typing escape(s) in application code — these have no ledger and no permitted count:`);
    for (const [where, n] of banned) console.error(`  ${where} x${n}`);
    failed = true;
  } else {
    console.log("=== as any / @ts-ignore / @ts-expect-error / @ts-nocheck: 0 ===");
  }

  const { added, grown, shrunk, gone } = diffLedger(doubleCasts, DOUBLE_CAST_LEDGER);

  if (added.length) {
    console.error(`\nFAIL: ${added.length} file(s) hold a double cast and are not in DOUBLE_CAST_LEDGER. Narrow with Zod, or add an entry naming the seam and the invariant:`);
    for (const { file, count } of added) console.error(`  ${file} (${count} site(s))`);
    failed = true;
  }
  if (grown.length) {
    console.error(`\nFAIL: ${grown.length} file(s) gained a double cast. The ledger does not grow:`);
    for (const { file, was, now } of grown) console.error(`  ${file}: ${was} -> ${now}`);
    failed = true;
  }
  if (shrunk.length || gone.length) {
    console.error(`\nFAIL: ${shrunk.length + gone.length} ledger entr(ies) are out of date — the ratchet only ratchets down, so write the new number:`);
    for (const { file, was, now } of shrunk) console.error(`  ${file}: ledger says ${was}, tree has ${now} — lower the entry`);
    for (const file of gone) console.error(`  ${file}: no casts left — delete the entry`);
    failed = true;
  }

  if (failed) process.exit(1);
  console.log("\nPASS: no forced-typing escape in application code, and every double cast is ledgered at its recorded count.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else main();
