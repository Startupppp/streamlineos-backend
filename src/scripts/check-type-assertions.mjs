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
import ts from "typescript";

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
  ["src/scripts/check-declaration-column-drift.ts", { count: 4, seam: "external", invariant: "the same two seams as check-set-null-column-lists.ts, in a second reflective gate: two casts hand the Drizzle schema barrel to a walker as `Record<string, unknown>`, and two type the rows of a `sql.unsafe` catalog query, which postgres.js returns untyped by construction. A pg_catalog row has no compile-time shape. ARRIVED UNTRACKED from another lane on 2026-09-03; if that lane drops the file this entry goes stale and the gate will say so, which is the intended behaviour." }],
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

/**
 * ---------------------------------------------------------------------------
 * Rule 3: the raw-SQL row generic, `db.execute<T>(sql`...`)`.
 * ---------------------------------------------------------------------------
 *
 * This is a type assertion that does not contain the word `as`, which is why
 * neither of the two rules above has ever seen one. Drizzle declares
 * `execute<T extends Record<string, unknown>>(): Promise<T[]>` and hands the
 * driver rows straight back: nothing validates that the columns the caller
 * named in `T` are the columns the query selected. Shared CLAUDE.md section 6
 * says exactly this — raw rows are `Record<string, unknown>` and are converted
 * at the use site — so a `<T>` here is the forced type the rule forbids,
 * written in a syntax the ban could not detect.
 *
 * It is the same defect shape that shipped twice in this release on the
 * frontend half of the same seam (`apiClient.get<Channel>`, `get<Huddle>`): the
 * projection did not select what the declared type promised, both repositories
 * typechecked clean, and the field arrived `undefined`.
 *
 * So this rule does two things, and the second is the one that bites:
 *
 *   (a) a per-file zero-growth ledger, same ratchet as rule 2; and
 *   (b) for every site where the type argument is a type literal AND the query
 *       is a `sql` template in the same call, a static cross-check that every
 *       property the type declares is actually selected by that SQL — and that
 *       a camelCase property is not relying on an UNQUOTED alias, which
 *       Postgres folds to lower case and which therefore arrives under a
 *       different key than the type says. 25 of the 28 sites are checkable
 *       this way; the 3 that are not compose their SQL or name a type alias,
 *       and are ledgered instead.
 */
const RAW_ROW_LEDGER = new Map([
  ["src/common/db/bulk-update.ts", { count: 1, seam: "external", invariant: "a `RETURNING` clause on a generated bulk UPDATE. The driver returns untyped rows; the single declared column `key` is cross-checked against the SQL by rule 3b, so a rename of the returned column fails this gate rather than silently yielding undefined keys." }],
  ["src/common/db/expand-contract-compat.ts", { count: 2, seam: "external", invariant: "`to_regclass(...) IS NOT NULL AS \"relationAvailable\"` — a pg_catalog probe. A catalog row has no compile-time shape. Both aliases are DOUBLE-QUOTED, which is what makes the camelCase key survive Postgres identifier folding; rule 3b asserts that quoting, so removing the quotes fails the gate." }],
  ["src/modules/ai/core/ops-copilot-tools.ts", { count: 2, seam: "external", invariant: "two aggregate probes behind AI copilot tools; all declared keys are snake_case columns selected verbatim, cross-checked by rule 3b." }],
  ["src/modules/ai/core/workspace-copilot-tools.ts", { count: 1, seam: "external", invariant: "a per-project rollup aggregate; snake_case keys selected verbatim, cross-checked by rule 3b." }],
  ["src/modules/hr/core/hr-effective-change-applier.service.ts", { count: 1, seam: "external", invariant: "a recursive CTE returning `creates_cycle`, the reporting-line cycle guard. Cross-checked by rule 3b." }],
  ["src/modules/hr/directory/employee-mutations.service.ts", { count: 1, seam: "external", invariant: "the same reporting-line cycle guard on the directory mutation path. Cross-checked by rule 3b." }],
  ["src/modules/hr/interviews/hr-interviews.service.ts", { count: 2, seam: "external", invariant: "a paginated interview list with a window `total_count`, and an id probe. All keys snake_case and selected verbatim; cross-checked by rule 3b." }],
  ["src/modules/inventory/counts/inv-cycle-counts.service.ts", { count: 1, seam: "external", invariant: "a stock-level snapshot for a cycle count: SELECT sl.product_variant_id, sl.location_id, sl.lot_id, sl.on_hand FROM inv_stock_levels. Every declared key is a snake_case column selected verbatim, so rule 3b proves the projection supports the type. Inventory is outside the release SCOPE but is still application code for this gate." }],
  ["src/modules/inventory/counts/inv-physical-audits.service.ts", { count: 1, seam: "external", invariant: "the same four-column inv_stock_levels snapshot as inv-cycle-counts.service.ts, taken for a physical audit instead of a cycle count. Snake_case columns selected verbatim; cross-checked by rule 3b." }],
  ["src/modules/inventory/purchase-orders/grn-receive.service.ts", { count: 1, seam: "external", invariant: "SELECT quantity, quantity_received FROM inv_po_lines ... FOR UPDATE — the row lock that makes goods receipt idempotent. Both declared keys are selected verbatim; cross-checked by rule 3b." }],
  ["src/modules/inventory/stock-engine/costing-context.ts", { count: 1, seam: "external", invariant: "SELECT DISTINCT ON (product_variant_id) product_variant_id, unit_cost FROM inv_standard_costs — a DISTINCT ON that Drizzle\u2019s query builder cannot express. Both declared keys are selected verbatim; cross-checked by rule 3b." }],
  ["src/modules/inventory/stock-engine/reservation.service.ts", { count: 4, seam: "external", invariant: "four `SELECT ... FOR UPDATE` row locks in the reservation ledger. Snake_case keys, cross-checked by rule 3b." }],
  ["src/modules/inventory/stock-engine/stock-engine-batch.service.ts", { count: 1, seam: "external", invariant: "the type argument is the named alias `LockedRow`, so rule 3b cannot read its members and this site is ledgered rather than cross-checked. The query is a `SELECT ... FOR UPDATE` over inv_stock_levels." }],
  ["src/modules/inventory/stock-engine/stock-engine.service.ts", { count: 1, seam: "external", invariant: "the inv_stock_levels row lock at the heart of the stock engine (id, on_hand, committed, blocked_qty, quality_hold_qty, average_cost). Numeric columns are declared `string` because the driver returns numerics as strings, which is the honest shape. Cross-checked by rule 3b." }],
  ["src/modules/inventory/stock-engine/valuation.service.ts", { count: 2, seam: "external", invariant: "two FIFO layer reads over inv_valuation_layers (id, remaining_quantity, quantity / unit_cost), both needing FOR UPDATE ordering the query builder cannot express. All keys selected verbatim; cross-checked by rule 3b." }],
  ["src/modules/inventory/stock/inv-stock-transfers.service.ts", { count: 1, seam: "external", invariant: "SELECT id, status, from_location_id, org_id FROM inv_stock_transfers ... FOR UPDATE — the transfer row lock, and it re-reads org_id so the tenant is confirmed under the lock rather than before it. Cross-checked by rule 3b." }],
  ["src/modules/build/core/projects-tickets-update.service.ts", { count: 1, seam: "external", invariant: "a `WITH RECURSIVE chain(id, next_id, project_id, depth)` walk that detects a cycle in the ticket next/previous chain before a reorder commits. A recursive CTE is not expressible in the Drizzle query builder. All four declared keys are the CTE column list itself and are selected verbatim; cross-checked by rule 3b." }],
  ["src/modules/organization/hierarchy/org-hierarchy-dependencies.service.ts", { count: 2, seam: "external", invariant: "one catalog probe (cross-checked), and one whose SQL is composed with `sql.join(this.buildQueries(...))` and whose type is the named alias `DependencyCountRow` — neither the keys nor the SQL is statically readable at the call, so it is ledgered. Its consumer reads `row.key` and `row.count` and coerces the count with Number()." }],
  ["src/scripts/backfill-financial-actors.ts", { count: 1, seam: "external", invariant: "a one-shot backfill script; snake_case keys selected verbatim, cross-checked by rule 3b." }],
  ["src/scripts/backfill-workflow-secrets.ts", { count: 1, seam: "external", invariant: "the type argument is the named alias `PlaintextRow`, so rule 3b cannot read its members. A one-shot backfill script that never runs in the application." }],
]);

/**
 * Reads `<something>.execute<T>(...)` call sites out of one file. Regex is not
 * usable here: a type argument spans lines, nests braces and contains commas,
 * and the SQL template it must be compared against is a second argument. This
 * is the one place in this gate where an AST is required rather than tidier.
 */
export function findRawRowGenerics(fileName, source) {
  if (!source.includes("execute<")) return [];
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.typeArguments?.length === 1 &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.getText(sf) === "execute"
    ) {
      const typeArg = node.typeArguments[0];
      const keys = ts.isTypeLiteralNode(typeArg)
        ? typeArg.members.filter(ts.isPropertySignature).map((m) => m.name.getText(sf).replace(/["']/g, ""))
        : null;
      const arg = node.arguments[0];
      let sqlText = null;
      if (arg && ts.isTaggedTemplateExpression(arg) && arg.tag.getText(sf) === "sql") {
        const t = arg.template;
        sqlText = ts.isNoSubstitutionTemplateLiteral(t)
          ? t.text
          : [t.head.text, ...t.templateSpans.map((s) => s.literal.text)].join(" ? ");
      }
      found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, keys, sqlText });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/**
 * Rule 3b. Returns the reasons this site's declared row type is not supported
 * by the SQL beside it. Empty array = the projection matches the declaration.
 *
 * Two failure modes, and the second is the quiet one:
 *   MISSING  — the type names a column the query does not select at all.
 *   CASEFOLD — the type names a camelCase column and the SQL aliases it
 *              UNQUOTED. Postgres folds an unquoted identifier to lower case,
 *              so the row arrives with `relationavailable` while the type
 *              promises `relationAvailable`, and every read of it is undefined.
 */
export function checkRawRowProjection(site) {
  if (!site.keys || !site.sqlText) return [];
  const reasons = [];
  for (const key of site.keys) {
    const quoted = new RegExp(`"${key}"`).test(site.sqlText);
    const bare = new RegExp(`(^|[\\s,.(])${key}(\\s|,|$|\\))`, "i").test(site.sqlText);
    if (!quoted && !bare) reasons.push(`MISSING: the type declares "${key}" but the SQL selects no such column`);
    else if (!quoted && /[A-Z]/.test(key))
      reasons.push(`CASEFOLD: "${key}" is camelCase and the SQL alias is unquoted — Postgres returns "${key.toLowerCase()}", so every read of "${key}" is undefined`);
  }
  return reasons;
}

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
  const rawRows = new Map();
  const projectionFailures = [];
  let checkedProjections = 0;
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

    const sites = findRawRowGenerics(file, source);
    if (sites.length) rawRows.set(`src/${rel}`, sites.length);
    for (const site of sites) {
      if (!site.keys || !site.sqlText) continue;
      checkedProjections += 1;
      for (const reason of checkRawRowProjection(site))
        projectionFailures.push(`src/${rel}:${site.line} ${reason}`);
    }
  }

  return { banned, doubleCasts, rawRows, projectionFailures, checkedProjections, files };
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

  // ---- rule 3: the raw-SQL row generic ----------------------------------
  const one = (src) => findRawRowGenerics("probe.ts", src);

  assert(one("const r = await db.execute<{ a: number }>(sql`select 1 as a`);").length === 1,
    "(n) a `db.execute<T>` call must be found");
  assert(one("const r = await tx.execute<{ a: number }>(sql`select 1 as a`);").length === 1,
    "(n1) the receiver may be a transaction, not only `db`");
  assert(one("const r = await db.execute(sql`select 1 as a`);").length === 0,
    "(o) an `execute` with NO type argument is not a forced type and must not be counted");
  assert(one("// db.execute<{ a: number }>(sql`x`)\n").length === 0,
    "(p) a commented-out call is not a call — the AST does not see comments, which is why rule 3 uses one");
  assert(one("const r = await db.execute<{\n  a: number;\n  b: string;\n}>(sql`select 1 as a, 'x' as b`)")[0].keys.join(",") === "a,b",
    "(q) a multi-line type literal must yield both keys — the reason this rule cannot be a regex");
  assert(one("const r = await db.execute<LockedRow>(sql`select 1`)")[0].keys === null,
    "(r) a NAMED type argument is not statically readable and must report keys=null so it is ledgered, not silently passed");
  assert(one("const r = await db.execute<{ a: number }>(sql.join(parts))")[0].sqlText === null,
    "(s) COMPOSED sql is not statically readable and must report sqlText=null, not an empty string that would match nothing");

  const proj = (src) => checkRawRowProjection(one(src)[0]);
  assert(proj("const r = await db.execute<{ a: number }>(sql`select 1 as a`)").length === 0,
    "(t) a declared key the SQL selects is clean");
  assert(proj("const r = await db.execute<{ missing: number }>(sql`select 1 as a`)")
    .some((m) => m.startsWith("MISSING")),
    "(u) a declared key the SQL does NOT select must FAIL — this is the gate biting on the huddle/channel defect shape in raw SQL");
  assert(proj('const r = await db.execute<{ relationAvailable: boolean }>(sql`select x AS "relationAvailable"`)').length === 0,
    "(v) a camelCase key with a DOUBLE-QUOTED alias survives Postgres folding and is clean");
  assert(proj("const r = await db.execute<{ relationAvailable: boolean }>(sql`select x AS relationAvailable`)")
    .some((m) => m.startsWith("CASEFOLD")),
    "(w) the SAME key with an UNQUOTED alias must FAIL — Postgres returns `relationavailable`, so every read is undefined while the type says otherwise");
  assert(proj("const r = await db.execute<LockedRow>(sql`select 1`)").length === 0,
    "(x) an unreadable site reports no violation rather than a false one — it is covered by the ledger instead");

  for (const [file, entry] of RAW_ROW_LEDGER) {
    assert(entry.seam === "external" || entry.seam === "narrow-me",
      `(y) ${file}: raw-row seam must be "external" or "narrow-me", got "${entry.seam}"`);
    assert(typeof entry.invariant === "string" && entry.invariant.length > 40,
      `(z) ${file}: every raw-row entry needs a written invariant, not a placeholder`);
  }

  console.log("PASS: self-test (27 assertions + a written invariant on all "
    + `${DOUBLE_CAST_LEDGER.size + RAW_ROW_LEDGER.size} ledger entries)\n`);
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
    "  (n) a `db.execute<T>` call                     -> found",
    "  (n1) `tx.execute<T>` too                       -> found",
    "  (o) `execute` with no type argument            -> not counted",
    "  (p) a commented-out call                       -> not counted",
    "  (q) a multi-line type literal                  -> all keys read (why this rule is an AST)",
    "  (r) a NAMED type argument                      -> keys=null, ledgered not passed",
    "  (s) COMPOSED sql                               -> sqlText=null, ledgered not passed",
    "  (t) a declared key the SQL selects             -> clean",
    "  (u) a declared key the SQL does NOT select     -> MISSING (gate bites)",
    "  (v) camelCase key, DOUBLE-QUOTED alias         -> clean",
    "  (w) camelCase key, UNQUOTED alias              -> CASEFOLD (gate bites)",
    "  (x) an unreadable site                         -> no false violation",
    "  (y) every raw-row entry names a seam kind",
    "  (z) every raw-row entry carries a written invariant",
  ]) console.log(line);
}

function main() {
  const { banned, doubleCasts, rawRows, projectionFailures, checkedProjections, files } = scan(SRC);

  if (files < SCAN_FLOOR_FILES) {
    console.error(`FAIL: scanned only ${files} file(s), below the floor of ${SCAN_FLOOR_FILES}. The scan is broken, not the tree clean.`);
    process.exit(1);
  }

  const total = [...doubleCasts.values()].reduce((a, b) => a + b, 0);

  const rawRowTotal = [...rawRows.values()].reduce((a, b) => a + b, 0);

  if (process.argv.includes("--list")) {
    for (const [file, count] of [...doubleCasts].sort()) console.log(`${count}\t${file}`);
    console.log(`\n${files} application files, ${doubleCasts.size} with a double cast, ${total} sites.`);
    console.log("\n--- rule 3: db.execute<T> raw-row generics ---");
    for (const [file, count] of [...rawRows].sort()) console.log(`${count}\t${file}`);
    console.log(`\n${rawRows.size} file(s), ${rawRowTotal} site(s), ${checkedProjections} cross-checkable against their SQL.`);
    return;
  }

  const external = [...DOUBLE_CAST_LEDGER.values()].filter((e) => e.seam === "external").reduce((a, e) => a + e.count, 0);
  const narrowMe = [...DOUBLE_CAST_LEDGER.values()].filter((e) => e.seam === "narrow-me").reduce((a, e) => a + e.count, 0);

  console.log(`=== application files scanned: ${files} ===`);
  console.log(`=== \`as unknown as\`: ${total} site(s) in ${doubleCasts.size} file(s) ===`);
  console.log(`=== ledger: ${external} at a proven external seam, ${narrowMe} owed a Zod parse ===`);
  console.log(`=== \`db.execute<T>\` raw-row generics: ${rawRowTotal} site(s) in ${rawRows.size} file(s), ${checkedProjections} cross-checked against their SQL ===`);

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

  const raw = diffLedger(rawRows, RAW_ROW_LEDGER);
  if (raw.added.length) {
    console.error(`\nFAIL: ${raw.added.length} file(s) carry a \`db.execute<T>\` raw-row generic and are not in RAW_ROW_LEDGER. Convert at the use site per CLAUDE.md section 6, or add an entry naming the seam and the invariant:`);
    for (const { file, count } of raw.added) console.error(`  ${file} (${count} site(s))`);
    failed = true;
  }
  if (raw.grown.length) {
    console.error(`\nFAIL: ${raw.grown.length} file(s) gained a \`db.execute<T>\` raw-row generic. The ledger does not grow:`);
    for (const { file, was, now } of raw.grown) console.error(`  ${file}: ${was} -> ${now}`);
    failed = true;
  }
  if (raw.shrunk.length || raw.gone.length) {
    console.error(`\nFAIL: ${raw.shrunk.length + raw.gone.length} raw-row ledger entr(ies) are out of date — write the new number:`);
    for (const { file, was, now } of raw.shrunk) console.error(`  ${file}: ledger says ${was}, tree has ${now} — lower the entry`);
    for (const file of raw.gone) console.error(`  ${file}: no raw-row generic left — delete the entry`);
    failed = true;
  }

  if (projectionFailures.length) {
    console.error(`\nFAIL: ${projectionFailures.length} \`db.execute<T>\` site(s) declare a row shape the query beside them does not produce. This is the defect that shipped twice on the frontend half of this seam — the read compiles, and the field arrives undefined:`);
    for (const reason of projectionFailures) console.error(`  ${reason}`);
    failed = true;
  } else {
    console.log(`=== every one of the ${checkedProjections} cross-checkable raw-row types is supported by its SQL ===`);
  }

  if (failed) process.exit(1);
  console.log("\nPASS: no forced-typing escape in application code, every double cast is ledgered at its recorded count, and every statically readable `db.execute<T>` row type matches the projection beside it.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else main();
